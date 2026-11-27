import type { IPlanService } from "@brr/client";
import { importedSha256 } from "@brr/schema/world";
import type { EditorPath } from "../held-out/editor-pairs.ts";
import type { ShowModule } from "../held-out/generator.ts";
import {
  inRun,
  type Cell,
  type CellRun,
  type Point,
  type Rect,
  type RowPlan,
  type ShowLayout,
  type TrackKit,
} from "./show-layout.ts";
import type { TrackLayer } from "./track-layer.ts";

export interface ShowItems {
  readonly baseplate: string;
  readonly roadKit: string;
  readonly track: string;
}

export interface PhaseTime {
  readonly phase: string;
  readonly seconds: number;
}

export interface ShowCounts {
  readonly tables: number;
  readonly placements: number;
  readonly baseplates: number;
  readonly roadPlates: number;
  readonly models: number;
  readonly modelParts: number;
  readonly trackPieces: number;
  readonly switches: number;
  readonly openTrackEnds: number;
  readonly unsupportedTrack: number;
  readonly parts: number;
  readonly authors: number;
}

export interface EditScript {
  readonly module: { readonly item: string; readonly at: Point };
  readonly track: {
    readonly item: string;
    readonly from: Point;
    readonly to: Point;
    readonly extensions: number;
  };
}

export interface ShowWorld {
  readonly edits: EditScript;
  readonly counts: ShowCounts;
  readonly refusedModelCells: number;
  readonly unplacedModels: number;
  readonly phases: ReadonlyArray<PhaseTime>;
  readonly world: Uint8Array;
  readonly plan: Uint8Array;
}

const MS_PER_SECOND = 1000;
const CORNER_INSET_LDU = 1;
const TRACK_EDIT_EXTENSIONS = 3;

function centre(rect: Rect): Point {
  return { x: (rect.minX + rect.maxX) / 2, z: (rect.minZ + rect.maxZ) / 2 };
}

export class ShowWorldBuilder {
  private readonly phases: PhaseTime[] = [];
  private readonly modelCells: Cell[] = [];
  private refusedModelCells = 0;
  private unplacedModels = 0;

  constructor(
    private readonly path: EditorPath,
    private readonly layout: ShowLayout,
    private readonly track: TrackLayer,
    private readonly kit: TrackKit,
    private readonly items: ShowItems,
    private readonly plans: Pick<IPlanService, "activePlanId" | "plans">,
  ) {}

  async build(models: ReadonlyArray<ShowModule>): Promise<ShowWorld> {
    const { editor } = this.path;
    const rows = this.layout.rows();
    await this.phase("tables", async () => this.drawTables());
    await this.phase("baseplates under the track", async () => {
      await this.path.hold(this.items.baseplate);
      for (const row of rows) for (const run of row.support) await this.fill(run);
    });
    await this.phase("track", async () => {
      for (const row of rows) await this.track.lay(row.oval, this.kit);
    });
    await this.phase("roads", async () => {
      for (const row of rows) if (row.road) await this.road(row.road);
    });
    const items: string[] = [];
    await this.phase("model imports", async () => {
      for (const model of models) items.push(await this.path.importModel(model));
    });
    await this.phase("models", async () => {
      this.path.setMode("precise");
      let next = 0;
      for (const row of rows) {
        await this.placeModels(items.slice(next, next + row.models), row.modelCandidates);
        next += row.models;
      }
    });
    await this.phase("baseplates everywhere else", async () => {
      await this.path.hold(this.items.baseplate);
      for (const row of rows)
        for (const run of this.layout.runsOf(this.emptyCells(row))) await this.fill(run);
    });
    editor.chooseItem(null);
    await this.path.waitFor(() => editor.snapshot().studChecks === 0, "every model's stud check");
    const planId = this.plans.activePlanId();
    const plan = planId === null ? null : await editor.exportPlan(planId);
    if (!plan) throw new Error("the show world's tables formed no plan to export");
    return {
      edits: this.editScript(rows, items),
      counts: this.counts(models),
      refusedModelCells: this.refusedModelCells,
      unplacedModels: this.unplacedModels,
      phases: this.phases,
      world: (await editor.exportWorld()).bytes,
      plan: plan.bytes,
    };
  }

  private async phase(phase: string, work: () => Promise<void>): Promise<void> {
    const started = performance.now();
    await work();
    const seconds = (performance.now() - started) / MS_PER_SECOND;
    this.phases.push({ phase, seconds });
    process.stdout.write(`show world: ${phase} in ${seconds.toFixed(1)} s\n`);
  }

  private drawTables(): void {
    const { editor } = this.path;
    editor.chooseItem(null);
    editor.setTableTool(true);
    for (const table of this.layout.tables()) {
      this.path.drag(table.maxX, table.minZ, table.minX, table.maxZ);
    }
    editor.setTableTool(false);
  }

  private async fill(run: CellRun): Promise<void> {
    const { editor } = this.path;
    const rect = this.layout.runRect(run);
    const before = editor.snapshot().lastFill;
    this.path.drag(
      rect.minX,
      rect.minZ,
      rect.maxX - CORNER_INSET_LDU,
      rect.maxZ - CORNER_INSET_LDU,
    );
    await this.path.waitFor(
      () => {
        const fill = editor.snapshot().lastFill;
        return (
          fill !== before && fill !== null && fill.placed + fill.refused + fill.alreadyThere > 0
        );
      },
      `the fill over table row ${run.row + 1}, band ${run.band + 1}`,
    );
  }

  private async road(run: CellRun): Promise<void> {
    const { editor } = this.path;
    await this.path.hold(this.items.roadKit);
    const rect = this.layout.runRect(run);
    const half = this.layout.cellLdu / 2;
    const before = editor.snapshot().placements;
    this.path.drag(rect.minX + half, rect.minZ + half, rect.maxX - half, rect.minZ + half);
    const laid = editor.snapshot().placements - before;
    if (laid !== run.columns) {
      throw new Error(
        `the road stroke along table row ${run.row + 1} laid ${laid} plates, not ${run.columns}: ${editor.snapshot().lastRefusal?.reason ?? "no refusal"}`,
      );
    }
  }

  private async placeModels(
    items: ReadonlyArray<string>,
    candidates: ReadonlyArray<Cell>,
  ): Promise<void> {
    let cell = 0;
    for (const item of items) {
      await this.path.hold(item);
      const shift = this.path.frameShift(item);
      let placed = false;
      while (!placed && cell < candidates.length) {
        const target = candidates[cell++];
        if (!target) break;
        const middle = centre(this.layout.cellRect(target));
        placed =
          (await this.path.step(middle.x - shift[0], middle.z - shift[2], true)).committed !== null;
        if (placed) this.modelCells.push(target);
        else this.refusedModelCells++;
      }
      if (!placed) this.unplacedModels++;
    }
  }

  private emptyCells(row: RowPlan): ReadonlyArray<Cell> {
    const taken = [...row.support, row.road, row.edits?.freePair ?? null];
    return this.layout
      .cellsOf(row.row)
      .filter(
        (cell) =>
          !taken.some((run) => run !== null && inRun(run, cell)) &&
          !this.modelCells.some(
            (placed) =>
              placed.row === cell.row && placed.band === cell.band && placed.column === cell.column,
          ),
      );
  }

  private editScript(rows: ReadonlyArray<RowPlan>, items: ReadonlyArray<string>): EditScript {
    const sites = rows.find((row) => row.edits !== null)?.edits;
    const item = items[0];
    if (!sites || item === undefined) throw new Error("the layout reserved no edit sites");
    const shift = this.path.frameShift(item);
    const pair = this.layout.runRect(sites.freePair);
    const first = centre({ ...pair, maxX: pair.minX + this.layout.cellLdu });
    const strip = this.layout.runRect(sites.trackRun);
    const half = this.layout.cellLdu / 2;
    return {
      module: { item, at: { x: first.x - shift[0], z: first.z - shift[2] } },
      track: {
        item: this.items.track,
        from: { x: strip.minX + half / 2, z: strip.minZ + half },
        to: { x: strip.minX + half + half / 2, z: strip.minZ + half },
        extensions: TRACK_EDIT_EXTENSIONS,
      },
    };
  }

  private counts(models: ReadonlyArray<ShowModule>): ShowCounts {
    const snapshot = this.path.editor.snapshot();
    const catalog = new Map(snapshot.catalog.map((item) => [item.id, item]));
    const { refs, placements } = this.path.editor.dump();
    let baseplates = 0;
    let roadPlates = 0;
    let placedModels = 0;
    let modelParts = 0;
    let parts = snapshot.track?.pieces ?? 0;
    for (const refId of placements.refId) {
      const ref = refs[refId] ?? "";
      const item = catalog.get(ref);
      parts += item?.parts ?? 0;
      if (ref === this.items.baseplate) baseplates++;
      else if (item?.kind === "road-plate") roadPlates++;
      else if (item && importedSha256(ref) !== null) {
        placedModels++;
        modelParts += item.parts;
      }
    }
    return {
      tables: this.plans.plans().reduce((sum, plan) => sum + plan.footprint.tables.length, 0),
      placements: snapshot.placements,
      baseplates,
      roadPlates,
      models: placedModels,
      modelParts,
      trackPieces: snapshot.track?.pieces ?? 0,
      switches: snapshot.track?.switches.length ?? 0,
      openTrackEnds: snapshot.track?.openEnds ?? 0,
      unsupportedTrack: snapshot.track?.unsupported ?? 0,
      parts,
      authors: new Set(models.map((model) => model.author)).size,
    };
  }
}

import type { IPlanService } from "@brr/client";
import { importedSha256 } from "@brr/schema/world";
import type { AimedEditor, Point } from "./aimed-editor.ts";
import {
  inRun,
  type Cell,
  type CellRun,
  type Rect,
  type RowPlan,
  type ShowLayout,
  type TrackKit,
} from "./show-layout.ts";
import type { OvalReport, TrackLayer } from "./track-layer.ts";

export interface ShowItems {
  readonly baseplate: string;
  readonly roadKit: string;
  readonly track: string;
}

export interface ShowModelFile {
  readonly name: string;
  readonly text: string;
  readonly author: string;
  readonly parts: number;
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
  readonly module: {
    readonly item: string;
    readonly at: Point;
  };
  readonly track: {
    readonly item: string;
    readonly from: Point;
    readonly to: Point;
    readonly extensions: number;
  };
}

export interface ShowWorld {
  readonly kit: TrackKit;
  readonly edits: EditScript;
  readonly counts: ShowCounts;
  readonly ovals: ReadonlyArray<OvalReport>;
  readonly refusedModelCells: number;
  readonly unplacedModels: number;
  readonly phases: ReadonlyArray<PhaseTime>;
  readonly world: Uint8Array;
  readonly worldFile: string;
  readonly plan: Uint8Array;
  readonly planFile: string;
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
    private readonly hand: AimedEditor,
    private readonly layout: ShowLayout,
    private readonly track: TrackLayer,
    private readonly kit: TrackKit,
    private readonly items: ShowItems,
    private readonly plans: Pick<IPlanService, "activePlanId">,
  ) {}

  async build(models: ReadonlyArray<ShowModelFile>): Promise<ShowWorld> {
    const rows = this.layout.rows();
    await this.phase("tables", () => this.drawTables());
    await this.phase("baseplates under the track", async () => {
      await this.hand.hold(this.items.baseplate);
      for (const row of rows)
        for (const run of row.support) await this.fill(this.layout.runRect(run));
    });
    const ovals: OvalReport[] = [];
    await this.phase("track", async () => {
      for (const row of rows) ovals.push(await this.track.lay(row.oval, this.kit));
    });
    await this.phase("roads", async () => {
      for (const row of rows) if (row.road) await this.road(row.road);
    });
    const items = await this.phase("model imports", () => this.importModels(models));
    await this.phase("models", async () => {
      let next = 0;
      for (const row of rows) {
        const quota = items.slice(next, next + row.models);
        next += quota.length;
        await this.placeModels(quota, row.modelCandidates);
      }
    });
    await this.phase("baseplates everywhere else", async () => {
      await this.hand.hold(this.items.baseplate);
      for (const row of rows) {
        for (const run of this.layout.runsOf(this.emptyCells(row))) {
          await this.fill(this.layout.runRect(run));
        }
      }
      await this.hand.hold(null);
    });
    await this.hand.settled();
    const counts = this.counts(models);
    const edits = this.editScript(rows, items);
    const world = await this.hand.editor.exportWorld();
    const planId = this.plans.activePlanId();
    const plan = planId === null ? null : await this.hand.editor.exportPlan(planId);
    if (!plan) throw new Error("the show world's tables formed no plan to export");
    return {
      kit: this.kit,
      edits,
      counts,
      ovals,
      refusedModelCells: this.refusedModelCells,
      unplacedModels: this.unplacedModels,
      phases: this.phases,
      world: world.bytes,
      worldFile: world.fileName,
      plan: plan.bytes,
      planFile: plan.fileName,
    };
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
    const shift = this.shiftOf(this.frameShifts(), item);
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

  private async phase<T>(phase: string, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    const result = await work();
    await this.hand.settled();
    const seconds = (performance.now() - started) / MS_PER_SECOND;
    this.phases.push({ phase, seconds });
    process.stdout.write(`show world: ${phase} in ${seconds.toFixed(1)} s\n`);
    return result;
  }

  private async drawTables(): Promise<void> {
    const { editor } = this.hand;
    await this.hand.hold(null);
    editor.setTableTool(true);
    for (const table of this.layout.tables()) {
      this.hand.drag({ x: table.maxX, z: table.minZ }, { x: table.minX, z: table.maxZ });
    }
    editor.setTableTool(false);
    const planId = this.plans.activePlanId();
    if (planId === null) throw new Error("drawing the tables made no plan");
  }

  private async fill(rect: Rect): Promise<void> {
    const before = this.hand.snapshot().lastFill;
    this.hand.drag(
      { x: rect.minX, z: rect.minZ },
      { x: rect.maxX - CORNER_INSET_LDU, z: rect.maxZ - CORNER_INSET_LDU },
    );
    await this.hand.until(() => {
      const fill = this.hand.snapshot().lastFill;
      return fill !== before && fill !== null && fill.placed + fill.refused + fill.alreadyThere > 0;
    }, `the fill over (${rect.minX}, ${rect.minZ})–(${rect.maxX}, ${rect.maxZ}) to settle`);
  }

  private async road(run: CellRun): Promise<void> {
    await this.hand.hold(this.items.roadKit);
    const rect = this.layout.runRect(run);
    const half = this.layout.cellLdu / 2;
    const before = this.hand.snapshot().placements;
    this.hand.drag(
      { x: rect.minX + half, z: rect.minZ + half },
      { x: rect.maxX - half, z: rect.minZ + half },
    );
    await this.hand.settled();
    const laid = this.hand.snapshot().placements - before;
    if (laid !== run.columns) {
      throw new Error(
        `the road stroke along table row ${run.row + 1} laid ${laid} plates, not ${run.columns}: ${this.hand.snapshot().lastRefusal?.reason ?? "no refusal"}`,
      );
    }
  }

  private async importModels(models: ReadonlyArray<ShowModelFile>): Promise<ReadonlyArray<string>> {
    const items: string[] = [];
    const encoder = new TextEncoder();
    for (const model of models) {
      const imported = await this.hand.editor.importModelFile({
        name: model.name,
        bytes: encoder.encode(model.text),
      });
      const item = this.hand.snapshot().activeItem;
      if (!imported || item === null) {
        throw new Error(
          `${model.name} didn't become placeable: ${this.hand.snapshot().modelImport?.reason ?? "no reason given"}`,
        );
      }
      items.push(item);
    }
    await this.hand.hold(null);
    return items;
  }

  private frameShifts(): ReadonlyMap<string, readonly [number, number, number]> {
    const dump = this.hand.editor.dump();
    const shifts = new Map<string, readonly [number, number, number]>();
    dump.covers.forEach((cover, index) => {
      const shift = dump.frameShifts[index];
      if (shift) shifts.set(cover.id, shift);
    });
    return shifts;
  }

  private shiftOf(
    shifts: ReadonlyMap<string, readonly [number, number, number]>,
    item: string,
  ): readonly [number, number, number] {
    for (const [id, shift] of shifts) if (item === id || item.startsWith(`${id}@`)) return shift;
    throw new Error(`${item} has no loaded placeable`);
  }

  private async placeModels(
    items: ReadonlyArray<string>,
    candidates: ReadonlyArray<Cell>,
  ): Promise<void> {
    const { editor } = this.hand;
    let cell = 0;
    for (const item of items) {
      await this.hand.hold(item);
      this.hand.setPlacementMode("precise");
      const shift = this.shiftOf(this.frameShifts(), item);
      let placed = false;
      while (!placed && cell < candidates.length) {
        const target = candidates[cell++];
        if (!target) break;
        const middle = centre(this.layout.cellRect(target));
        const before = editor.snapshot().placements;
        this.hand.hover({ x: middle.x - shift[0], z: middle.z - shift[2] });
        await this.hand.settled();
        editor.click(0, 0, performance.now());
        await this.hand.settled();
        placed = editor.snapshot().placements === before + 1;
        if (placed) this.modelCells.push(target);
        else this.refusedModelCells++;
      }
      if (!placed) this.unplacedModels++;
    }
    await this.hand.hold(null);
  }

  private counts(models: ReadonlyArray<ShowModelFile>): ShowCounts {
    const snapshot = this.hand.snapshot();
    const kinds = new Map(snapshot.catalog.map((item) => [item.id, item]));
    const { refs, placements } = this.hand.editor.dump();
    let baseplates = 0;
    let roadPlates = 0;
    let placedModels = 0;
    let modelParts = 0;
    let parts = snapshot.track?.pieces ?? 0;
    for (const refId of placements.refId) {
      const ref = refs[refId] ?? "";
      const item = kinds.get(ref);
      parts += item?.parts ?? 0;
      if (ref === this.items.baseplate) baseplates++;
      else if (item?.kind === "road-plate") roadPlates++;
      else if (item && importedSha256(ref) !== null) {
        placedModels++;
        modelParts += item.parts;
      }
    }
    return {
      tables: this.layout.tables().length,
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

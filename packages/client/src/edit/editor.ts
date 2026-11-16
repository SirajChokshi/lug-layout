import {
  PART_BUNDLE_LOADER,
  type BundleLod,
  type IPartBundleLoader,
  type PartBundle,
} from "@brr/catalog";
import { MergedParts } from "./merged-parts.ts";
import {
  EditHistory,
  World,
  roomRect,
  type AppliedEdit,
  type EditKind,
  type HistoryStep,
} from "@brr/domain";
import { STUD_LDU, chunkOf, isRot90, type Rot90 } from "@brr/math";
import {
  CAMERA_FOV_DEGREES,
  RAY_FLOATS,
  SCENE_BACKEND,
  type BackendInfo,
  type FrameStats,
  type GraphicsApi,
  type ISceneBackend,
  type WorldBox,
} from "@brr/render";
import { inject, injectable } from "inversify";
import { dumpPlacements, type PlacementDump } from "../scene/placements.ts";
import { ColorTable, ldrawColorsSrgb, type ModelCredit } from "../scene/viewer-scene.ts";
import { OrbitCamera } from "./orbit-camera.ts";
import {
  PlacedChunks,
  type PlacedModel,
  type RebuildReport,
  type ViewUpdate,
} from "./placed-chunks.ts";
import { itemSpecOf } from "./item-specs.ts";
import { modelPlaceable, platePlaceable, type Placeable } from "./placeable.ts";
import {
  parsePlanArchiveManifest,
  placementId,
  planArchiveManifest,
  regionOriginX,
  regionOriginZ,
  type ArchivedModel,
} from "@brr/domain";
import { readStoredZip, storedZip, type ZipEntry } from "../plan/stored-zip.ts";
import { BUILDABLE_SERVICE, PLAN_SERVICE } from "../tokens.ts";
import type { IBuildableService } from "../plan/buildable-service.ts";
import type { IPlanService } from "../plan/plan-service.ts";

export type EditorStatus = "loading" | "ready" | "error";
export type EditAction = EditKind;
export type EditorMode = "place" | "select";

export interface CatalogItemView {
  readonly id: string;
  readonly label: string;
  readonly kind: Placeable["kind"];
  readonly parts: number;
  readonly studsWide: number;
  readonly studsDeep: number;
}

export interface LatencySample {
  readonly step: HistoryStep;
  readonly action: EditAction;
  readonly item: string;
  readonly rot: number;
  readonly x: number;
  readonly z: number;
  readonly ms: number;
  readonly rebuildMs: number;
  readonly queueMs: number;
  readonly submitMs: number;
  readonly gpuWaitMs: number;
  readonly rebuiltChunks: number;
  readonly rebuiltInstances: number;
  readonly rebuiltStuds: number;
}

export interface SelectionView {
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
  readonly chunkKey: number;
  readonly slot: number;
  readonly box: WorldBox;
}

export interface HistoryView {
  readonly undo: EditAction | null;
  readonly redo: EditAction | null;
  readonly undoDepth: number;
  readonly redoDepth: number;
}

export interface EditorStats {
  readonly fps: number;
  readonly drawCalls: number;
  readonly triangles: number;
}

export interface EditorSnapshot {
  readonly status: EditorStatus;
  readonly error: string | null;
  readonly loadMs: number | null;
  readonly backend: BackendInfo | null;
  readonly catalog: ReadonlyArray<CatalogItemView>;
  readonly mode: EditorMode;
  readonly activeItem: string | null;
  readonly ghostRot: number;
  readonly hover: { readonly x: number; readonly z: number } | null;
  readonly selection: SelectionView | null;
  readonly placements: number;
  readonly history: HistoryView;
  readonly lastLatency: LatencySample | null;
  readonly latencies: ReadonlyArray<LatencySample>;
  readonly stats: EditorStats | null;
  readonly credits: EditorCredits | null;
}

export interface EditorCredits {
  readonly partFiles: number;
  readonly partFilesLod: BundleLod;
  readonly models: ReadonlyArray<ModelCredit>;
}

export interface EditorDump {
  readonly refs: ReadonlyArray<string>;
  readonly frameShifts: ReadonlyArray<readonly [number, number, number]>;
  readonly placements: PlacementDump;
}

export interface EditorOptions {
  readonly api: GraphicsApi;
  readonly pixelRatio: number;
}

export interface IEditor {
  start(canvas: HTMLCanvasElement, options: EditorOptions): Promise<void>;
  subscribe(listener: () => void): () => void;
  snapshot(): EditorSnapshot;
  chooseItem(id: string | null): void;
  pointerMove(ndcX: number, ndcY: number): void;
  pointerLeave(): void;
  click(ndcX: number, ndcY: number, eventTimeMs: number): void;
  rotate(eventTimeMs: number): void;
  deleteSelection(eventTimeMs: number): void;
  undo(eventTimeMs: number): void;
  redo(eventTimeMs: number): void;
  orbit(dxPx: number, dyPx: number): void;
  pan(dxPx: number, dyPx: number): void;
  zoom(wheelDelta: number): void;
  focusSelection(): void;
  centreOnCursor(): void;
  planOriginHere(): { readonly chunkX: number; readonly chunkZ: number };
  viewPlanFromAbove(planId: string): void;
  dump(): EditorDump;
  planArchive(planId: string, disclaimer: string): Uint8Array | null;
  openPlanArchive(bytes: Uint8Array): string;
}

const EDITOR_LOD: BundleLod = "standard";
const BASEPLATE_ID = "ldraw:3811";
const BASEPLATE_COLOR_NAME = "Green";
const QUARTER_TURNS = 4;
const ZERO_TURN: Rot90 = 0;
const STATS_INTERVAL_MS = 500;

interface PendingAction {
  readonly step: HistoryStep;
  readonly action: EditAction;
  readonly item: string;
  readonly rot: number;
  readonly x: number;
  readonly z: number;
  readonly startMs: number;
  readonly rebuiltMs: number;
  readonly report: RebuildReport;
}

interface FrameTimes {
  readonly startMs: number;
  readonly submittedMs: number;
  readonly presentedMs: number;
}

function snapToLattice(ldu: number): number {
  return Math.round(ldu / STUD_LDU) * STUD_LDU + 0;
}

@injectable()
export class Editor implements IEditor {
  private readonly listeners = new Set<() => void>();
  private state: EditorSnapshot = {
    status: "loading",
    error: null,
    loadMs: null,
    backend: null,
    catalog: [],
    mode: "select",
    activeItem: null,
    ghostRot: 0,
    hover: null,
    selection: null,
    placements: 0,
    history: { undo: null, redo: null, undoDepth: 0, redoDepth: 0 },
    lastLatency: null,
    latencies: [],
    stats: null,
    credits: null,
  };
  private readonly world = new World();
  private readonly history = new EditHistory(this.world);
  private readonly camera = new OrbitCamera();
  private readonly ray = new Float64Array(RAY_FLOATS);
  private readonly frameStats: FrameStats = {
    drawCalls: 0,
    triangles: 0,
    nearChunks: 0,
    midChunks: 0,
    farChunks: 0,
    renderOriginChunkX: 0,
    renderOriginChunkZ: 0,
    rebaseCount: 0,
  };
  private placeables: Placeable[] = [];
  private bundleVersion = "";
  private placed: PlacedChunks;
  private active: Placeable | null = null;
  private selected: PlacedModel | null = null;
  private ghostRot = 0;
  private hoverX = 0;
  private hoverZ = 0;
  private hovering = false;
  private pending: PendingAction | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private framesSinceStats = 0;
  private statsSince = 0;

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
    @inject(PLAN_SERVICE) private readonly plans: IPlanService,
    @inject(BUILDABLE_SERVICE) private readonly buildable: IBuildableService,
  ) {
    this.placed = new PlacedChunks(backend);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): EditorSnapshot {
    return this.state;
  }

  private update(patch: Partial<EditorSnapshot>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }

  async start(canvas: HTMLCanvasElement, options: EditorOptions): Promise<void> {
    try {
      const started = performance.now();
      this.canvas = canvas;
      const backend = await this.backend.init({
        canvas,
        api: options.api,
        pixelRatio: options.pixelRatio,
        antialias: true,
      });
      const bundle = await this.loader.load(
        EDITOR_LOD,
        (part) => part.id === BASEPLATE_ID || part.role === "road",
      );
      const colors = new ColorTable(bundle);
      const palette = new MergedParts(bundle.parts);
      this.placeables = await this.loadPlaceables(bundle, palette, colors);
      this.bundleVersion = bundle.bundleVersion;
      this.plans.setTableTopY(this.baseplateBottomY());
      const crosswalk = await this.loader.loadCrosswalk("standard");
      this.buildable.setCatalog(
        this.placeables.map((placeable) =>
          itemSpecOf(placeable, palette.parts, bundle.moduleStandards),
        ),
        bundle.moduleStandards,
        crosswalk,
        Object.fromEntries(bundle.colors.map((color) => [color.code, color.name])),
      );
      this.backend.setPalette({
        detailed: { parts: palette.parts, studPrimitives: bundle.studPrimitives },
        colorsSrgb: colors.toSrgb(),
        ldrawColorsSrgb: ldrawColorsSrgb(bundle),
      });
      this.update({
        status: "ready",
        loadMs: performance.now() - started,
        backend,
        catalog: this.placeables.map((placeable) => ({
          id: placeable.id,
          label: placeable.label,
          kind: placeable.kind,
          parts: placeable.parts.count,
          studsWide: Math.round((placeable.box.max[0] - placeable.box.min[0]) / STUD_LDU),
          studsDeep: Math.round((placeable.box.max[2] - placeable.box.min[2]) / STUD_LDU),
        })),
        credits: {
          partFiles: bundle.credits.length,
          partFilesLod: EDITOR_LOD,
          models: this.placeables.flatMap((p) => (p.credit ? [p.credit] : [])),
        },
      });
      this.statsSince = performance.now();
      this.resizeToCanvas();
      this.camera.apply(this.backend);
      requestAnimationFrame(this.step);
    } catch (error) {
      this.update({ status: "error", error: String(error) });
    }
  }

  private baseplateBottomY(): number {
    const baseplate = this.placeables.find((p) => p.kind === "baseplate");
    if (!baseplate) throw new Error(`the bundle has no ${BASEPLATE_ID} baseplate`);
    return baseplate.box.min[1];
  }

  private syncPlan(): void {
    this.plans.setPlacements(
      this.placed.models().map((model) => ({
        key: { chunkKey: model.handle.chunkKey, slot: model.handle.slot },
        ref: model.placeable.id,
        label: `${model.placeable.label} at ${model.handle.x}, ${model.handle.z}`,
        box: model.box,
        x: model.handle.x,
        z: model.handle.z,
        rot: model.handle.rot,
      })),
    );
  }

  private async loadPlaceables(
    bundle: PartBundle,
    palette: MergedParts,
    colors: ColorTable,
  ): Promise<Placeable[]> {
    const baseplateIndex = palette.indexOf(BASEPLATE_ID);
    const baseplate = palette.parts[baseplateIndex];
    if (!baseplate) throw new Error(`the bundle has no ${BASEPLATE_ID} baseplate`);
    const baseplateColor = bundle.colors.find((c) => c.name === BASEPLATE_COLOR_NAME);
    if (!baseplateColor) throw new Error(`LDConfig colour ${BASEPLATE_COLOR_NAME} is missing`);
    const sets = bundle.models.filter((entry) => entry.origin === "omr");
    const loaded = await Promise.all(
      sets.map((entry) => this.loader.loadModel(EDITOR_LOD, entry.name)),
    );
    const roads = bundle.parts.filter((part) => part.role === "road");
    return [
      platePlaceable(
        baseplate,
        baseplateIndex,
        baseplateColor.code,
        { kind: "baseplate", label: `${BASEPLATE_ID.replace("ldraw:", "")} baseplate 32×32` },
        palette.parts,
        colors,
      ),
      ...roads.map((road) => {
        const color = road.producedColor;
        if (color === undefined) throw new Error(`${road.id} has no produced display colour`);
        return platePlaceable(
          road,
          palette.indexOf(road.id),
          color,
          { kind: "road", label: `${road.id.replace("ldraw:", "")} road plate 32×32` },
          palette.parts,
          colors,
        );
      }),
      ...loaded.map(({ bundle: modelBundle, entry, model }) =>
        modelPlaceable(
          entry.name,
          palette.remap(model, modelBundle.parts),
          { name: entry.name, source: entry.source, sections: model.sections },
          palette.parts,
          colors,
        ),
      ),
    ];
  }

  private readonly step = (): void => {
    void this.frame();
  };

  private async frame(): Promise<void> {
    try {
      this.resizeToCanvas();
      const startMs = performance.now();
      this.camera.apply(this.backend);
      this.backend.renderFrame(this.frameStats);
      const pending = this.pending;
      if (pending) {
        this.pending = null;
        const submittedMs = performance.now();
        await this.backend.waitForGpu();
        this.recordLatency(pending, { startMs, submittedMs, presentedMs: performance.now() });
      }
      this.tallyStats();
      requestAnimationFrame(this.step);
    } catch (error) {
      this.update({ status: "error", error: String(error) });
    }
  }

  private resizeToCanvas(): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.dataset["cssSize"] === `${width}x${height}`) return;
    canvas.dataset["cssSize"] = `${width}x${height}`;
    this.backend.resize(width, height);
  }

  private tallyStats(): void {
    this.framesSinceStats++;
    const now = performance.now();
    const elapsed = now - this.statsSince;
    if (elapsed < STATS_INTERVAL_MS) return;
    this.update({
      stats: {
        fps: (this.framesSinceStats * 1000) / elapsed,
        drawCalls: this.frameStats.drawCalls,
        triangles: this.frameStats.triangles,
      },
    });
    this.framesSinceStats = 0;
    this.statsSince = now;
  }

  private recordLatency(pending: PendingAction, frame: FrameTimes): void {
    const sample: LatencySample = {
      step: pending.step,
      action: pending.action,
      item: pending.item,
      rot: pending.rot,
      x: pending.x,
      z: pending.z,
      ms: frame.presentedMs - pending.startMs,
      rebuildMs: pending.rebuiltMs - pending.startMs,
      queueMs: frame.startMs - pending.rebuiltMs,
      submitMs: frame.submittedMs - frame.startMs,
      gpuWaitMs: frame.presentedMs - frame.submittedMs,
      rebuiltChunks: pending.report.chunks,
      rebuiltInstances: pending.report.instances,
      rebuiltStuds: pending.report.studs,
    };
    this.update({ lastLatency: sample, latencies: [...this.state.latencies, sample] });
  }

  chooseItem(id: string | null): void {
    if (id === null && !this.active) {
      this.select(null);
      return;
    }
    const placeable = id === null ? null : (this.placeables.find((p) => p.id === id) ?? null);
    this.active = placeable;
    this.backend.setGhost(placeable ? { ...placeable.parts, studs: placeable.studs } : null);
    if (placeable) this.select(null);
    this.placeGhost();
    this.update({ mode: placeable ? "place" : "select", activeItem: placeable?.id ?? null });
  }

  private groundHit(ndcX: number, ndcY: number): boolean {
    this.backend.rayThrough(ndcX, ndcY, this.ray);
    const originY = this.ray[1] ?? 0;
    const directionY = this.ray[4] ?? 0;
    if (directionY >= 0) return false;
    const t = -originY / directionY;
    this.hoverX = snapToLattice((this.ray[0] ?? 0) + (this.ray[3] ?? 0) * t);
    this.hoverZ = snapToLattice((this.ray[2] ?? 0) + (this.ray[5] ?? 0) * t);
    return true;
  }

  private placeGhost(): void {
    if (!this.active || !this.hovering) return;
    this.backend.placeGhost(this.hoverX, 0, this.hoverZ, this.ghostRot);
  }

  pointerMove(ndcX: number, ndcY: number): void {
    this.hovering = this.groundHit(ndcX, ndcY);
    this.placeGhost();
    this.update({ hover: this.hovering ? { x: this.hoverX, z: this.hoverZ } : null });
  }

  pointerLeave(): void {
    this.hovering = false;
    this.update({ hover: null });
  }

  click(ndcX: number, ndcY: number, eventTimeMs: number): void {
    if (this.active) {
      if (!this.groundHit(ndcX, ndcY)) return;
      this.hovering = true;
      this.placeAt(this.active, this.hoverX, this.hoverZ, this.ghostRot, eventTimeMs);
      return;
    }
    this.backend.rayThrough(ndcX, ndcY, this.ray);
    let best: PlacedModel | null = null;
    let bestT = Number.POSITIVE_INFINITY;
    for (const model of this.placed.models()) {
      const t = model.rayHit(this.ray);
      if (t < bestT) {
        bestT = t;
        best = model;
      }
    }
    this.select(best);
  }

  private placeAt(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
    eventTimeMs: number,
  ): void {
    this.show(
      this.history.place({
        refId: this.placeables.indexOf(placeable),
        colorId: placeable.worldColor,
        x,
        z,
        yPlates: 0,
        rot,
      }),
      eventTimeMs,
    );
  }

  private placeableAt(refId: number): Placeable {
    const placeable = this.placeables[refId];
    if (!placeable) throw new Error(`no catalog item has ref id ${refId}`);
    return placeable;
  }

  private show(edit: AppliedEdit, eventTimeMs: number): ViewUpdate {
    const view = this.placed.apply(edit, (refId) => this.placeableAt(refId));
    const primary = edit.changes[0];
    const pose = primary?.to ?? primary?.from ?? null;
    if (pose) {
      this.pending = {
        step: edit.step,
        action: edit.kind,
        item: this.placeableAt(pose.refId).id,
        rot: pose.rot,
        x: pose.x,
        z: pose.z,
        startMs: eventTimeMs,
        rebuiltMs: performance.now(),
        report: view.report,
      };
    }
    this.update({
      placements: this.world.size,
      history: {
        undo: this.history.nextUndo(),
        redo: this.history.nextRedo(),
        undoDepth: this.history.undoDepth,
        redoDepth: this.history.redoDepth,
      },
    });
    this.syncPlan();
    return view;
  }

  private select(model: PlacedModel | null): void {
    this.selected = model;
    this.backend.setSelectionBox(model ? model.box : null);
    this.update({
      selection: model
        ? {
            item: model.placeable.id,
            x: model.handle.x,
            z: model.handle.z,
            yPlates: model.handle.yPlates,
            rot: model.handle.rot,
            chunkKey: model.handle.chunkKey,
            slot: model.handle.slot,
            box: model.box,
          }
        : null,
    });
  }

  rotate(eventTimeMs: number): void {
    if (this.active) {
      this.ghostRot = (this.ghostRot + 1) % QUARTER_TURNS;
      this.placeGhost();
      this.update({ ghostRot: this.ghostRot });
      return;
    }
    const model = this.selected;
    if (!model) return;
    this.select(this.show(this.history.rotate(model.placement), eventTimeMs).added[0] ?? null);
  }

  deleteSelection(eventTimeMs: number): void {
    const model = this.selected;
    if (!model) return;
    this.show(this.history.remove(model.placement), eventTimeMs);
    this.select(null);
  }

  undo(eventTimeMs: number): void {
    this.replay(this.history.undo(), eventTimeMs);
  }

  redo(eventTimeMs: number): void {
    this.replay(this.history.redo(), eventTimeMs);
  }

  private replay(edit: AppliedEdit | null, eventTimeMs: number): void {
    if (!edit) return;
    const selected = this.selected;
    const restored = this.show(edit, eventTimeMs).added.at(-1);
    if (this.active) return;
    if (restored) this.select(restored);
    else if (selected && !selected.handle.live) this.select(null);
  }

  orbit(dxPx: number, dyPx: number): void {
    this.camera.orbit(dxPx, dyPx);
    this.camera.apply(this.backend);
  }

  pan(dxPx: number, dyPx: number): void {
    this.camera.pan(dxPx, dyPx);
    this.camera.apply(this.backend);
  }

  zoom(wheelDelta: number): void {
    this.camera.zoom(wheelDelta);
    this.camera.apply(this.backend);
  }

  focusSelection(): void {
    if (!this.selected) return;
    this.camera.focus(this.selected.box);
    this.camera.apply(this.backend);
  }

  centreOnCursor(): void {
    if (!this.hovering) return;
    this.camera.centreOn(this.hoverX, this.hoverZ);
    this.camera.apply(this.backend);
  }

  planOriginHere(): { readonly chunkX: number; readonly chunkZ: number } {
    const [x, z] = this.camera.targetXZ();
    return { chunkX: chunkOf(x), chunkZ: chunkOf(z) };
  }

  viewPlanFromAbove(planId: string): void {
    const plan = this.plans.snapshot().plans.find((p) => p.id === planId);
    if (!plan) return;
    const room = roomRect(plan);
    const canvas = this.canvas;
    const aspect = canvas ? canvas.clientWidth / Math.max(canvas.clientHeight, 1) : 1;
    this.camera.topDown(
      { ...room, minY: 0, maxY: 0 },
      (CAMERA_FOV_DEGREES * Math.PI) / 180,
      aspect,
    );
    this.camera.apply(this.backend);
  }

  planArchive(planId: string, disclaimer: string): Uint8Array | null {
    const planState = this.plans.snapshot();
    const index = planState.plans.findIndex((plan) => plan.id === planId);
    const region = planState.plans[index];
    const check = planState.checks[index];
    const buildable = this.buildable.snapshot();
    const report = buildable.reports.find((r) => r.regionId === planId);
    const purchase = buildable.purchases.find((p) => p.regionId === planId);
    const settings = buildable.settings[planId];
    const svg = this.buildable.printablePlan(planId, disclaimer);
    if (!region || !check || !report || !purchase || !settings || svg === null) return null;
    const encoder = new TextEncoder();
    const files: ZipEntry[] = [
      { name: "plan.svg", bytes: encoder.encode(svg) },
      { name: "parts.csv", bytes: encoder.encode(purchase.files.plainCsv) },
      { name: "bricklink.xml", bytes: encoder.encode(purchase.files.brickLinkXml) },
      { name: "rebrickable.csv", bytes: encoder.encode(purchase.files.rebrickableCsv) },
    ];
    const models: ArchivedModel[] = this.placeables.flatMap((placeable) =>
      placeable.credit
        ? [
            {
              ref: placeable.id,
              source: placeable.credit.source,
              authors: [...new Set(placeable.credit.sections.map((s) => s.author))],
              licenses: [...new Set(placeable.credit.sections.map((s) => s.license ?? "none"))],
            },
          ]
        : [],
    );
    const placements = this.placed.models().map((model) => {
      const rot = model.handle.rot;
      return {
        key: { chunkKey: model.handle.chunkKey, slot: model.handle.slot },
        ref: model.placeable.id,
        label: model.placeable.label,
        box: model.box,
        x: model.handle.x,
        z: model.handle.z,
        rot: isRot90(rot) ? rot : ZERO_TURN,
      };
    });
    const insideIds = new Set(check.inside.map(placementId));
    const credits = [
      `${region.name}: a Brick Railroad plan`,
      "",
      ...models
        .filter((model) =>
          placements.some((p) => p.ref === model.ref && insideIds.has(placementId(p.key))),
        )
        .map(
          (model) =>
            `${model.ref}: ${model.authors.join(", ")} (${model.licenses.join(", ")}); ${model.source}`,
        ),
      "",
      "Parts: LDraw parts library (CC BY 4.0 / CC BY 2.0 and CC BY 4.0), modified from LDraw: flattened, studs extracted.",
      disclaimer,
      "",
    ].join("\n");
    files.push({ name: "CREDITS.txt", bytes: encoder.encode(credits) });
    const manifest = planArchiveManifest({
      bundleVersion: this.bundleVersion,
      region,
      settings,
      placements,
      inside: check.inside,
      models,
      report,
      files: files.map((file) => file.name),
      disclaimer,
    });
    return storedZip([
      { name: "manifest.json", bytes: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
      ...files,
    ]);
  }

  openPlanArchive(bytes: Uint8Array): string {
    const entries = readStoredZip(bytes);
    const manifestEntry = entries.find((entry) => entry.name === "manifest.json");
    if (!manifestEntry) throw new Error("the archive has no manifest.json");
    const manifest = parsePlanArchiveManifest(
      JSON.parse(new TextDecoder().decode(manifestEntry.bytes)),
    );
    if (typeof manifest === "string") throw new Error(manifest);
    const missing = manifest.placements.filter(
      (placement) => !this.placeables.some((p) => p.id === placement.ref),
    );
    if (missing.length > 0) {
      throw new Error(
        `bundle ${this.bundleVersion} has no ${[...new Set(missing.map((p) => p.ref))].join(", ")} (the plan was saved with bundle ${manifest.bundleVersion})`,
      );
    }
    const { plan } = manifest;
    const planId = this.plans.createPlan({
      name: plan.name,
      roomWidthMm: plan.footprint.roomWidthMm,
      roomDepthMm: plan.footprint.roomDepthMm,
      originChunkX: plan.originChunkX,
      originChunkZ: plan.originChunkZ,
    });
    this.plans.updatePlan(planId, { maxOverhangMm: plan.maxOverhangMm });
    for (const table of plan.footprint.tables) {
      this.plans.addTable(planId, { name: table.name, rect: table.rect, heightMm: table.heightMm });
    }
    for (const obstacle of plan.footprint.obstacles) {
      this.plans.addObstacle(planId, { name: obstacle.name, rect: obstacle.rect });
    }
    this.buildable.setProfile(planId, manifest.settings.profile);
    this.buildable.setMaxReach(planId, manifest.settings.maxReachMm);
    const region = this.plans.snapshot().plans.find((p) => p.id === planId);
    if (!region) throw new Error(`plan ${planId} was not created`);
    for (const placement of manifest.placements) {
      const placeable = this.placeables.find((p) => p.id === placement.ref);
      if (!placeable) continue;
      const edit = this.history.place({
        refId: this.placeables.indexOf(placeable),
        colorId: placeable.worldColor,
        x: regionOriginX(region) + placement.x,
        z: regionOriginZ(region) + placement.z,
        yPlates: 0,
        rot: placement.rot,
      });
      this.placed.apply(edit, (refId) => this.placeableAt(refId));
    }
    this.update({ placements: this.world.size });
    this.syncPlan();
    this.viewPlanFromAbove(planId);
    return planId;
  }

  dump(): EditorDump {
    return {
      refs: this.placeables.map((p) => p.id),
      frameShifts: this.placeables.map((p) => p.frameShift),
      placements: dumpPlacements(this.world),
    };
  }
}

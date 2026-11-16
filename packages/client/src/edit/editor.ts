import { PART_BUNDLE_LOADER, type IPartBundleLoader, type PartBundle } from "@brr/catalog";
import { MergedParts } from "./merged-parts.ts";
import { World } from "@brr/domain";
import { STUD_LDU } from "@brr/math";
import {
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
import { PlacedChunks, type PlacedModel, type RebuildReport } from "./placed-chunks.ts";
import { baseplatePlaceable, modelPlaceable, type Placeable } from "./placeable.ts";

export type EditorStatus = "loading" | "ready" | "error";
export type EditAction = "place" | "rotate" | "delete";
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
  readonly lastLatency: LatencySample | null;
  readonly latencies: ReadonlyArray<LatencySample>;
  readonly stats: EditorStats | null;
  readonly credits: EditorCredits | null;
}

export interface EditorCredits {
  readonly partFiles: number;
  readonly partLicenses: ReadonlyArray<string>;
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
  orbit(dxPx: number, dyPx: number): void;
  pan(dxPx: number, dyPx: number): void;
  zoom(wheelDelta: number): void;
  focusSelection(): void;
  centreOnCursor(): void;
  dump(): EditorDump;
}

const BASEPLATE_ID = "ldraw:3811";
const BASEPLATE_COLOR_NAME = "Green";
const QUARTER_TURNS = 4;
const STATS_INTERVAL_MS = 500;

interface PendingAction {
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
    lastLatency: null,
    latencies: [],
    stats: null,
    credits: null,
  };
  private readonly world = new World();
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
      const bundle = await this.loader.load("standard", (part) => part.id === BASEPLATE_ID);
      const colors = new ColorTable(bundle);
      const palette = new MergedParts(bundle.parts);
      this.placeables = await this.loadPlaceables(bundle, palette, colors);
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
          partLicenses: [...new Set(bundle.credits.map((c) => c.license ?? "none"))],
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
      sets.map((entry) => this.loader.loadModel("standard", entry.name)),
    );
    return [
      baseplatePlaceable(baseplate, baseplateIndex, baseplateColor.code, palette.parts, colors),
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
      this.placeAt(this.active, this.hoverX, this.hoverZ, this.ghostRot, "place", eventTimeMs);
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
    action: EditAction,
    eventTimeMs: number,
  ): PlacedModel {
    const refId = this.placeables.indexOf(placeable);
    const handle = this.world.add(refId, placeable.worldColor, x, z, 0, rot);
    const { placed, report } = this.placed.add(handle, placeable);
    this.pending = {
      action,
      item: placeable.id,
      rot,
      x,
      z,
      startMs: eventTimeMs,
      rebuiltMs: performance.now(),
      report,
    };
    this.update({ placements: this.world.size });
    return placed;
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
    const { x, z } = model.handle;
    const rot = (model.handle.rot + 1) % QUARTER_TURNS;
    this.world.remove(model.handle);
    const handle = this.world.add(
      this.placeables.indexOf(model.placeable),
      model.placeable.worldColor,
      x,
      z,
      0,
      rot,
    );
    const { placed, report } = this.placed.replace(model, handle);
    this.pending = {
      action: "rotate",
      item: model.placeable.id,
      rot,
      x,
      z,
      startMs: eventTimeMs,
      rebuiltMs: performance.now(),
      report,
    };
    this.select(placed);
  }

  private removeModel(model: PlacedModel): RebuildReport {
    this.world.remove(model.handle);
    return this.placed.remove(model);
  }

  deleteSelection(eventTimeMs: number): void {
    const model = this.selected;
    if (!model) return;
    const { x, z, rot } = model.handle;
    const report = this.removeModel(model);
    this.pending = {
      action: "delete",
      item: model.placeable.id,
      rot,
      x,
      z,
      startMs: eventTimeMs,
      rebuiltMs: performance.now(),
      report,
    };
    this.select(null);
    this.update({ placements: this.world.size });
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

  dump(): EditorDump {
    return {
      refs: this.placeables.map((p) => p.id),
      frameShifts: this.placeables.map((p) => p.frameShift),
      placements: dumpPlacements(this.world),
    };
  }
}

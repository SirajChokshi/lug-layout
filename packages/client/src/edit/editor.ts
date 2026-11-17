import {
  PART_BUNDLE_LOADER,
  type BundleLod,
  type IPartBundleLoader,
  type NotDrawnSection,
  type PartBundle,
} from "@brr/catalog";
import { MergedParts } from "./merged-parts.ts";
import {
  BomCounter,
  countPlacements,
  EditHistory,
  RoadNetwork,
  World,
  roomRect,
  type AppliedEdit,
  type PlacementContents,
  type EditKind,
  type HistoryStep,
  type RoadEdgeSegment,
  type RoadJoinReport,
  type RoadPlacement,
} from "@brr/domain";
import { PLATE_LDU, STUD_LDU, chunkOf } from "@brr/math";
import {
  CAMERA_FOV_DEGREES,
  RAY_FLOATS,
  SCENE_BACKEND,
  type BackendInfo,
  type EdgeMarker,
  type FrameStats,
  type GraphicsApi,
  type ISceneBackend,
  type WorldBox,
} from "@brr/render";
import { inject, injectable } from "inversify";
import {
  notDrawnItems,
  type BomInput,
  type BomScope,
  type IBomSource,
} from "../bom/bom-service.ts";
import { dumpPlacements, type PlacementDump } from "../scene/placements.ts";
import { ColorTable, ldrawColorsSrgb, type ModelCredit } from "../scene/viewer-scene.ts";
import { OrbitCamera } from "./orbit-camera.ts";
import {
  PlacedChunks,
  type PlacedModel,
  type RebuildReport,
  type ViewUpdate,
} from "./placed-chunks.ts";
import { modelPlaceable, partPlaceable, type Placeable } from "./placeable.ts";
import { cellExtent, snapToRoadEdge, type CellExtent } from "./road-snap.ts";
import { PLAN_SERVICE } from "../tokens.ts";
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

export interface RoadIssueView {
  readonly status: "open" | "mismatch";
  readonly item: string;
  readonly side: RoadEdgeSegment["side"];
  readonly line: number;
  readonly from: number;
  readonly to: number;
  readonly topLdu: number;
}

export interface RoadJoinView {
  readonly checkMs: number;
  readonly placements: number;
  readonly joinedCells: number;
  readonly openCells: number;
  readonly mismatchedCells: number;
  readonly overlaps: number;
  readonly issues: ReadonlyArray<RoadIssueView>;
}

export type RoadSnapState = "snapped" | "free" | "refused";

export interface RoadSnapView {
  readonly state: RoadSnapState;
  readonly joinedCells: number;
  readonly mismatchedCells: number;
  readonly overlappingCells: number;
}

export interface RefusedClick {
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly rot: number;
  readonly mismatchedCells: number;
  readonly overlappingCells: number;
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
  readonly roads: RoadJoinView;
  readonly showJoins: boolean;
  readonly snapRoads: boolean;
  readonly snap: RoadSnapView | null;
  readonly refusedClicks: number;
  readonly lastRefusal: RefusedClick | null;
}

export interface EditorCredits {
  readonly partFiles: number;
  readonly partFilesLod: BundleLod;
  readonly models: ReadonlyArray<ModelCredit>;
}

export interface RoadPlacementDump {
  readonly id: number;
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
}

export interface EditorDump {
  readonly refs: ReadonlyArray<string>;
  readonly frameShifts: ReadonlyArray<readonly [number, number, number]>;
  readonly placements: PlacementDump;
  readonly roadPlacements: ReadonlyArray<RoadPlacementDump>;
  readonly roads: RoadJoinReport;
}

export interface EditorOptions {
  readonly api: GraphicsApi;
  readonly pixelRatio: number;
}

export interface IEditor extends IBomSource {
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
  setShowJoins(show: boolean): void;
  setSnapRoads(snap: boolean): void;
  planOriginHere(): { readonly chunkX: number; readonly chunkZ: number };
  viewPlanFromAbove(planId: string): void;
  dump(): EditorDump;
}

const EDITOR_LOD: BundleLod = "standard";
const BASEPLATE_ID = "ldraw:3811";
const BASEPLATE_COLOR_NAME = "Green";
const QUARTER_TURNS = 4;
const STATS_INTERVAL_MS = 500;
const MARKER_WIDTH_LDU = 6;
const MARKER_LIFT_LDU = 1;
const MARKER_HEIGHT_LDU = 2;
const LISTED_ROAD_ISSUES = 12;
const EMPTY_ROADS: RoadJoinView = {
  checkMs: 0,
  placements: 0,
  joinedCells: 0,
  openCells: 0,
  mismatchedCells: 0,
  overlaps: 0,
  issues: [],
};

function markerBox(segment: RoadEdgeSegment): EdgeMarker["box"] {
  const minY = segment.topLdu + MARKER_LIFT_LDU;
  const maxY = minY + MARKER_HEIGHT_LDU;
  switch (segment.side) {
    case "minX":
      return {
        minX: segment.line,
        maxX: segment.line + MARKER_WIDTH_LDU,
        minY,
        maxY,
        minZ: segment.from,
        maxZ: segment.to,
      };
    case "maxX":
      return {
        minX: segment.line - MARKER_WIDTH_LDU,
        maxX: segment.line,
        minY,
        maxY,
        minZ: segment.from,
        maxZ: segment.to,
      };
    case "minZ":
      return {
        minX: segment.from,
        maxX: segment.to,
        minY,
        maxY,
        minZ: segment.line,
        maxZ: segment.line + MARKER_WIDTH_LDU,
      };
    case "maxZ":
      return {
        minX: segment.from,
        maxX: segment.to,
        minY,
        maxY,
        minZ: segment.line - MARKER_WIDTH_LDU,
        maxZ: segment.line,
      };
    default: {
      const unhandled: never = segment.side;
      throw new Error(`unhandled side ${String(unhandled)}`);
    }
  }
}

const EDITOR_WORLD_NAME = "editor-world";
const FILE_NAME_UNSAFE = /[^A-Za-z0-9.-]+/gu;

interface EditorBomTables {
  readonly palette: MergedParts;
  readonly colors: ColorTable;
  readonly ldrawColors: ReadonlyArray<number>;
}

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
    roads: EMPTY_ROADS,
    showJoins: true,
    snapRoads: true,
    snap: null,
    refusedClicks: 0,
    lastRefusal: null,
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
  private placed: PlacedChunks;
  private active: Placeable | null = null;
  private selected: PlacedModel | null = null;
  private ghostRot = 0;
  private hoverX = 0;
  private hoverZ = 0;
  private hovering = false;
  private pending: PendingAction | null = null;
  private roadModels: ReadonlyArray<PlacedModel> = [];
  private roadExtents: ReadonlyArray<CellExtent> = [];
  private roadNetwork = new RoadNetwork([]);
  private roadReport: RoadJoinReport = new RoadNetwork([]).report();
  private canvas: HTMLCanvasElement | null = null;
  private framesSinceStats = 0;
  private statsSince = 0;
  private bomTables: EditorBomTables | null = null;
  private placeableNotDrawn: ReadonlyArray<ReadonlyArray<NotDrawnSection>> = [];

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
    @inject(PLAN_SERVICE) private readonly plans: IPlanService,
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
      this.plans.setTableTopY(this.baseplateBottomY());
      this.bomTables = { palette, colors, ldrawColors: bundle.colors.map((color) => color.code) };
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
    const baseplate = this.placeables.find((p) => p.id === BASEPLATE_ID);
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
    const roadParts = bundle.parts.filter((part) => part.role === "road");
    const placeableModels = [
      ...bundle.models.filter((entry) => entry.role === "road-module"),
      ...bundle.models.filter((entry) => entry.origin === "omr"),
    ];
    const loaded = await Promise.all(
      placeableModels.map((entry) => this.loader.loadModel(EDITOR_LOD, entry.name)),
    );
    this.placeableNotDrawn = [[], ...loaded.map(({ entry }) => entry.notDrawn ?? [])];
    return [
      partPlaceable(baseplate, baseplateIndex, baseplateColor.code, palette.parts, colors),
      ...roadParts.map((part) => {
        if (part.producedColor === undefined) {
          throw new Error(`${part.id} has no produced colour in the bundle`);
        }
        return partPlaceable(
          part,
          palette.indexOf(part.id),
          part.producedColor,
          palette.parts,
          colors,
        );
      }),
      ...loaded.map(({ bundle: modelBundle, entry, model }) =>
        modelPlaceable(
          entry.name,
          entry.role === "road-module" ? (model.sections[0]?.title ?? entry.name) : entry.name,
          entry.role,
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

  private snapGhostToRoad(): RoadSnapView | null {
    const surface = this.active?.road;
    if (!surface || !this.hovering || !this.state.snapRoads) return null;
    const snap = snapToRoadEdge(
      this.roadNetwork,
      this.roadExtents,
      surface,
      this.ghostRot,
      0,
      this.hoverX,
      this.hoverZ,
    );
    if (snap) {
      this.hoverX = snap.x;
      this.hoverZ = snap.z;
      return {
        state: "snapped",
        joinedCells: snap.joinedCells,
        mismatchedCells: 0,
        overlappingCells: 0,
      };
    }
    const fit = this.roadNetwork.fit({
      id: -1,
      x: this.hoverX,
      z: this.hoverZ,
      yLdu: 0,
      rot: this.ghostRot,
      surface,
    });
    const refused = fit.mismatchedCells > 0 || fit.overlappingCells > 0;
    return { state: refused ? "refused" : "free", ...fit };
  }

  pointerMove(ndcX: number, ndcY: number): void {
    this.hovering = this.groundHit(ndcX, ndcY);
    const snap = this.snapGhostToRoad();
    this.placeGhost();
    this.update({ hover: this.hovering ? { x: this.hoverX, z: this.hoverZ } : null, snap });
  }

  pointerLeave(): void {
    this.hovering = false;
    this.update({ hover: null });
  }

  click(ndcX: number, ndcY: number, eventTimeMs: number): void {
    if (this.active) {
      if (!this.groundHit(ndcX, ndcY)) return;
      this.hovering = true;
      const snap = this.snapGhostToRoad();
      this.placeGhost();
      if (snap?.state === "refused") {
        this.update({
          snap,
          refusedClicks: this.state.refusedClicks + 1,
          lastRefusal: {
            item: this.active.id,
            x: this.hoverX,
            z: this.hoverZ,
            rot: this.ghostRot,
            mismatchedCells: snap.mismatchedCells,
            overlappingCells: snap.overlappingCells,
          },
        });
        return;
      }
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
    this.refreshRoads();
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

  private roadPlacements(): ReadonlyArray<RoadPlacement> {
    const placements: RoadPlacement[] = [];
    for (let id = 0; id < this.roadModels.length; id++) {
      const model = this.roadModels[id];
      const surface = model?.placeable.road;
      if (!model || !surface) continue;
      placements.push({
        id,
        x: model.handle.x,
        z: model.handle.z,
        yLdu: model.handle.yPlates * PLATE_LDU,
        rot: model.handle.rot,
        surface,
      });
    }
    return placements;
  }

  private refreshRoads(): void {
    const started = performance.now();
    this.roadModels = this.placed.models().filter((model) => model.placeable.road !== null);
    const placements = this.roadPlacements();
    this.roadNetwork = new RoadNetwork(placements);
    this.roadExtents = placements.map(cellExtent);
    this.roadReport = this.roadNetwork.report();
    const checkMs = performance.now() - started;
    this.showRoadMarkers();
    const report = this.roadReport;
    const issues: RoadIssueView[] = [];
    for (const segment of report.segments) {
      if (segment.status === "joined" || issues.length >= LISTED_ROAD_ISSUES) continue;
      issues.push({
        status: segment.status,
        item: this.roadModels[segment.placement]?.placeable.id ?? "",
        side: segment.side,
        line: segment.line,
        from: segment.from,
        to: segment.to,
        topLdu: segment.topLdu,
      });
    }
    this.update({
      roads: {
        checkMs,
        placements: report.placements,
        joinedCells: report.joinedCells,
        openCells: report.openCells,
        mismatchedCells: report.mismatchedCells,
        overlaps: report.overlaps.length,
        issues,
      },
    });
  }

  private showRoadMarkers(): void {
    this.backend.setMarkers(
      this.state.showJoins
        ? this.roadReport.segments.map((segment) => ({
            box: markerBox(segment),
            kind: segment.status,
          }))
        : [],
    );
  }

  setShowJoins(show: boolean): void {
    this.update({ showJoins: show });
    this.showRoadMarkers();
  }

  setSnapRoads(snap: boolean): void {
    this.update({ snapRoads: snap, snap: null });
  }

  bomInput(scope: BomScope): BomInput {
    const tables = this.bomTables;
    if (!tables) throw new Error("the editor has not loaded");
    const counter = new BomCounter(
      tables.palette.parts.map((part) => part.id),
      tables.ldrawColors,
    );
    const placedCounts = new Map<number, number>();
    const contents: PlacementContents = {
      addTo: (target, refId) => {
        const placeable = this.placeables[refId];
        if (!placeable) throw new Error(`world holds unknown placeable ${refId}`);
        placedCounts.set(refId, (placedCounts.get(refId) ?? 0) + 1);
        const { parts } = placeable;
        for (let i = 0; i < parts.count; i++) {
          target.add(parts.partIndex[i] ?? 0, tables.colors.codeAt(parts.colorIndex[i] ?? 0), 1);
        }
      },
    };
    const uncounted = (): BomInput["uncounted"] =>
      [...placedCounts].flatMap(([refId, count]) =>
        notDrawnItems(
          this.placeables[refId]?.id ?? String(refId),
          this.placeableNotDrawn[refId] ?? [],
          count,
        ),
      );
    if (scope.kind !== "selection") {
      const placements = countPlacements(
        this.world,
        contents,
        counter,
        scope.kind === "region" ? scope.region : null,
      );
      return {
        name: EDITOR_WORLD_NAME,
        lod: "standard",
        placements,
        counter,
        uncounted: uncounted(),
      };
    }
    const selected = this.selected;
    if (!selected?.handle.live) throw new Error("nothing is selected");
    contents.addTo(counter, selected.handle.refId, selected.handle.colorId);
    return {
      name: `selection-${selected.placeable.id.replace(FILE_NAME_UNSAFE, "_")}`,
      lod: "standard",
      placements: 1,
      counter,
      uncounted: uncounted(),
    };
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

  dump(): EditorDump {
    return {
      refs: this.placeables.map((p) => p.id),
      frameShifts: this.placeables.map((p) => p.frameShift),
      placements: dumpPlacements(this.world),
      roadPlacements: this.roadModels.map((model, id) => ({
        id,
        item: model.placeable.id,
        x: model.handle.x,
        z: model.handle.z,
        yPlates: model.handle.yPlates,
        rot: model.handle.rot,
      })),
      roads: this.roadReport,
    };
  }
}

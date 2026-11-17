import type { BundleColor, BundleLod } from "@brr/schema/bundle";
import {
  PART_BUNDLE_LOADER,
  type IPartBundleLoader,
  type PartAsset,
  type PartBundle,
} from "@brr/catalog";
import { MergedParts } from "./merged-parts.ts";
import {
  EditHistory,
  RoadNetwork,
  World,
  roomRect,
  type AppliedEdit,
  type EditKind,
  type HistoryStep,
  type RoadEdgeSegment,
  type RoadJoinReport,
  type RoadPlacement,
} from "@brr/domain";
import { PLATE_LDU, STUD_LDU, ZETA16_ORDER, chunkOf, pose16, zeta16 } from "@brr/math";
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
import { dumpPlacements, type PlacementDump } from "../scene/placements.ts";
import { ColorTable, ldrawColorsSrgb, type ModelCredit } from "../scene/viewer-scene.ts";
import { OrbitCamera } from "./orbit-camera.ts";
import {
  TRACK_SYSTEM,
  TrackDrawing,
  type PieceSnap,
  type SwitchLeverView,
  type TrackDragView,
  type TrackGapView,
} from "./track-drawing.ts";
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
export type EditAction = EditKind | "track";
export type EditorMode = "place" | "select" | "track";

export interface CatalogColorView {
  readonly code: number;
  readonly name: string;
  readonly rgb: string;
}

export interface CatalogPartView {
  readonly id: string;
  readonly title: string;
}

export interface CatalogItemView {
  readonly id: string;
  readonly label: string;
  readonly group: string;
  readonly groupLabel: string;
  readonly color: CatalogColorView | null;
  readonly kind: Placeable["kind"] | "track";
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

export interface SkippedCatalogModel {
  readonly name: string;
  readonly reason: string;
}

interface SkippedModel extends SkippedCatalogModel {
  readonly credit: ModelCredit;
}

interface LoadedCatalog {
  readonly placeables: ReadonlyArray<Placeable>;
  readonly skipped: ReadonlyArray<SkippedModel>;
}

export interface TrackBomLine {
  readonly piece: string;
  readonly title: string;
  readonly count: number;
}

export interface TrackSolveStats {
  readonly samples: number;
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
}

export type TrackCommitResult =
  | "laid"
  | "joined"
  | "refused-impossible"
  | "refused-limit"
  | "switch-straight"
  | "switch-branching";

export interface TrackPieceView {
  readonly item: string;
  readonly label: string;
  readonly snapped: boolean;
  readonly joins: number;
  readonly misses: number;
  readonly connector: number;
  readonly connectors: number;
  readonly mirror: string | null;
}

export interface TrackView {
  readonly pieces: number;
  readonly bom: ReadonlyArray<TrackBomLine>;
  readonly openEnds: number;
  readonly joins: number;
  readonly coincidentEndIssues: number;
  readonly gaps: ReadonlyArray<TrackGapView>;
  readonly switches: ReadonlyArray<SwitchLeverView>;
  readonly held: TrackPieceView | null;
  readonly drag: TrackDragView | null;
  readonly lastCommit: TrackCommitResult | null;
  readonly solve: TrackSolveStats | null;
}

export interface EditorSnapshot {
  readonly status: EditorStatus;
  readonly error: string | null;
  readonly loadMs: number | null;
  readonly backend: BackendInfo | null;
  readonly catalog: ReadonlyArray<CatalogItemView>;
  readonly catalogSkipped: ReadonlyArray<SkippedCatalogModel>;
  readonly trackNotDrawable: ReadonlyArray<CatalogPartView>;
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
  readonly track: TrackView | null;
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
  readonly trackEnds: ReturnType<TrackDrawing["openEnds"]>;
  readonly frameShifts: ReadonlyArray<readonly [number, number, number]>;
  readonly placements: PlacementDump;
  readonly roadPlacements: ReadonlyArray<RoadPlacementDump>;
  readonly roads: RoadJoinReport;
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
  dragStart(ndcX: number, ndcY: number): boolean;
  dragMove(ndcX: number, ndcY: number): void;
  dragEnd(ndcX: number, ndcY: number, eventTimeMs: number): void;
  rotate(eventTimeMs: number): void;
  mirrorPiece(): void;
  cycleConnector(): void;
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
const NO_LATTICE_REASON = "no stud lattice from the bake";
export const TRACK_ITEM_ID = `track:${TRACK_SYSTEM}`;
export const TRACK_PIECE_PREFIX = "track-piece:";
const TRACK_PIECE_GROUP = "track-pieces";
const TRACK_PIECE_GROUP_LABEL = "Track pieces";
const TRACK_ITEM_LABEL = "Track: 9V straights and R40 curves";
const TRACK_HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const P95 = 0.95;
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

interface HeldPiece {
  readonly catalogIndex: number;
  readonly connector: number;
  readonly heading: number;
  readonly snap: PieceSnap | null;
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

function footprintArea(part: PartAsset): number {
  return (part.boundsMax[0] - part.boundsMin[0]) * (part.boundsMax[2] - part.boundsMin[2]);
}

function colorOf(colors: ReadonlyArray<BundleColor>, code: number): BundleColor {
  const color = colors.find((c) => c.code === code);
  if (!color) throw new Error(`LDConfig has no colour ${code}`);
  return color;
}

function catalogItem(placeable: Placeable, colors: ReadonlyArray<BundleColor>): CatalogItemView {
  const colored = placeable.kind === "baseplate" || placeable.kind === "road-plate";
  return {
    id: placeable.id,
    label: placeable.label,
    group: placeable.group,
    groupLabel: placeable.groupLabel,
    color: colored ? colorOf(colors, placeable.worldColor) : null,
    kind: placeable.kind,
    parts: placeable.parts.count,
    studsWide: Math.round((placeable.box.max[0] - placeable.box.min[0]) / STUD_LDU),
    studsDeep: Math.round((placeable.box.max[2] - placeable.box.min[2]) / STUD_LDU),
  };
}

function undrawableTrack(
  bundleParts: ReadonlyArray<PartAsset>,
  track: TrackDrawing,
  parts: ReadonlyArray<PartAsset>,
): ReadonlyArray<CatalogPartView> {
  const drawable = new Set(track.pieceParts().map((kit) => parts[kit.partIndex]?.id));
  return bundleParts
    .filter((part) => part.role === "track" && !drawable.has(part.id))
    .map((part) => ({ id: part.id.replace("ldraw:", ""), title: part.title }));
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
    catalogSkipped: [],
    trackNotDrawable: [],
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
    track: null,
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
  private placeables: ReadonlyArray<Placeable> = [];
  private placed: PlacedChunks;
  private active: Placeable | null = null;
  private selected: PlacedModel | null = null;
  private ghostRot = 0;
  private hoverX = 0;
  private hoverZ = 0;
  private hovering = false;
  private hitX = 0;
  private hitZ = 0;
  private track: TrackDrawing | null = null;
  private lastTrackCommit: TrackCommitResult | null = null;
  private trackEndTarget = "";
  private held: HeldPiece | null = null;
  private pending: PendingAction | null = null;
  private roadModels: ReadonlyArray<PlacedModel> = [];
  private roadExtents: ReadonlyArray<CellExtent> = [];
  private roadNetwork = new RoadNetwork([]);
  private roadReport: RoadJoinReport = new RoadNetwork([]).report();
  private canvas: HTMLCanvasElement | null = null;
  private framesSinceStats = 0;
  private statsSince = 0;

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
        (part) => part.role === "ground" || part.role === "road" || part.role === "track",
      );
      const colors = new ColorTable(bundle);
      const palette = new MergedParts(bundle.parts);
      const { placeables, skipped } = await this.loadPlaceables(bundle, palette, colors);
      this.placeables = placeables;
      this.plans.setTableTopY(this.baseplateBottomY());
      this.track = new TrackDrawing(bundle.trackCatalog, palette.parts, colors);
      this.backend.setPalette({
        detailed: { parts: palette.parts, studPrimitives: bundle.studPrimitives },
        colorsSrgb: colors.toSrgb(),
        ldrawColorsSrgb: ldrawColorsSrgb(bundle),
      });
      this.update({
        status: "ready",
        loadMs: performance.now() - started,
        backend,
        catalog: [
          ...this.placeables.map((placeable) => catalogItem(placeable, bundle.colors)),
          this.trackItem(this.track, palette.parts),
          ...this.trackPieceItems(this.track, palette.parts),
        ],
        catalogSkipped: skipped.map(({ name, reason }) => ({ name, reason })),
        trackNotDrawable: undrawableTrack(bundle.parts, this.track, palette.parts),
        track: this.trackView(),
        credits: {
          partFiles: bundle.credits.length,
          partFilesLod: EDITOR_LOD,
          models: [
            ...this.placeables.flatMap((p) => (p.credit ? [p.credit] : [])),
            ...skipped.map(({ credit }) => credit),
          ],
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
    if (!baseplate) throw new Error("the bundle has no baseplate");
    return baseplate.box.min[1];
  }

  private syncPlan(): void {
    this.plans.setPlacements([
      ...this.placed.models().map((model) => ({
        key: { chunkKey: model.handle.chunkKey, slot: model.handle.slot },
        ref: model.placeable.id,
        label: `${model.placeable.label} at ${model.handle.x}, ${model.handle.z}`,
        box: model.box,
      })),
      ...(this.track?.planFootprints() ?? []),
    ]);
  }

  private async loadPlaceables(
    bundle: PartBundle,
    palette: MergedParts,
    colors: ColorTable,
  ): Promise<LoadedCatalog> {
    const groundParts = bundle.parts
      .filter((part) => part.role === "ground")
      .toSorted((a, b) => footprintArea(b) - footprintArea(a));
    const roadParts = bundle.parts.filter((part) => part.role === "road");
    const placeableModels = [
      ...bundle.models.filter((entry) => entry.role === "mils-module"),
      ...bundle.models.filter((entry) => entry.origin === "omr"),
    ];
    const loaded = await Promise.all(
      placeableModels.map((entry) => this.loader.loadModel(EDITOR_LOD, entry.name)),
    );
    const placeables: Placeable[] = [...groundParts, ...roadParts].flatMap((part) => {
      if (part.producedColors.length === 0) {
        throw new Error(`${part.id} has no produced colour in the bundle`);
      }
      return part.producedColors.map((code) =>
        partPlaceable(
          part,
          palette.indexOf(part.id),
          code,
          colorOf(bundle.colors, code).name,
          palette.parts,
          colors,
        ),
      );
    });
    const skipped: SkippedModel[] = [];
    for (const { bundle: modelBundle, entry, model } of loaded) {
      const credit = { name: entry.name, source: entry.source, sections: model.sections };
      if (model.lattice === null) {
        skipped.push({ name: entry.name, reason: NO_LATTICE_REASON, credit });
        continue;
      }
      placeables.push(
        modelPlaceable(
          entry.name,
          entry.role === "mils-module" ? (model.sections[0]?.title ?? entry.name) : entry.name,
          entry.role,
          palette.remap(model, modelBundle.parts),
          credit,
          palette.parts,
          colors,
        ),
      );
    }
    return { placeables, skipped };
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

  private trackItem(track: TrackDrawing, parts: ReadonlyArray<PartAsset>): CatalogItemView {
    const straight = track.kitParts().find((k) => k.piece.kind === "straight");
    const part = straight ? parts[straight.partIndex] : undefined;
    return {
      id: TRACK_ITEM_ID,
      label: TRACK_ITEM_LABEL,
      group: TRACK_ITEM_ID,
      groupLabel: TRACK_ITEM_LABEL,
      color: null,
      kind: "track",
      parts: track.kitParts().length,
      studsWide: part ? Math.round((part.boundsMax[0] - part.boundsMin[0]) / STUD_LDU) : 0,
      studsDeep: part ? Math.round((part.boundsMax[2] - part.boundsMin[2]) / STUD_LDU) : 0,
    };
  }

  private trackPieceItems(
    track: TrackDrawing,
    parts: ReadonlyArray<PartAsset>,
  ): ReadonlyArray<CatalogItemView> {
    return track.pieceSet.palette().map((catalogIndex) => {
      const kit = track.pieceByIndex(catalogIndex);
      const part = parts[kit.partIndex];
      const { element, title } = track.pieceSet.element(catalogIndex);
      return {
        id: `${TRACK_PIECE_PREFIX}${kit.piece.id}`,
        label: `${element.replace(/^[a-z]+:/u, "")} ${title}`,
        group: TRACK_PIECE_GROUP,
        groupLabel: TRACK_PIECE_GROUP_LABEL,
        color: null,
        kind: "track",
        parts: 1,
        studsWide: part ? Math.round((part.boundsMax[0] - part.boundsMin[0]) / STUD_LDU) : 0,
        studsDeep: part ? Math.round((part.boundsMax[2] - part.boundsMin[2]) / STUD_LDU) : 0,
      };
    });
  }

  private bomLines(track: TrackDrawing): ReadonlyArray<TrackBomLine> {
    const lines = new Map<string, TrackBomLine>();
    for (const kit of track.pieceParts()) {
      const { element, title } = track.pieceSet.element(kit.catalogIndex);
      const count = track.countOf(kit.catalogIndex);
      const line = lines.get(element);
      lines.set(element, { piece: element, title, count: (line?.count ?? 0) + count });
    }
    return [...lines.values()].filter(
      (line) => line.count > 0 || track.kitParts().some((k) => k.piece.part === line.piece),
    );
  }

  private heldView(track: TrackDrawing): TrackPieceView | null {
    const held = this.held;
    if (!held) return null;
    const kit = track.pieceByIndex(held.catalogIndex);
    const { element, title } = track.pieceSet.element(held.catalogIndex);
    const mirror = track.pieceSet.mirrored(held.catalogIndex);
    const count = kit.def.connectors.length;
    return {
      item: kit.piece.id,
      label: `${element.replace(/^[a-z]+:/u, "")} ${title}`,
      snapped: held.snap?.end !== null && held.snap !== null,
      joins: held.snap?.joins ?? 0,
      misses: held.snap?.misses.length ?? 0,
      connector: ((held.connector % count) + count) % count,
      connectors: count,
      mirror: mirror === null ? null : track.pieceSet.element(mirror).title,
    };
  }

  private trackView(): TrackView | null {
    const track = this.track;
    if (!track) return null;
    const samples = track.solveSamplesMs.toSorted((a, b) => a - b);
    const at = (q: number): number =>
      samples[Math.min(samples.length - 1, Math.floor(q * samples.length))] ?? 0;
    return {
      pieces: track.pieceCount,
      bom: this.bomLines(track),
      openEnds: track.openEnds().length,
      joins: track.joinedPairs(),
      coincidentEndIssues: track.coincidentEndIssues(),
      gaps: track.gaps(),
      switches: track.switchLevers(),
      held: this.heldView(track),
      drag: track.dragView(),
      lastCommit: this.lastTrackCommit,
      solve:
        samples.length === 0
          ? null
          : {
              samples: samples.length,
              medianMs: at(0.5),
              p95Ms: at(P95),
              maxMs: samples.at(-1) ?? 0,
            },
    };
  }

  private showTrackEnds(target: number | null, misses: ReadonlyArray<number> = []): void {
    const track = this.track;
    if (!track) return;
    this.trackEndTarget = `${target}|${misses.join(",")}`;
    const gapped = track.gappedEnds();
    this.backend.setTrackEnds(
      track.openEnds().map((end, index) => ({
        xLdu: end.xLdu,
        yLdu: 0,
        zLdu: end.zLdu,
        headingRadians: end.heading * TRACK_HEADING_RADIANS,
        kind:
          index === target
            ? "target"
            : gapped.has(index) || misses.includes(index)
              ? "gap"
              : "open",
      })),
    );
  }

  private targetTrackEnd(target: number | null, misses: ReadonlyArray<number> = []): void {
    if (`${target}|${misses.join(",")}` !== this.trackEndTarget) this.showTrackEnds(target, misses);
  }

  private showTrackGhost(track: TrackDrawing): void {
    const ghost = track.ghost();
    this.backend.setGhost(ghost ? ghost.instances : null);
    if (ghost) this.backend.placeGhost(ghost.x, 0, ghost.z, 0);
  }

  dragStart(ndcX: number, ndcY: number): boolean {
    const track = this.track;
    if (this.state.mode !== "track" || !track || this.held) return false;
    if (!this.groundHit(ndcX, ndcY)) return false;
    track.beginDrag(this.hitX, this.hitZ, this.hoverX, this.hoverZ);
    this.update({ track: this.trackView() });
    return true;
  }

  dragMove(ndcX: number, ndcY: number): void {
    const track = this.track;
    if (!track || !this.groundHit(ndcX, ndcY)) return;
    track.moveDrag(this.hitX, this.hitZ);
    this.showTrackGhost(track);
    this.targetTrackEnd(track.dragTargetEnd());
    this.update({ track: this.trackView() });
  }

  dragEnd(ndcX: number, ndcY: number, eventTimeMs: number): void {
    const track = this.track;
    if (!track) return;
    const hit = this.groundHit(ndcX, ndcY);
    if (hit) track.moveDrag(this.hitX, this.hitZ);
    const stayed = (track.dragView()?.pieces ?? 0) === 0;
    const commit = track.endDrag();
    if (hit && stayed && this.throwSwitchAt(this.hitX, this.hitZ, eventTimeMs)) {
      this.backend.setGhost(null);
      this.showTrackEnds(null);
      return;
    }
    this.backend.setGhost(null);
    this.showTrackEnds(null);
    let instances = 0;
    let studs = 0;
    for (const key of commit.chunks) {
      const chunk = track.chunkInstances(key);
      if (!chunk) continue;
      this.backend.setChunk(key, chunk);
      instances += chunk.count;
      studs += chunk.studs.count;
    }
    if (commit.laid > 0) {
      this.pending = {
        step: "do",
        action: "track",
        item: TRACK_ITEM_ID,
        rot: 0,
        x: this.hoverX,
        z: this.hoverZ,
        startMs: eventTimeMs,
        rebuiltMs: performance.now(),
        report: { chunks: commit.chunks.length, instances, studs },
      };
    }
    if (commit.laid > 0) this.syncPlan();
    if (commit.refusal) this.lastTrackCommit = `refused-${commit.refusal}`;
    else if (commit.laid > 0) this.lastTrackCommit = commit.joined ? "joined" : "laid";
    this.update({ track: this.trackView() });
  }

  chooseItem(id: string | null): void {
    const track = this.track;
    const pieceIndex = id === null || !track ? null : this.trackPieceIndex(track, id);
    if ((id === TRACK_ITEM_ID || pieceIndex !== null) && track) {
      this.active = null;
      track.cancelDrag();
      this.held =
        pieceIndex === null
          ? null
          : { catalogIndex: pieceIndex, connector: 0, heading: 0, snap: null };
      this.backend.setGhost(null);
      this.select(null);
      this.update({ mode: "track", activeItem: id, track: this.trackView() });
      this.showHeldPiece();
      return;
    }
    if (this.state.mode === "track") {
      this.held = null;
      this.track?.cancelDrag();
      this.backend.setGhost(null);
      this.targetTrackEnd(null);
      this.update({ mode: "select", activeItem: null, track: this.trackView() });
      if (id === null) return;
    }
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

  private trackPieceIndex(track: TrackDrawing, id: string): number | null {
    if (!id.startsWith(TRACK_PIECE_PREFIX)) return null;
    const pieceId = id.slice(TRACK_PIECE_PREFIX.length);
    const kit = track.pieceParts().find((part) => part.piece.id === pieceId);
    return kit ? kit.catalogIndex : null;
  }

  private showHeldPiece(): void {
    const track = this.track;
    const held = this.held;
    if (!track || !held) return;
    if (!this.hovering) {
      this.backend.setGhost(null);
      return;
    }
    const free = pose16(
      zeta16([
        BigInt(this.hoverX / STUD_LDU),
        0n,
        0n,
        0n,
        BigInt(this.hoverZ / STUD_LDU),
        0n,
        0n,
        0n,
      ]),
      held.heading,
    );
    const snap = track.snapPiece(held.catalogIndex, held.connector, this.hitX, this.hitZ, free);
    this.held = { ...held, snap };
    const ghost = track.pieceGhost(held.catalogIndex, snap.placement);
    this.backend.setGhost(ghost.instances);
    this.backend.placeGhost(ghost.x, 0, ghost.z, 0);
    this.targetTrackEnd(snap.end, snap.misses);
    this.update({ track: this.trackView() });
  }

  private placeHeldPiece(eventTimeMs: number): void {
    const track = this.track;
    const held = this.held;
    const snap = held?.snap;
    if (!track || !held || !snap) return;
    const commit = track.placePiece(held.catalogIndex, snap.placement);
    const report = this.rebuildTrackChunks(track, commit.chunks);
    this.pending = {
      step: "do",
      action: "track",
      item: `${TRACK_PIECE_PREFIX}${track.pieceByIndex(held.catalogIndex).piece.id}`,
      rot: held.heading,
      x: this.hoverX,
      z: this.hoverZ,
      startMs: eventTimeMs,
      rebuiltMs: performance.now(),
      report,
    };
    this.syncPlan();
    this.lastTrackCommit = commit.joined ? "joined" : "laid";
    this.held = { ...held, snap: null };
    this.showTrackEnds(null);
    this.showHeldPiece();
    this.update({ track: this.trackView() });
  }

  private rebuildTrackChunks(track: TrackDrawing, chunks: ReadonlyArray<number>): RebuildReport {
    let instances = 0;
    let studs = 0;
    for (const key of chunks) {
      const chunk = track.chunkInstances(key);
      if (!chunk) continue;
      this.backend.setChunk(key, chunk);
      instances += chunk.count;
      studs += chunk.studs.count;
    }
    return { chunks: chunks.length, instances, studs };
  }

  private throwSwitchAt(xLdu: number, zLdu: number, eventTimeMs: number): boolean {
    const track = this.track;
    if (!track) return false;
    const placement = track.switchAt(xLdu, zLdu);
    if (placement === null) return false;
    const thrown = track.throwSwitch(placement);
    if (!thrown) return false;
    const report = this.rebuildTrackChunks(track, [thrown.chunk]);
    this.pending = {
      step: "do",
      action: "track",
      item: `switch #${placement + 1}`,
      rot: 0,
      x: Math.round(xLdu),
      z: Math.round(zLdu),
      startMs: eventTimeMs,
      rebuiltMs: performance.now(),
      report,
    };
    this.syncPlan();
    this.lastTrackCommit = thrown.lever === "straight" ? "switch-straight" : "switch-branching";
    this.update({ track: this.trackView() });
    return true;
  }

  cycleConnector(): void {
    const held = this.held;
    if (!held) return;
    this.held = { ...held, connector: held.connector + 1 };
    this.showHeldPiece();
  }

  mirrorPiece(): void {
    const track = this.track;
    const held = this.held;
    if (!track || !held) return;
    const mirror = track.pieceSet.mirrored(held.catalogIndex);
    if (mirror === null) return;
    this.held = { ...held, catalogIndex: mirror };
    this.update({ activeItem: `${TRACK_PIECE_PREFIX}${track.pieceByIndex(mirror).piece.id}` });
    this.showHeldPiece();
  }

  private groundHit(ndcX: number, ndcY: number): boolean {
    this.backend.rayThrough(ndcX, ndcY, this.ray);
    const originY = this.ray[1] ?? 0;
    const directionY = this.ray[4] ?? 0;
    if (directionY >= 0) return false;
    const t = -originY / directionY;
    this.hitX = (this.ray[0] ?? 0) + (this.ray[3] ?? 0) * t;
    this.hitZ = (this.ray[2] ?? 0) + (this.ray[5] ?? 0) * t;
    this.hoverX = snapToLattice(this.hitX);
    this.hoverZ = snapToLattice(this.hitZ);
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
    const track = this.track;
    if (this.held) this.showHeldPiece();
    else if (this.state.mode === "track" && track && !track.dragView()) {
      this.targetTrackEnd(this.hovering ? track.endNear(this.hitX, this.hitZ, null) : null);
    }
    this.placeGhost();
    this.update({ hover: this.hovering ? { x: this.hoverX, z: this.hoverZ } : null, snap });
  }

  pointerLeave(): void {
    this.hovering = false;
    this.update({ hover: null });
  }

  click(ndcX: number, ndcY: number, eventTimeMs: number): void {
    if (this.state.mode === "track") {
      if (!this.held || !this.groundHit(ndcX, ndcY)) return;
      this.hovering = true;
      this.showHeldPiece();
      this.placeHeldPiece(eventTimeMs);
      return;
    }
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
    if (
      !best &&
      this.groundHit(ndcX, ndcY) &&
      this.throwSwitchAt(this.hitX, this.hitZ, eventTimeMs)
    ) {
      return;
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
    const held = this.held;
    if (held) {
      this.held =
        held.snap?.end === null || !held.snap
          ? { ...held, heading: (held.heading + 1) % ZETA16_ORDER }
          : { ...held, connector: held.connector + 1 };
      this.showHeldPiece();
      return;
    }
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
      trackEnds: this.track?.openEnds() ?? [],
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

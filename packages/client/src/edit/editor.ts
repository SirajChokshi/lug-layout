import type { BundleLod, TrackCatalog } from "@brr/schema/bundle";
import {
  PART_BUNDLE_LOADER,
  type IPartBundleLoader,
  type ModelCells,
  type PartAsset,
  type PartModelLattice,
  type PartShapeAsset,
} from "@brr/catalog";
import { NO_MESHES, type MeshProgress } from "./mesh-progress.ts";
import {
  BomCounter,
  WORLD_TRACK_FRAME,
  countPlacements,
  EditHistory,
  RoadNetwork,
  World,
  addShards,
  type AppliedEdit,
  type EditKind,
  type HistoryStep,
  type PlacementHandle,
  type PlacementContents,
  type RoadEdgeSegment,
  type RoadJoinReport,
  type RoadPlacement,
  type ModelConnectors,
} from "@brr/domain";
import {
  BRICK_LDU,
  CHUNK_LDU,
  PLATE_LDU,
  QUARTER_TURN_16,
  STUD_LDU,
  ZETA16_ORDER,
  pose16,
  zeta16,
} from "@brr/math";
import {
  RAY_FLOATS,
  SCENE_BACKEND,
  PROJECTION_FLOATS,
  type BackendInfo,
  type EdgeMarker,
  type ChunkTier,
  type GraphicsApi,
  type LookSettings,
  type ISceneBackend,
  type WorldBox,
} from "@brr/render";
import type { Decoded, Issue } from "@brr/schema/decode";
import type { ImportReport, StudioReport } from "@brr/import";
import { importRef, worldTrack, type ImportedFile, type WorldShardV1 } from "@brr/schema/world";
import { inject, injectable } from "inversify";
import {
  notDrawnItems,
  type BomInput,
  type BomScope,
  type IBomSource,
} from "../bom/bom-service.ts";
import { dumpPlacements, type PlacementDump } from "../scene/placements.ts";
import type { ModelCredit } from "../scene/viewer-scene.ts";
import {
  EDITOR_FRAME_LOOP,
  PLACEABLE_CATALOG,
  PLACEMENT_SEARCH,
  WORLD_SESSION,
} from "../tokens.ts";
import type { FrameLoopView, FrameTimes, IEditorFrameLoop } from "./editor-frame-loop.ts";
import {
  colorOf,
  type CatalogItemView,
  type CheckedStuds,
  type IPlaceableCatalog,
  type SkippedCatalogModel,
} from "../catalog/placeable-catalog.ts";
import {
  heldPieces,
  heldRuns,
  latticeFrame,
  modelTrackEnds,
  type FramedTrackPiece,
  type ModelTrackEnds,
} from "../connect/model-track-ends.ts";
import { partBoxes, type PartBoxes } from "../connect/part-boxes.ts";
import { FrozenTechnic } from "../connect/frozen-technic.ts";
import { FrozenVolumes } from "../connect/placeable-volumes.ts";
import type { IPlacementSearch } from "../connect/placement-search.ts";
import {
  TRACK_SYSTEM,
  TrackDrawing,
  type PieceSnap,
  type SwitchLeverView,
  type TrackDragView,
  type TrackGapView,
  type TrackRouteView,
} from "./track-drawing.ts";
import {
  PlacedChunks,
  posedBox,
  type PlacedModel,
  type RebuildReport,
  type StudTotals,
  type ViewUpdate,
} from "./placed-chunks.ts";
import type { Placeable } from "./placeable.ts";
import { seatsPending, trackObstacleRects } from "./track-obstacles.ts";
import { cellExtent, snapToRoadEdge, type CellExtent } from "./road-snap.ts";
import { quarterTurned, type TurnDirection } from "./turn.ts";
import {
  ROAD_KIT_PREFIX,
  RoadDrawing,
  type RoadKitView,
  type RoadPreview,
  type RoadStrokeView,
} from "./road-drawing.ts";
import { EDITOR_CAMERA, PLAN_SERVICE } from "../tokens.ts";
import type { IPlanService, PlacedForPlan } from "../plan/plan-service.ts";
import type { IEditorCamera } from "../camera/editor-camera.ts";
import type { PlayModel, PlaySetup } from "../play/play-models.ts";
import { errorText } from "./error-text.ts";
import { GRID_STEPS_LDU, boxLabel, type LabelView } from "./layout-guides.ts";
import { MeasureTool } from "./measure-tool.ts";
import type {
  ExportedWorld,
  IEditedWorld,
  IWorldFiles,
  IWorldSession,
  ModelFileInput,
  WorldContents,
  WorldSessionView,
} from "./world-session.ts";

export type { TurnDirection } from "./turn.ts";
export type EditorStatus = "loading" | "ready" | "error";
export type EditAction = EditKind | "track";
export type EditorMode = "place" | "select" | "track" | "road" | "measure";
export interface RoadStrokeResult {
  readonly result: "laid" | "refused";
  readonly stroke: RoadStrokeView;
}

export interface CatalogPartView {
  readonly id: string;
  readonly title: string;
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
  readonly joinedRoadCells: number;
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
  readonly reason: string;
}

export type FarTierStatus = "loading" | "ready" | "unavailable";

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
  | "refused-blocked"
  | "refused-limit"
  | "refused-pending"
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
  readonly modelPieces: number;
  readonly runFramePieces: number;
  readonly offField: number;
  readonly unanchored: number;
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

export interface HoverView {
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly refusal: string | null;
}

export interface PlaceableCoverView {
  readonly id: string;
  readonly studsDrawnPerPlacement: number;
  readonly studsPending: boolean;
  readonly studsCulledAtBake: number | null;
  readonly footprintCells: number;
  readonly flatCells: number;
  readonly heightPlates: number;
}

export type ModelImportStatus = "importing" | "checking" | "placeable" | "check-failed" | "refused";

export interface ModelImportView {
  readonly file: string;
  readonly status: ModelImportStatus;
  readonly item: string | null;
  readonly reason: string | null;
  readonly report: ImportReport | null;
  readonly studio: StudioReport | null;
}

export interface EditorSnapshot extends WorldSessionView, FrameLoopView {
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
  readonly hover: HoverView | null;
  readonly selection: SelectionView | null;
  readonly selectionRefusal: string | null;
  readonly placements: number;
  readonly history: HistoryView;
  readonly lastLatency: LatencySample | null;
  readonly latencies: ReadonlyArray<LatencySample>;
  readonly studs: StudTotals | null;
  readonly farTier: FarTierStatus;
  readonly farTierError: string | null;
  readonly pendingItem: string | null;
  readonly meshes: MeshProgress;
  readonly credits: EditorCredits | null;
  readonly roads: RoadJoinView;
  readonly showJoins: boolean;
  readonly snapRoads: boolean;
  readonly snap: RoadSnapView | null;
  readonly refusedClicks: number;
  readonly lastRefusal: RefusedClick | null;
  readonly track: TrackView | null;
  readonly bundleVersion: string | null;
  readonly catalogError: string | null;
  readonly roadKits: ReadonlyArray<RoadKitView>;
  readonly roadKit: string | null;
  readonly roadStroke: RoadStrokeView | null;
  readonly lastRoadStroke: RoadStrokeResult | null;
  readonly roadErase: boolean;
  readonly modelImport: ModelImportView | null;
  readonly studChecks: number;
  readonly gridShown: boolean;
  readonly planCoversGround: boolean;
  readonly rulers: number;
  readonly rulerDraft: boolean;
  readonly labels: ReadonlyArray<LabelView>;
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

export interface ModelBakeView {
  readonly id: string;
  readonly lattice: PartModelLattice;
  readonly cells: Omit<ModelCells, "footprint" | "flat" | "columnBottom" | "columnTop"> & {
    readonly footprint: ReadonlyArray<number>;
    readonly flat: ReadonlyArray<number>;
    readonly columnBottom: ReadonlyArray<number>;
    readonly columnTop: ReadonlyArray<number>;
  };
}

export interface EditorDump {
  readonly refs: ReadonlyArray<string>;
  readonly chunkCounts: ReadonlyArray<readonly [number, number, number]>;
  readonly trackEnds: ReturnType<TrackDrawing["openEnds"]>;
  readonly frameShifts: ReadonlyArray<readonly [number, number, number]>;
  readonly covers: ReadonlyArray<PlaceableCoverView>;
  readonly bakes: ReadonlyArray<ModelBakeView>;
  readonly placements: PlacementDump;
  readonly roadPlacements: ReadonlyArray<RoadPlacementDump>;
  readonly roads: RoadJoinReport;
  readonly studs: StudTotals;
  readonly studChecks: number;
}

export interface EditorOptions {
  readonly api: GraphicsApi;
  readonly pixelRatio: number;
  readonly look: LookSettings;
  readonly tier: ChunkTier | null;
}

export interface IEditor extends IBomSource, IWorldFiles {
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
  rotate(eventTimeMs: number, direction?: TurnDirection): void;
  mirrorPiece(): void;
  cycleConnector(): void;
  deleteSelection(eventTimeMs: number): void;
  undo(eventTimeMs: number): void;
  redo(eventTimeMs: number): void;
  setShowJoins(show: boolean): void;
  setSnapRoads(snap: boolean): void;
  goTo(x: number, z: number): void;
  importModelFile(file: ModelFileInput): Promise<boolean>;
  measureFrames(): void;
  cycleTier(): void;
  trackRoutes(): ReadonlyArray<TrackRouteView>;
  setRoadErase(erase: boolean): void;
  setGridShown(shown: boolean): void;
  setMeasuring(on: boolean): void;
  clearRulers(): void;
  projectLabels(out: Float64Array): void;
  playSetup(): PlaySetup | null;
  dump(): EditorDump;
}

interface Connected {
  readonly model: ModelConnectors;
  readonly volumes: FrozenVolumes;
  readonly boxes: PartBoxes;
  readonly technic: FrozenTechnic;
}

const EDITOR_LOD: BundleLod = "standard";
export const TRACK_ITEM_ID = `track:${TRACK_SYSTEM}`;
export const TRACK_PIECE_PREFIX = "track-piece:";
const TRACK_PIECE_GROUP = "track-pieces";
const TRACK_PIECE_GROUP_LABEL = "Track pieces";
const TRACK_ITEM_LABEL = "Track: 9V straights and R40 curves";
const TRACK_SHORT_LABEL = "Track";
const TRACK_HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const P95 = 0.95;
const DEGREES_PER_QUARTER_TURN = 90;
const ROAD_REFUSAL = "its road edges would mismatch or overlap placed road pieces";
interface RoadCellCounts {
  readonly mismatchedCells: number;
  readonly overlappingCells: number;
}
const NO_ROAD_CELLS: RoadCellCounts = { mismatchedCells: 0, overlappingCells: 0 };

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
const GHOST_LIFT_LDU = BRICK_LDU;

interface HeldPiece {
  readonly catalogIndex: number;
  readonly connector: number;
  readonly heading: number;
  readonly snap: PieceSnap | null;
}

const EDITOR_WORLD_NAME = "editor-world";
const FILE_NAME_UNSAFE = /[^A-Za-z0-9.-]+/gu;

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

interface RestoredWorld {
  readonly world: World;
  readonly handles: ReadonlyArray<PlacementHandle>;
  readonly track: TrackDrawing | null;
}

function sameModels(a: ReadonlyArray<PlacedModel>, b: ReadonlyArray<PlacedModel>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function snapToLattice(ldu: number): number {
  return Math.round(ldu / STUD_LDU) * STUD_LDU + 0;
}

function sameHover(a: HoverView | null, b: HoverView | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.z === b.z && a.yPlates === b.yPlates;
}

function labelsNeedUpdate(previous: EditorSnapshot, next: EditorSnapshot): boolean {
  if (next.mode !== previous.mode || next.selection !== previous.selection) return true;
  return (
    next.mode === "place" &&
    (!sameHover(next.hover, previous.hover) ||
      next.ghostRot !== previous.ghostRot ||
      next.activeItem !== previous.activeItem)
  );
}

function undrawableTrack(
  track: TrackDrawing,
  parts: ReadonlyArray<PartAsset>,
): ReadonlyArray<CatalogPartView> {
  const drawable = new Set(track.pieceParts().map((kit) => parts[kit.partIndex]?.id));
  return parts
    .filter((part) => part.role === "track" && !drawable.has(part.id))
    .map((part) => ({ id: part.id.replace("ldraw:", ""), title: part.title }));
}

@injectable()
export class Editor implements IEditor, IEditedWorld {
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
    selectionRefusal: null,
    placements: 0,
    history: { undo: null, redo: null, undoDepth: 0, redoDepth: 0 },
    lastLatency: null,
    latencies: [],
    stats: null,
    studs: null,
    tier: null,
    farTier: "loading",
    farTierError: null,
    pendingItem: null,
    meshes: { detailedPartMeshes: NO_MESHES, farPartMeshes: NO_MESHES, farModelMeshes: NO_MESHES },
    measuring: false,
    measurement: null,
    credits: null,
    roads: EMPTY_ROADS,
    showJoins: true,
    snapRoads: true,
    snap: null,
    refusedClicks: 0,
    lastRefusal: null,
    track: null,
    bundleVersion: null,
    world: null,
    worlds: [],
    fileError: null,
    storageError: null,
    readOnly: false,
    unsavedEdits: false,
    catalogError: null,
    coldStartMs: null,
    roadKits: [],
    roadKit: null,
    roadStroke: null,
    lastRoadStroke: null,
    roadErase: false,
    modelImport: null,
    studChecks: 0,
    gridShown: true,
    planCoversGround: false,
    rulers: 0,
    rulerDraft: false,
    labels: [],
  };
  private world = new World();
  private history = new EditHistory(this.world);
  private readonly ray = new Float64Array(RAY_FLOATS);
  private catalogItems: ReadonlyArray<CatalogItemView> = [];
  private bundleColorCodes: ReadonlyArray<number> | null = null;
  private placed: PlacedChunks;
  private active: Placeable | null = null;
  private activeRefId = -1;
  private selected: PlacedModel | null = null;
  private ghostRot = 0;
  private placeRot = 0;
  private turnDirection: TurnDirection = 1;
  private hoverX = 0;
  private hoverZ = 0;
  private hoverYPlates = 0;
  private hoverRefusal: string | null = null;
  private hovering = false;
  private hitX = 0;
  private hitZ = 0;
  private track: TrackDrawing | null = null;
  private trackCatalog: TrackCatalog | null = null;
  private readonly modelTrack = new Map<Placeable, ModelTrackEnds>();
  private heldTrackModels: ReadonlyArray<PlacedModel> = [];
  private readonly searchIds = new Map<PlacedModel, number>();
  private readonly searchModels = new Map<number, PlacedModel>();
  private readonly connected = new Map<Placeable, Connected>();
  private readonly studChecks = new Set<Placeable>();
  private nextSearchId = 1;
  private newTrack: (() => TrackDrawing) | null = null;
  private roadDrawing: RoadDrawing | null = null;
  private roadPreviewMarkers: ReadonlyArray<EdgeMarker> = [];
  private placedTrains: ReadonlyArray<PlayModel> = [];
  private lastTrackCommit: TrackCommitResult | null = null;
  private trackEndTarget = "";
  private held: HeldPiece | null = null;
  private roadModels: ReadonlyArray<PlacedModel> = [];
  private roadExtents: ReadonlyArray<CellExtent> = [];
  private roadNetwork = new RoadNetwork([]);
  private roadReport: RoadJoinReport = new RoadNetwork([]).report();
  private tableTopY = 0;
  private measure: MeasureTool | null = null;
  private readonly planEntries = new WeakMap<PlacedModel, PlacedForPlan>();

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
    @inject(PLAN_SERVICE) private readonly plans: IPlanService,
    @inject(EDITOR_CAMERA) private readonly camera: IEditorCamera,
    @inject(WORLD_SESSION) private readonly session: IWorldSession,
    @inject(EDITOR_FRAME_LOOP) private readonly frames: IEditorFrameLoop,
    @inject(PLACEABLE_CATALOG) private readonly catalog: IPlaceableCatalog,
    @inject(PLACEMENT_SEARCH) private readonly search: IPlacementSearch,
  ) {
    this.placed = new PlacedChunks(backend);
    this.state = { ...this.state, ...session.view(), ...frames.view() };
    session.subscribe(() => this.sessionChanged());
    frames.subscribe(() => this.update(this.frames.view()));
    catalog.subscribe(() => this.update({ meshes: catalog.meshProgress() }));
    plans.subscribe(() => this.plansChanged());
  }

  private plansChanged(): void {
    const covers = this.plans.snapshot().plans.length > 0;
    if (covers === this.state.planCoversGround) return;
    this.update({ planCoversGround: covers });
    if (this.state.status === "ready") this.showGround();
  }

  private sessionChanged(): void {
    this.update(this.session.view());
    if (this.state.readOnly && (this.active || this.held || this.state.mode === "road")) {
      this.chooseItem(null);
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): EditorSnapshot {
    return this.state;
  }

  private update(patch: Partial<EditorSnapshot>): void {
    const next = { ...this.state, ...patch };
    this.state =
      patch.labels === undefined && labelsNeedUpdate(this.state, next)
        ? { ...next, labels: this.labelsOf(next) }
        : next;
    for (const listener of this.listeners) listener();
  }

  private labelsOf(state: EditorSnapshot): ReadonlyArray<LabelView> {
    const labels = [...(this.measure?.labels() ?? [])];
    const active = this.active;
    if (state.mode === "place" && active && state.hover) {
      const { x, z, yPlates } = state.hover;
      labels.push(
        boxLabel("ghost", "ghost", posedBox(active.box, x, z, yPlates * PLATE_LDU, state.ghostRot)),
      );
    }
    if (state.selection) labels.push(boxLabel("selection", "selection", state.selection.box));
    return labels;
  }

  async start(canvas: HTMLCanvasElement, options: EditorOptions): Promise<void> {
    try {
      const started = performance.now();
      const backend = await this.backend.init({
        canvas,
        api: options.api,
        pixelRatio: options.pixelRatio,
        antialias: true,
        look: options.look,
      });
      this.frames.forceTier(options.tier);
      const index = await this.loader.loadIndex(EDITOR_LOD);
      const catalog = await this.catalog.start(index);
      this.catalogItems = catalog.items;
      this.bundleColorCodes = index.colors.map((color) => color.code);
      this.tableTopY = -index.tablePlane.depthBelowTopLdu;
      this.plans.setTableTopY(this.tableTopY);
      this.measure = new MeasureTool(this.tableTopY);
      this.showGround();
      this.trackCatalog = index.trackCatalog;
      this.newTrack = () => new TrackDrawing(index, this.catalog.parts(), this.catalog.colors());
      this.track = this.newTrack();
      const parts = this.catalog.parts();
      const trackItems = [
        this.trackItem(this.track, parts),
        ...this.trackPieceItems(this.track, parts),
      ];
      const trackNotDrawable = undrawableTrack(this.track, parts);
      this.roadDrawing = new RoadDrawing(
        this.loadedPlaceables(),
        (placeable) =>
          `${colorOf(index.colors, placeable.worldColor).name.replaceAll("_", " ")} road plates`,
      );
      const loadMs = performance.now() - started;
      await this.session.start(this, index.bundleVersion);
      this.update({
        status: "ready",
        loadMs,
        bundleVersion: index.bundleVersion,
        backend,
        catalog: [...catalog.items, ...trackItems],
        catalogSkipped: catalog.skipped,
        trackNotDrawable,
        roadKits: this.roadDrawing.kitViews(),
        roadKit: this.roadDrawing.activeKit()?.id ?? null,
        track: this.trackView(),
        credits: { partFiles: 0, partFilesLod: EDITOR_LOD, models: catalog.credits },
      });
      this.frames.start(canvas, (error) => this.update({ status: "error", error: String(error) }));
      void this.startFarTier();
      void this.countCreditedFiles();
    } catch (error) {
      this.update({ status: "error", error: String(error) });
    }
  }

  private async startFarTier(): Promise<void> {
    try {
      await this.catalog.startFarTier();
      for (const model of this.placed.models()) this.requestFarModel(model.placeable);
      this.update({ farTier: "ready" });
    } catch (error) {
      this.update({ farTier: "unavailable", farTierError: errorText(error) });
    }
  }

  private requestFarModel(placeable: Placeable): void {
    void this.catalog.claimFarModel(placeable).then(
      (farModel) => {
        if (farModel !== null) this.placed.useFarModel(placeable, farModel);
      },
      (error: unknown) => this.update({ farTierError: errorText(error) }),
    );
  }

  private async countCreditedFiles(): Promise<void> {
    try {
      const manifest = await this.loader.loadManifest(EDITOR_LOD);
      const credits = this.state.credits;
      if (credits) this.update({ credits: { ...credits, partFiles: manifest.credits.length } });
    } catch (error) {
      this.update({ catalogError: `the part credits can't be loaded: ${errorText(error)}` });
    }
  }

  private loadedPlaceables(): ReadonlyArray<Placeable> {
    return this.catalog.placeables().filter((placeable) => placeable !== null);
  }

  async addImportedModel(file: ImportedFile): Promise<string | null> {
    const id = importRef(file.sha256);
    if (this.catalog.itemRefId(id) !== null) return id;
    const importing = {
      file: file.name,
      status: "importing",
      item: null,
      reason: null,
      report: null,
      studio: null,
    } as const;
    this.update({ modelImport: importing });
    const outcome = await this.catalog.addImported(file);
    switch (outcome.kind) {
      case "refused": {
        const reported = { ...importing, report: outcome.report, studio: outcome.studio };
        this.update({ modelImport: { ...reported, status: "refused", reason: outcome.refusal } });
        return null;
      }
      case "placeable": {
        const reported = { ...importing, report: outcome.report, studio: outcome.studio };
        this.addImportedItem(outcome.item, outcome.credit, {
          ...reported,
          status: "placeable",
          item: outcome.item.id,
        });
        return outcome.item.id;
      }
      case "checking": {
        this.studChecks.add(outcome.pending);
        this.addImportedItem(outcome.item, outcome.credit, {
          ...importing,
          status: "checking",
          item: outcome.item.id,
        });
        void outcome.checked.then((checked) => this.studsChecked(outcome.pending, checked));
        return outcome.item.id;
      }
      default: {
        const unhandled: never = outcome;
        throw new Error(`unhandled import outcome ${String(unhandled)}`);
      }
    }
  }

  private addImportedItem(
    item: CatalogItemView,
    credit: ModelCredit,
    modelImport: ModelImportView,
  ): void {
    this.catalogItems = [...this.catalogItems, item];
    const credits = this.state.credits;
    this.update({
      catalog: [...this.state.catalog, item],
      modelImport,
      studChecks: this.studChecks.size,
      ...(credits ? { credits: { ...credits, models: [...credits.models, credit] } } : {}),
    });
  }

  private studsChecked(pending: Placeable, checked: CheckedStuds): void {
    this.studChecks.delete(pending);
    const current = this.state.modelImport;
    const ours = current !== null && current.item === pending.id;
    switch (checked.kind) {
      case "checked": {
        this.studsLanded(pending, checked.placeable);
        if (ours) {
          const { report, studio } = checked;
          this.update({ modelImport: { ...current, status: "placeable", report, studio } });
        }
        break;
      }
      case "failed": {
        if (ours) {
          const { report, studio } = checked;
          const reason = `stud check failed: ${checked.failure}`;
          this.update({
            modelImport: { ...current, status: "check-failed", reason, report, studio },
          });
        }
        break;
      }
      default: {
        const unhandled: never = checked;
        throw new Error(`unhandled stud check ${String(unhandled)}`);
      }
    }
    this.update({
      studChecks: this.studChecks.size,
      studs: this.placed.studTotals(),
      hover: this.hoverView(),
    });
  }

  private studsLanded(pending: Placeable, checked: Placeable): void {
    const connected = this.connected.get(pending);
    if (connected) this.connected.set(checked, connected);
    const track = this.modelTrack.get(pending);
    if (track) this.modelTrack.set(checked, track);
    const view = this.placed.replacePlaceable(pending, checked);
    view.removed.forEach((model, index) => {
      this.unsearchable(model);
      const replaced = view.added[index];
      if (!replaced) return;
      this.searchable(replaced);
      if (this.selected === model) this.selected = replaced;
    });
    this.refreshRoads();
    this.syncModelTrack();
    this.refreshTrains();
    this.placeGhost();
    this.syncPlan();
    const drawing = this.track;
    if (drawing?.dragView()) {
      this.setTrackObstacles(drawing);
      drawing.moveDrag(this.hitX, this.hitZ);
      this.update({ track: this.trackView() });
    }
  }

  private setTrackObstacles(drawing: TrackDrawing): void {
    const models = this.placed.models();
    const range = drawing.verticalRange();
    drawing.setObstacles(trackObstacleRects(models, range), seatsPending(models, range));
  }

  async importModelFile(file: ModelFileInput): Promise<boolean> {
    const item = await this.session.addModelFile(file);
    if (item !== null && !this.state.readOnly) this.chooseItem(item);
    return item !== null;
  }

  private requestMeshes(placeable: Placeable): void {
    this.catalog.requestMeshes(new Set(placeable.parts.partIndex));
  }

  private requestTrackMeshes(track: TrackDrawing): void {
    this.catalog.requestMeshes(track.pieceParts().map((kit) => kit.partIndex));
  }

  private async ensureShardPlaceables(shards: ReadonlyArray<WorldShardV1>): Promise<void> {
    const refIds = new Set<number>();
    for (const shard of shards) {
      for (const placement of shard.placements) {
        const target = this.catalog.resolveRef(placement.ref, placement.color);
        if (target) refIds.add(target.refId);
      }
    }
    await Promise.all([...refIds].map((refId) => this.catalog.load(refId)));
  }

  private planEntry(model: PlacedModel): PlacedForPlan {
    const known = this.planEntries.get(model);
    if (known) return known;
    const entry: PlacedForPlan = {
      key: { chunkKey: model.handle.chunkKey, slot: model.handle.slot },
      ref: model.placeable.id,
      label: `${model.placeable.label} at ${model.handle.x}, ${model.handle.z}`,
      box: model.box,
    };
    this.planEntries.set(model, entry);
    return entry;
  }

  private syncPlan(): void {
    this.plans.setPlacements([
      ...this.placed.models().map((model) => this.planEntry(model)),
      ...(this.track?.planFootprints() ?? []),
    ]);
  }

  cycleTier(): void {
    this.frames.cycleTier();
  }

  measureFrames(): void {
    if (this.state.status !== "ready") return;
    this.frames.measureFrames();
  }

  private timeEdit(pending: PendingAction): void {
    this.frames.timeNextFrame((frame) => this.recordLatency(pending, frame));
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

  private trackItem(track: TrackDrawing, parts: ReadonlyArray<PartShapeAsset>): CatalogItemView {
    const straight = track.kitParts().find((k) => k.piece.kind === "straight");
    const part = straight ? parts[straight.partIndex] : undefined;
    return {
      id: TRACK_ITEM_ID,
      label: TRACK_ITEM_LABEL,
      shortLabel: TRACK_SHORT_LABEL,
      group: TRACK_ITEM_ID,
      groupLabel: TRACK_ITEM_LABEL,
      color: null,
      kind: "track",
      parts: track.kitParts().length,
      studsWide: part ? Math.round((part.boundsMax[0] - part.boundsMin[0]) / STUD_LDU) : 0,
      studsDeep: part ? Math.round((part.boundsMax[2] - part.boundsMin[2]) / STUD_LDU) : 0,
      thumbnail: null,
      aliases: [],
      elements: [],
      displayColor: false,
      draggable: false,
      toggleable: true,
      listedUnder: null,
    };
  }

  private trackPieceItems(
    track: TrackDrawing,
    parts: ReadonlyArray<PartShapeAsset>,
  ): ReadonlyArray<CatalogItemView> {
    return track.pieceSet.palette().map((catalogIndex) => {
      const kit = track.pieceByIndex(catalogIndex);
      const part = parts[kit.partIndex];
      const { element, title } = track.pieceSet.element(catalogIndex);
      return {
        id: `${TRACK_PIECE_PREFIX}${kit.piece.id}`,
        label: `${element.replace(/^[a-z]+:/u, "")} ${title}`,
        shortLabel: TRACK_SHORT_LABEL,
        group: TRACK_PIECE_GROUP,
        groupLabel: TRACK_PIECE_GROUP_LABEL,
        color: null,
        kind: "track",
        parts: 1,
        studsWide: part ? Math.round((part.boundsMax[0] - part.boundsMin[0]) / STUD_LDU) : 0,
        studsDeep: part ? Math.round((part.boundsMax[2] - part.boundsMin[2]) / STUD_LDU) : 0,
        thumbnail: null,
        aliases: [],
        elements: [],
        displayColor: false,
        draggable: false,
        toggleable: true,
        listedUnder: TRACK_ITEM_ID,
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
    const inModels = this.modelTrackCounts();
    return {
      pieces: track.pieceCount,
      modelPieces: inModels.pieces,
      runFramePieces: inModels.runFrame,
      offField: inModels.offField,
      unanchored: inModels.unanchored,
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

  private roadNeighbours(): readonly [ReadonlyArray<PlacedModel>, ReadonlyArray<PlacedModel>] {
    return [this.roadModels, this.placed.models().filter((model) => model.placeable.road === null)];
  }

  private showRoadPreview(preview: RoadPreview | null): void {
    if (!preview) return;
    this.backend.setGhost(preview.ghost);
    if (preview.ghost) this.backend.placeGhost(preview.ghost.originX, 0, preview.ghost.originZ, 0);
    this.roadPreviewMarkers = preview.markers;
    this.showMarkers();
    this.update({ roadStroke: preview.view });
  }

  private clearRoadPreview(): void {
    this.backend.setGhost(null);
    this.roadPreviewMarkers = [];
    this.showMarkers();
  }

  private roadDragStart(ndcX: number, ndcY: number): boolean {
    const roads = this.roadDrawing;
    if (!roads || this.state.readOnly || !this.groundHit(ndcX, ndcY)) return false;
    this.showRoadPreview(roads.begin(this.hitX, this.hitZ, ...this.roadNeighbours()));
    return true;
  }

  private roadDragEnd(ndcX: number, ndcY: number, eventTimeMs: number): void {
    const roads = this.roadDrawing;
    if (!roads) return;
    if (this.state.readOnly) {
      roads.cancel();
      this.clearRoadPreview();
      return;
    }
    if (this.groundHit(ndcX, ndcY)) roads.extend(this.hitX, this.hitZ);
    const stroke = roads.end(...this.roadNeighbours());
    this.clearRoadPreview();
    if (!stroke) return;
    if (stroke.requests.length === 0) {
      this.update({
        roadStroke: stroke.view,
        lastRoadStroke:
          stroke.view.issues.length > 0 ? { result: "refused", stroke: stroke.view } : null,
      });
      return;
    }
    this.show(this.history.commit("road", stroke.requests), eventTimeMs);
    this.update({ roadStroke: null, lastRoadStroke: { result: "laid", stroke: stroke.view } });
  }

  dragStart(ndcX: number, ndcY: number): boolean {
    if (this.state.mode === "measure") return this.rulerDragStart(ndcX, ndcY);
    if (this.state.mode === "road") return this.roadDragStart(ndcX, ndcY);
    const track = this.track;
    if (this.state.mode !== "track" || !track || this.state.readOnly || this.held) return false;
    if (!this.groundHit(ndcX, ndcY)) return false;
    this.setTrackObstacles(track);
    track.beginDrag(this.hitX, this.hitZ, this.hoverX, this.hoverZ);
    this.update({ track: this.trackView() });
    return true;
  }

  dragMove(ndcX: number, ndcY: number): void {
    if (this.measure?.drafting) {
      if (this.groundHit(ndcX, ndcY) && this.measure.drag(this.hoverX, this.hoverZ)) {
        this.showMeasurements();
      }
      return;
    }
    if (this.state.mode === "road") {
      if (this.roadDrawing && this.groundHit(ndcX, ndcY)) {
        this.showRoadPreview(this.roadDrawing.move(this.hitX, this.hitZ, ...this.roadNeighbours()));
      }
      return;
    }
    const track = this.track;
    if (!track || !this.groundHit(ndcX, ndcY)) return;
    track.moveDrag(this.hitX, this.hitZ);
    this.showTrackGhost(track);
    const target = track.dragTarget();
    this.targetTrackEnd(
      target?.joins ? target.end : null,
      target && !target.joins ? [target.end] : [],
    );
    this.update({ track: this.trackView() });
  }

  dragEnd(ndcX: number, ndcY: number, eventTimeMs: number): void {
    const measure = this.measure;
    if (measure?.drafting) {
      if (this.groundHit(ndcX, ndcY)) measure.drag(this.hoverX, this.hoverZ);
      measure.end();
      this.showMeasurements();
      return;
    }
    if (this.state.mode === "road") {
      this.roadDragEnd(ndcX, ndcY, eventTimeMs);
      return;
    }
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
      this.timeEdit({
        step: "do",
        action: "track",
        item: TRACK_ITEM_ID,
        rot: 0,
        x: this.hoverX,
        z: this.hoverZ,
        startMs: eventTimeMs,
        rebuiltMs: performance.now(),
        report: { chunks: commit.chunks.length, instances, studs },
      });
    }
    if (commit.laid > 0) {
      this.syncPlan();
      this.session.trackEdited();
    }
    if (commit.refusal) this.lastTrackCommit = `refused-${commit.refusal}`;
    else if (commit.laid > 0) this.lastTrackCommit = commit.joined ? "joined" : "laid";
    this.update({ track: this.trackView() });
  }

  private requestKitMeshes(kitId: string): void {
    const kit = this.roadDrawing?.kitViews().find((view) => view.id === kitId);
    for (const piece of kit?.pieces ?? []) {
      const refId = this.catalog.itemRefId(piece.item);
      const placeable = refId === null ? null : this.catalog.placeables()[refId];
      if (placeable) this.requestMeshes(placeable);
    }
  }

  private enterRoadMode(id: string): void {
    this.requestKitMeshes(id);
    this.ghostRot = this.placeRot;
    if (this.roadDrawing) this.roadDrawing.preferredRot = this.placeRot;
    if (this.state.mode === "track") {
      this.held = null;
      this.track?.cancelDrag();
      this.targetTrackEnd(null);
    }
    this.active = null;
    this.backend.setGhost(null);
    this.select(null);
    if (this.roadDrawing) this.roadDrawing.erasing = false;
    this.update({
      roadErase: false,
      mode: "road",
      activeItem: id,
      ghostRot: this.ghostRot,
      roadKit: id,
      roadStroke: null,
      lastRoadStroke: null,
      track: this.trackView(),
    });
  }

  private leaveRoadMode(): void {
    this.roadDrawing?.cancel();
    if (this.roadDrawing) this.roadDrawing.erasing = false;
    this.clearRoadPreview();
    this.update({ mode: "select", activeItem: null, roadStroke: null, roadErase: false });
  }

  chooseItem(id: string | null): void {
    if (this.state.mode === "measure") this.setMeasuring(false);
    if (id !== null && this.state.readOnly) return;
    if (this.state.mode === "road" && id !== this.state.activeItem) this.leaveRoadMode();
    if (id?.startsWith(ROAD_KIT_PREFIX) && this.roadDrawing?.choose(id)) {
      this.enterRoadMode(id);
      return;
    }
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
      this.requestTrackMeshes(track);
      this.update({ mode: "track", activeItem: id, pendingItem: null, track: this.trackView() });
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
    const refId = id === null ? null : this.catalog.itemRefId(id);
    if (id !== null && refId !== null && !this.catalog.placeables()[refId]) {
      this.choosePending(id, refId);
      return;
    }
    if (id === null && this.state.pendingItem !== null) {
      this.update({ mode: "select", activeItem: null, pendingItem: null });
    }
    if (id === null && !this.active) {
      this.select(null);
      return;
    }
    const placeable = refId === null ? null : (this.catalog.placeables()[refId] ?? null);
    if (placeable) {
      this.requestMeshes(placeable);
      this.requestFarModel(placeable);
    }
    this.active = placeable;
    this.activeRefId = placeable && refId !== null ? refId : -1;
    this.backend.setGhost(placeable ? { ...placeable.parts, studs: placeable.studs } : null);
    if (placeable) this.select(null);
    const snap = this.snapGhost();
    this.placeGhost();
    this.update({
      mode: placeable ? "place" : "select",
      activeItem: placeable?.id ?? null,
      pendingItem: null,
      snap,
      ghostRot: this.placeRot,
    });
  }

  private choosePending(id: string, refId: number): void {
    this.active = null;
    this.backend.setGhost(null);
    this.select(null);
    this.update({
      mode: "place",
      activeItem: id,
      pendingItem: id,
      snap: null,
      ghostRot: this.placeRot,
    });
    void this.catalog.load(refId).then(
      () => {
        if (this.state.pendingItem === id) this.chooseItem(id);
      },
      (error: unknown) => {
        if (this.state.pendingItem !== id) return;
        this.update({
          mode: "select",
          activeItem: null,
          pendingItem: null,
          catalogError: `${this.labelOf(id)} can't be loaded: ${errorText(error)}`,
        });
      },
    );
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
    this.timeEdit({
      step: "do",
      action: "track",
      item: `${TRACK_PIECE_PREFIX}${track.pieceByIndex(held.catalogIndex).piece.id}`,
      rot: held.heading,
      x: this.hoverX,
      z: this.hoverZ,
      startMs: eventTimeMs,
      rebuiltMs: performance.now(),
      report,
    });
    this.syncPlan();
    this.session.trackEdited();
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
    if (!track || this.state.readOnly) return false;
    const placement = track.switchAt(xLdu, zLdu);
    if (placement === null) return false;
    const thrown = track.throwSwitch(placement);
    if (!thrown) return false;
    const report = this.rebuildTrackChunks(track, [thrown.chunk]);
    this.timeEdit({
      step: "do",
      action: "track",
      item: `switch #${placement + 1}`,
      rot: 0,
      x: Math.round(xLdu),
      z: Math.round(zLdu),
      startMs: eventTimeMs,
      rebuiltMs: performance.now(),
      report,
    });
    this.syncPlan();
    this.session.trackEdited();
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
    this.hoverYPlates = this.placed.restingHeight(
      this.active,
      this.hoverX,
      this.hoverZ,
      this.placeRot,
      null,
    );
    this.hoverRefusal = this.placementRefusal(
      this.active,
      this.hoverX,
      this.hoverZ,
      this.placeRot,
      this.hoverYPlates,
      null,
    );
    this.backend.placeGhost(
      this.hoverX,
      this.hoverYPlates * PLATE_LDU + GHOST_LIFT_LDU,
      this.hoverZ,
      this.placeRot,
    );
  }

  private hoverView(): HoverView | null {
    if (!this.hovering) return null;
    return {
      x: this.hoverX,
      z: this.hoverZ,
      yPlates: this.hoverYPlates,
      refusal: this.hoverRefusal,
    };
  }

  private snapGhost(): RoadSnapView | null {
    this.placeRot = this.ghostRot;
    const surface = this.active?.road;
    if (!surface || !this.hovering || !this.state.snapRoads) return null;
    const snap = snapToRoadEdge(
      this.roadNetwork,
      this.roadExtents,
      surface,
      this.ghostRot,
      this.turnDirection,
      0,
      this.hoverX,
      this.hoverZ,
    );
    if (snap) {
      this.hoverX = snap.x;
      this.hoverZ = snap.z;
      this.placeRot = snap.rot;
      return {
        state: "snapped",
        joinedCells: snap.joinedCells,
        joinedRoadCells: snap.joinedRoadCells,
        mismatchedCells: 0,
        overlappingCells: 0,
      };
    }
    const fit = this.roadNetwork.fit({
      id: -1,
      x: this.hoverX,
      z: this.hoverZ,
      yLdu: 0,
      rot: this.placeRot,
      surface,
    });
    const refused = fit.mismatchedCells > 0 || fit.overlappingCells > 0;
    return { state: refused ? "refused" : "free", ...fit };
  }

  pointerMove(ndcX: number, ndcY: number): void {
    this.hovering = this.groundHit(ndcX, ndcY);
    const snap = this.snapGhost();
    if (this.state.mode === "road" && this.roadDrawing && this.hovering) {
      this.showRoadPreview(this.roadDrawing.hover(this.hitX, this.hitZ, ...this.roadNeighbours()));
    }
    const track = this.track;
    if (this.held) this.showHeldPiece();
    else if (this.state.mode === "track" && track && !track.dragView()) {
      this.targetTrackEnd(this.hovering ? track.endNear(this.hitX, this.hitZ, null) : null);
    }
    this.placeGhost();
    this.update({
      hover: this.hoverView(),
      snap,
      ghostRot: this.placeRot,
    });
  }

  pointerLeave(): void {
    this.hovering = false;
    this.update({ hover: null });
  }

  click(ndcX: number, ndcY: number, eventTimeMs: number): void {
    if (this.state.mode === "road" || this.state.mode === "measure") return;
    if (this.state.mode === "track") {
      if (!this.held || this.state.readOnly || !this.groundHit(ndcX, ndcY)) return;
      this.hovering = true;
      this.showHeldPiece();
      this.placeHeldPiece(eventTimeMs);
      return;
    }
    const pendingItem = this.state.pendingItem;
    if (pendingItem !== null) {
      if (this.state.readOnly || !this.groundHit(ndcX, ndcY)) return;
      this.refuse(
        pendingItem,
        snapToLattice(this.hitX),
        snapToLattice(this.hitZ),
        this.placeRot,
        `${this.labelOf(pendingItem)} is still loading`,
      );
      return;
    }
    if (this.active && !this.state.readOnly) {
      if (!this.groundHit(ndcX, ndcY)) return;
      this.hovering = true;
      const snap = this.snapGhost();
      this.placeGhost();
      if (snap?.state === "refused") {
        this.update({
          snap,
          refusedClicks: this.state.refusedClicks + 1,
          lastRefusal: {
            item: this.active.id,
            x: this.hoverX,
            z: this.hoverZ,
            rot: this.placeRot,
            mismatchedCells: snap.mismatchedCells,
            overlappingCells: snap.overlappingCells,
            reason: ROAD_REFUSAL,
          },
        });
        return;
      }
      if (this.hoverRefusal !== null) {
        this.refuse(this.active.id, this.hoverX, this.hoverZ, this.placeRot, this.hoverRefusal);
        return;
      }
      this.placeAt(this.active, this.hoverX, this.hoverZ, this.placeRot, eventTimeMs);
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

  private refuse(
    item: string,
    x: number,
    z: number,
    rot: number,
    reason: string,
    fit: RoadCellCounts = NO_ROAD_CELLS,
  ): void {
    this.update({
      refusedClicks: this.state.refusedClicks + 1,
      lastRefusal: {
        item,
        x,
        z,
        rot,
        mismatchedCells: fit.mismatchedCells,
        overlappingCells: fit.overlappingCells,
        reason,
      },
    });
  }

  private placementRefusal(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
    yPlates: number,
    ignore: PlacedModel | null,
  ): string | null {
    const overlap = this.placed.slabClash(placeable, x, z, rot, yPlates, ignore);
    if (!overlap) return null;
    return `${placeable.label} would overlap ${overlap.placeable.label} at the same height. Two baseplates can't share the same space.`;
  }

  private labelOf(id: string): string {
    return this.catalogItems.find((item) => item.id === id)?.label ?? id;
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
        refId: this.activeRefId,
        colorId: placeable.worldColor,
        x,
        z,
        yPlates: this.placed.restingHeight(placeable, x, z, rot, null),
        rot,
      }),
      eventTimeMs,
    );
  }

  private historyView(): HistoryView {
    return {
      undo: this.history.nextUndo(),
      redo: this.history.nextRedo(),
      undoDepth: this.history.undoDepth,
      redoDepth: this.history.redoDepth,
    };
  }

  private placeableAt(refId: number): Placeable {
    const placeable = this.catalog.placeables()[refId];
    if (!placeable) throw new Error(`no catalog item has ref id ${refId}`);
    return placeable;
  }

  private show(edit: AppliedEdit, eventTimeMs: number): ViewUpdate {
    const view = this.placed.apply(edit, (refId) => this.placeableAt(refId));
    for (const model of view.removed) this.unsearchable(model);
    for (const model of view.added) this.searchable(model);
    for (const placeable of new Set(view.added.map((model) => model.placeable))) {
      this.requestMeshes(placeable);
      this.requestFarModel(placeable);
    }
    this.session.placementsEdited(edit);
    const primary = edit.changes[0];
    const pose = primary?.to ?? primary?.from ?? null;
    if (pose) {
      this.timeEdit({
        step: edit.step,
        action: edit.kind,
        item: this.placeableAt(pose.refId).id,
        rot: pose.rot,
        x: pose.x,
        z: pose.z,
        startMs: eventTimeMs,
        rebuiltMs: performance.now(),
        report: view.report,
      });
    }
    this.refreshRoads();
    this.syncModelTrack();
    this.refreshTrains();
    this.placeGhost();
    this.update({
      selectionRefusal: null,
      placements: this.world.size,
      hover: this.hoverView(),
      studs: this.placed.studTotals(),
      history: this.historyView(),
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

  private rerunRoadDrawing(): void {
    const roads = this.roadDrawing;
    if (!roads) return;
    roads.worldChanged();
    if (roads.isDragging()) this.showRoadPreview(roads.rerun(...this.roadNeighbours()));
  }

  private refreshRoads(): void {
    const started = performance.now();
    const roadModels = this.placed.models().filter((model) => model.placeable.road !== null);
    if (sameModels(roadModels, this.roadModels)) {
      this.rerunRoadDrawing();
      return;
    }
    this.roadModels = roadModels;
    const placements = this.roadPlacements();
    this.roadNetwork = new RoadNetwork(placements);
    this.roadExtents = placements.map(cellExtent);
    this.roadReport = this.roadNetwork.report();
    this.rerunRoadDrawing();
    const checkMs = performance.now() - started;
    this.showMarkers();
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

  private refreshTrains(): void {
    const placed = new Set(this.placed.models().map((model) => model.placeable));
    this.placedTrains = this.catalog.placeables().flatMap((placeable) => {
      const train = placeable && placed.has(placeable) ? this.catalog.playModel(placeable) : null;
      return train ? [train] : [];
    });
  }

  private showMarkers(): void {
    const joins: EdgeMarker[] = this.state.showJoins
      ? this.roadReport.segments.map((segment) => ({
          box: markerBox(segment),
          kind: segment.status,
        }))
      : [];
    this.backend.setMarkers([...joins, ...this.roadPreviewMarkers]);
  }

  setShowJoins(show: boolean): void {
    this.update({ showJoins: show });
    this.showMarkers();
  }

  setRoadErase(erase: boolean): void {
    const roads = this.roadDrawing;
    if (!roads) return;
    roads.erasing = erase;
    this.update({ roadErase: erase, lastRoadStroke: null });
    this.showRoadPreview(roads.rerun(...this.roadNeighbours()));
  }

  setSnapRoads(snap: boolean): void {
    this.update({ snapRoads: snap, snap: null });
  }

  setGridShown(shown: boolean): void {
    this.update({ gridShown: shown });
    if (this.state.status === "ready") this.showGround();
  }

  private showGround(): void {
    const { gridShown, planCoversGround } = this.state;
    this.backend.setGroundGrid(
      gridShown && !planCoversGround ? { y: this.tableTopY, stepsLdu: GRID_STEPS_LDU } : null,
    );
  }

  setMeasuring(on: boolean): void {
    if (on === (this.state.mode === "measure")) return;
    if (!on) {
      this.measure?.cancel();
      this.showMeasurements();
      this.update({ mode: "select" });
      return;
    }
    if (this.state.status !== "ready") return;
    this.chooseItem(null);
    this.select(null);
    this.update({ mode: "measure", activeItem: null });
  }

  clearRulers(): void {
    this.measure?.clear();
    this.showMeasurements();
  }

  projectLabels(out: Float64Array): void {
    const { labels } = this.state;
    const count = Math.min(labels.length, Math.floor(out.length / PROJECTION_FLOATS));
    for (let i = 0; i < count; i++) {
      const label = labels[i];
      if (!label) continue;
      this.backend.projectToNdc(label.x, label.y, label.z, out, i * PROJECTION_FLOATS);
    }
  }

  private rulerDragStart(ndcX: number, ndcY: number): boolean {
    const measure = this.measure;
    if (!measure || !this.groundHit(ndcX, ndcY)) return false;
    measure.begin(this.hoverX, this.hoverZ);
    this.showMeasurements();
    return true;
  }

  private showMeasurements(): void {
    this.backend.setGuides(this.measure?.guides() ?? []);
    this.update({
      rulers: this.measure?.count ?? 0,
      rulerDraft: this.measure?.drafting ?? false,
      labels: this.labelsOf(this.state),
    });
  }

  bomInput(scope: BomScope): BomInput {
    const ldrawCodes = this.bundleColorCodes;
    if (!ldrawCodes) throw new Error("the editor has not loaded");
    const colors = this.catalog.colors();
    const placeables = this.catalog.placeables();
    const counter = new BomCounter(
      this.catalog.parts().map((part) => part.id),
      ldrawCodes,
    );
    const placedCounts = new Map<number, number>();
    const contents: PlacementContents = {
      addTo: (target, refId) => {
        const placeable = placeables[refId];
        if (!placeable) throw new Error(`world holds unknown placeable ${refId}`);
        placedCounts.set(refId, (placedCounts.get(refId) ?? 0) + 1);
        const { parts } = placeable;
        for (let i = 0; i < parts.count; i++) {
          target.add(parts.partIndex[i] ?? 0, colors.codeAt(parts.colorIndex[i] ?? 0), 1);
        }
      },
    };
    const uncounted = (): BomInput["uncounted"] =>
      [...placedCounts].flatMap(([refId, count]) => {
        const placeable = placeables[refId];
        if (!placeable) return [];
        return notDrawnItems(placeable.id, this.catalog.notDrawn(placeable), count);
      });
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
      selectionRefusal: null,
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

  rotate(eventTimeMs: number, direction: TurnDirection = 1): void {
    const roads = this.roadDrawing;
    if (this.state.mode === "road" && roads) {
      this.ghostRot = quarterTurned(this.ghostRot, direction);
      this.placeRot = this.ghostRot;
      roads.preferredRot = this.ghostRot;
      this.showRoadPreview(roads.rerun(...this.roadNeighbours()));
      this.update({ ghostRot: this.ghostRot });
      return;
    }
    const held = this.held;
    if (held) {
      this.held =
        held.snap?.end === null || !held.snap
          ? {
              ...held,
              heading: (held.heading + direction * QUARTER_TURN_16 + ZETA16_ORDER) % ZETA16_ORDER,
            }
          : { ...held, connector: held.connector + direction };
      this.showHeldPiece();
      return;
    }
    if (this.active) {
      this.turnDirection = direction;
      this.ghostRot = quarterTurned(this.placeRot, direction);
      if (this.hovering) {
        this.hoverX = snapToLattice(this.hitX);
        this.hoverZ = snapToLattice(this.hitZ);
      }
      const snap = this.snapGhost();
      this.placeGhost();
      this.update({
        ghostRot: this.placeRot,
        snap,
        hover: this.hoverView(),
      });
      return;
    }
    const model = this.selected;
    if (!model || this.state.readOnly) return;
    this.turnSelection(model, quarterTurned(model.handle.rot, direction), eventTimeMs);
  }

  private turnSelection(model: PlacedModel, rot: number, eventTimeMs: number): void {
    const pose = model.handle;
    const label = model.placeable.label;
    const refuseTurn = (reason: string, fit: RoadCellCounts = NO_ROAD_CELLS): void => {
      this.refuse(model.placeable.id, pose.x, pose.z, rot, reason, fit);
      this.update({
        selectionRefusal: `Can't turn to ${rot * DEGREES_PER_QUARTER_TURN}°. ${reason}`,
      });
    };
    const rider = this.placed.riderOn(model);
    if (rider) {
      const riding = rider.placeable.label;
      refuseTurn(
        `${label}: ${riding} rests on it, so turning it would leave ${riding} floating or cut into it.`,
      );
      return;
    }
    const yPlates = this.placed.restingHeight(model.placeable, pose.x, pose.z, rot, model);
    const refusal = this.placementRefusal(model.placeable, pose.x, pose.z, rot, yPlates, model);
    if (refusal !== null) {
      refuseTurn(refusal);
      return;
    }
    const road = this.turnedRoadFit(model, rot, yPlates);
    if (road && (road.mismatchedCells > 0 || road.overlappingCells > 0)) {
      refuseTurn(`${label}: ${ROAD_REFUSAL}.`, road);
      return;
    }
    const edit = this.history.commit("rotate", [
      {
        placement: model.placement,
        to: { refId: pose.refId, colorId: pose.colorId, x: pose.x, z: pose.z, yPlates, rot },
      },
    ]);
    this.select(this.show(edit, eventTimeMs).added[0] ?? null);
  }

  private turnedRoadFit(model: PlacedModel, rot: number, yPlates: number): RoadCellCounts | null {
    const surface = model.placeable.road;
    if (!surface || !this.state.snapRoads) return null;
    const others = this.roadPlacements().filter(({ id }) => this.roadModels[id] !== model);
    return new RoadNetwork(others).fit({
      id: -1,
      x: model.handle.x,
      z: model.handle.z,
      yLdu: yPlates * PLATE_LDU,
      rot,
      surface,
    });
  }

  deleteSelection(eventTimeMs: number): void {
    const measure = this.measure;
    if (this.state.mode === "measure" && measure) {
      if (measure.drafting) measure.cancel();
      else measure.removeLast();
      this.showMeasurements();
      return;
    }
    const model = this.selected;
    if (!model || this.state.readOnly) return;
    const rider = this.placed.strandedRider(model);
    if (rider) {
      const label = model.placeable.label;
      const riding = rider.placeable.label;
      const reason = `${label}: ${riding} rests on it, so deleting it would leave ${riding} floating. Delete ${riding} first.`;
      const { x, z, rot } = model.handle;
      this.refuse(model.placeable.id, x, z, rot, reason);
      this.update({ selectionRefusal: `Can't delete. ${reason}` });
      return;
    }
    const stranded = this.strandedBy(model);
    if (stranded) {
      const label = model.placeable.label;
      const left = stranded.placeable.label;
      const reason = `${label}: ${left} connects only through it, so deleting it would leave ${left} unconnected. Delete ${left} first.`;
      const { x, z, rot } = model.handle;
      this.refuse(model.placeable.id, x, z, rot, reason);
      this.update({ selectionRefusal: `Can't delete. ${reason}` });
      return;
    }
    this.show(this.history.remove(model.placement), eventTimeMs);
    this.select(null);
  }

  undo(eventTimeMs: number): void {
    if (this.state.readOnly) return;
    this.replay(this.history.undo(), eventTimeMs);
  }

  redo(eventTimeMs: number): void {
    if (this.state.readOnly) return;
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

  goTo(x: number, z: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    this.camera.lookAt(x, z, false);
  }

  contents(): WorldContents {
    return {
      world: this.world,
      refs: this.catalog.refs(),
      track: this.track?.records() ?? [],
    };
  }

  placedCredits(): ReadonlyArray<ModelCredit> {
    return this.placed
      .models()
      .flatMap((model) => (model.placeable.credit ? [model.placeable.credit] : []));
  }

  private connectedOf(placeable: Placeable): Connected {
    let connected = this.connected.get(placeable);
    if (!connected) {
      const parts = this.catalog.parts();
      const boxes = partBoxes(placeable.partBoxes);
      connected = {
        model: this.search.model(
          parts.map(() => null),
          placeable.partTransforms,
          this.trackOf(placeable)?.openEnds ?? [],
        ),
        volumes: FrozenVolumes.ofPlaceable(placeable),
        boxes,
        technic: FrozenTechnic.ofParts(
          parts.map((part) => part.technic),
          placeable.partTransforms,
          boxes.boxes,
        ),
      };
      this.connected.set(placeable, connected);
    }
    return connected;
  }

  private searchable(model: PlacedModel): void {
    const id = this.nextSearchId++;
    const { model: connectors, volumes, boxes, technic } = this.connectedOf(model.placeable);
    const { x, z, yPlates, rot } = model.handle;
    this.search.add(id, connectors, volumes, boxes, technic, { x, z, yPlates, rot });
    this.searchIds.set(model, id);
    this.searchModels.set(id, model);
  }

  private unsearchable(model: PlacedModel): void {
    const id = this.searchIds.get(model);
    if (id === undefined) return;
    this.search.remove(id);
    this.searchIds.delete(model);
    this.searchModels.delete(id);
  }

  private strandedBy(model: PlacedModel): PlacedModel | null {
    const id = this.searchIds.get(model);
    if (id === undefined) return null;
    const stranded = this.search.strandedByRemoval(
      id,
      (other) => (this.searchModels.get(other)?.handle.yPlates ?? 0) <= 0,
    );
    return stranded === null ? null : (this.searchModels.get(stranded) ?? null);
  }

  private trackOf(placeable: Placeable): ModelTrackEnds | null {
    const catalog = this.trackCatalog;
    if (!catalog) return null;
    let track = this.modelTrack.get(placeable);
    if (!track) {
      track = modelTrackEnds(placeable.partTransforms, this.catalog.parts(), catalog);
      this.modelTrack.set(placeable, track);
    }
    return track;
  }

  private modelTrackCounts(): {
    readonly pieces: number;
    readonly runFrame: number;
    readonly offField: number;
    readonly unanchored: number;
  } {
    let pieces = 0;
    let runFrame = 0;
    let offField = 0;
    let unanchored = 0;
    for (const model of this.placed.models()) {
      const track = this.trackOf(model.placeable);
      pieces += track?.pieces.length ?? 0;
      for (const run of track?.runs ?? []) runFrame += run.pieces.length;
      for (const piece of track?.uncertified ?? []) {
        if (piece.reason === "noAnchor") unanchored++;
        else offField++;
      }
    }
    return { pieces, runFrame, offField, unanchored };
  }

  private syncModelTrack(): void {
    const drawing = this.track;
    if (!drawing) return;
    const carrying = this.placed.models().filter((model) => {
      const track = this.trackOf(model.placeable);
      return (track?.pieces.length ?? 0) + (track?.runs.length ?? 0) > 0;
    });
    const unchanged =
      carrying.length === this.heldTrackModels.length &&
      carrying.every((model, i) => model === this.heldTrackModels[i]);
    if (unchanged) return;
    this.heldTrackModels = carrying;
    const held: FramedTrackPiece[] = [];
    let nextRunFrame = WORLD_TRACK_FRAME.id + 1;
    for (const model of carrying) {
      const track = this.trackOf(model.placeable);
      const { x, z, yPlates, rot } = model.handle;
      const frame = latticeFrame(x, z, rot);
      if (!track || !frame) continue;
      held.push(
        ...heldPieces(track, frame, yPlates),
        ...heldRuns(track, frame, yPlates, nextRunFrame),
      );
      nextRunFrame += track.runs.length;
    }
    drawing.syncHeld(held);
    this.showTrackEnds(null);
    this.update({ track: this.trackView() });
  }

  validate(shards: ReadonlyArray<WorldShardV1>): ReadonlyArray<Issue> {
    const restored = this.restore(shards);
    return restored.ok ? [] : restored.issues;
  }

  async load(shards: ReadonlyArray<WorldShardV1>): Promise<ReadonlyArray<Issue>> {
    await this.ensureShardPlaceables(shards);
    const restored = this.restore(shards);
    if (!restored.ok) return restored.issues;
    this.replaceWorld(restored.value);
    for (const placeable of new Set(this.placed.models().map((model) => model.placeable))) {
      this.requestMeshes(placeable);
      this.requestFarModel(placeable);
    }
    const { track } = restored.value;
    if (track && track.pieceCount > 0) this.requestTrackMeshes(track);
    this.refreshRoads();
    this.syncModelTrack();
    this.refreshTrains();
    this.syncPlan();
    return [];
  }

  private restore(shards: ReadonlyArray<WorldShardV1>): Decoded<RestoredWorld> {
    const world = new World();
    const handles = addShards(world, shards, (ref, color) => this.catalog.resolveRef(ref, color));
    if (!handles.ok) return handles;
    const track = this.newTrack?.() ?? null;
    const restored = track?.restore(worldTrack(shards));
    if (restored && !restored.ok) return restored;
    return { ok: true, value: { world, handles: handles.value, track } };
  }

  private replaceWorld({ world, handles, track }: RestoredWorld): void {
    this.select(null);
    this.clearRulers();
    this.placed.clear();
    for (const key of this.track?.chunkKeys() ?? []) this.backend.deleteChunk(key);
    this.track = track;
    for (const key of track?.chunkKeys() ?? []) {
      const chunk = track?.chunkInstances(key);
      if (chunk) this.backend.setChunk(key, chunk);
    }
    this.heldTrackModels = [];
    this.search.clear();
    this.searchIds.clear();
    this.searchModels.clear();
    this.showTrackEnds(null);
    this.world = world;
    this.history = new EditHistory(world);
    this.placed.addAll(
      handles.flatMap((handle) => {
        const placeable = this.catalog.placeables()[handle.refId];
        return placeable ? [{ placement: this.history.adopt(handle), handle, placeable }] : [];
      }),
    );
    for (const model of this.placed.models()) this.searchable(model);
    this.update({
      placements: world.size,
      history: this.historyView(),
      track: this.trackView(),
      studs: this.placed.studTotals(),
      catalogError: null,
    });
  }

  get worldNameMaxLength(): number {
    return this.session.worldNameMaxLength;
  }

  worldNameIssue(name: string): string | null {
    return this.session.worldNameIssue(name);
  }

  newWorld(name: string): Promise<boolean> {
    return this.session.newWorld(name);
  }

  openWorld(id: string): Promise<boolean> {
    return this.session.openWorld(id);
  }

  deleteWorld(id: string): Promise<boolean> {
    return this.session.deleteWorld(id);
  }

  retrySave(): Promise<void> {
    return this.session.retrySave();
  }

  exportWorld(): Promise<ExportedWorld> {
    return this.session.exportWorld();
  }

  importWorld(bytes: Uint8Array): Promise<boolean> {
    return this.session.importWorld(bytes);
  }

  trackRoutes(): ReadonlyArray<TrackRouteView> {
    return this.track?.routes() ?? [];
  }

  playSetup(): PlaySetup | null {
    const track = this.track;
    if (!track || this.studChecks.size > 0) return null;
    return {
      track: track.playTrack(),
      models: this.placedTrains,
      parts: this.catalog.parts(),
      colors: this.catalog.colors(),
    };
  }

  dump(): EditorDump {
    return {
      refs: this.catalogItems.map((item) => item.id),
      chunkCounts: this.world
        .chunks()
        .filter((chunk) => chunk.liveCount > 0)
        .map(
          (chunk) =>
            [chunk.originX / CHUNK_LDU, chunk.originZ / CHUNK_LDU, chunk.liveCount] as const,
        )
        .toSorted((a, b) => a[0] - b[0] || a[1] - b[1]),
      trackEnds: this.track?.openEnds() ?? [],
      frameShifts: this.loadedPlaceables().map((p) => p.frameShift),
      covers: this.loadedPlaceables().map((p) => ({
        id: p.id,
        studsDrawnPerPlacement: p.studs.count,
        studsPending: p.studsPending,
        studsCulledAtBake: p.bakedCoveredStuds,
        footprintCells: p.cells.footprintCells,
        flatCells: p.cells.flatCells,
        heightPlates: p.cells.heightPlates,
      })),
      bakes: this.loadedPlaceables().flatMap((placeable) => {
        const { lattice, cells } = this.catalog.baked(placeable) ?? { lattice: null, cells: null };
        return lattice && cells
          ? [
              {
                id: placeable.id,
                lattice,
                cells: {
                  ...cells,
                  footprint: [...cells.footprint],
                  flat: [...cells.flat],
                  columnBottom: [...cells.columnBottom],
                  columnTop: [...cells.columnTop],
                },
              },
            ]
          : [];
      }),
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
      studs: this.placed.studTotals(),
      studChecks: this.studChecks.size,
    };
  }
}

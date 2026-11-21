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
  PlanDelta,
  RoadNetwork,
  World,
  addShards,
  ConsistLayout,
  consistPoseProblem,
  type AppliedEdit,
  type ConsistHandle,
  type ConsistPose,
  type ConsistRef,
  type TrackPieceRef,
  type EditKind,
  type EditSummary,
  type HistoryStep,
  type PlacementHandle,
  type PlacementContents,
  type RoadEdgeSegment,
  type RoadJoinReport,
  type RoadPlacement,
  type ModelConnectors,
  type TrackChange,
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
  zeta16ToStuds,
} from "@brr/math";
import {
  RAY_FLOATS,
  SCENE_BACKEND,
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
import {
  importRef,
  worldTrack,
  type ConsistPieceV1,
  type ConsistRecordV1,
  type ImportedFile,
  type TrackRecordV1,
} from "@brr/schema/world";
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
  CONNECTOR_TABLES,
  EDITOR_FRAME_LOOP,
  PLACEABLE_CATALOG,
  PLACEMENT_SEARCH,
  RAIL_YARD,
  WORLD_SESSION,
} from "../tokens.ts";
import type { FrameLoopView, FrameTimes, IEditorFrameLoop } from "./editor-frame-loop.ts";
import type { IConnectorTables, PartWithoutConnectorRecord } from "../connect/connector-tables.ts";
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
import { EDITOR_CAMERA, PLAN_SERVICE, TABLE_GROUND } from "../tokens.ts";
import type { GroundView, ITableGround } from "../ground/table-ground.ts";
import type { IPlanService } from "../plan/plan-service.ts";
import { writeFullRebuild, writeTrackChange, writeViewUpdate } from "../plan/plan-producer.ts";
import type { IEditorCamera } from "../camera/editor-camera.ts";
import type { PlayModel } from "../play/play-models.ts";
import type { IRailYard, RailAim } from "../trains/rail-yard.ts";
import { laidPieceRecord, laidPieceRef } from "../trains/rail-track.ts";
import { errorText } from "./error-text.ts";
import type {
  ExportedWorld,
  IEditedWorld,
  IWorldFiles,
  IWorldSession,
  ModelFileInput,
  StoredContents,
  WorldContents,
  WorldSessionView,
} from "./world-session.ts";
import {
  rollingDiagnosticsPanel,
  type RollingDiagnosticsPanel,
} from "../inspect/rolling-diagnostics.ts";

export type { TurnDirection } from "./turn.ts";
export type EditorStatus = "loading" | "ready" | "error";
export type EditAction = EditKind;
export type EditorMode = "place" | "select" | "track" | "road";
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

export interface ModelSelectionView {
  readonly kind: "model";
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
  readonly chunkKey: number;
  readonly slot: number;
  readonly box: WorldBox;
}

export interface TrainSelectionView {
  readonly kind: "train";
  readonly item: string;
  readonly vehicles: number;
  readonly lengthLdu: number;
  readonly box: WorldBox;
}

export interface TrackSelectionView {
  readonly kind: "track";
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly chunkKey: number;
  readonly slot: number;
  readonly box: WorldBox;
}

export type SelectionView = ModelSelectionView | TrainSelectionView | TrackSelectionView;

export interface RailTrainView {
  readonly item: string;
  readonly label: string;
  readonly onRails: boolean;
}

export interface HistoryView {
  readonly undo: EditAction | null;
  readonly redo: EditAction | null;
  readonly undoLabel: string | null;
  readonly redoLabel: string | null;
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

export interface QueuedPlacement {
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly rot: number;
}

interface QueuedClick extends QueuedPlacement {
  readonly ndcX: number;
  readonly ndcY: number;
  readonly eventTimeMs: number;
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
  readonly onRails: boolean;
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

export interface EditorSnapshot extends WorldSessionView, FrameLoopView, GroundView {
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
  readonly connectorGaps: ReadonlyArray<PartWithoutConnectorRecord>;
  readonly queuedPlacement: QueuedPlacement | null;
  readonly trains: ReadonlyArray<RailTrainView>;
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
  readonly laidTrack: ReadonlyArray<TrackRecordV1>;
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
  removeTrain(index: number, eventTimeMs: number): void;
  undo(eventTimeMs: number): void;
  redo(eventTimeMs: number): void;
  setShowJoins(show: boolean): void;
  setShowGrid(show: boolean): void;
  setSnapRoads(snap: boolean): void;
  goTo(x: number, z: number): void;
  importModelFile(file: ModelFileInput): Promise<boolean>;
  measureFrames(): void;
  cycleTier(): void;
  trackRoutes(): ReadonlyArray<TrackRouteView>;
  setRoadErase(erase: boolean): void;
  rollingDiagnostics(item: string): Promise<RollingDiagnosticsPanel | null>;
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

interface EditSample {
  readonly item: string;
  readonly rot: number;
  readonly x: number;
  readonly z: number;
}

interface PendingAction extends EditSample {
  readonly step: HistoryStep;
  readonly action: EditAction;
  readonly startMs: number;
  readonly rebuiltMs: number;
  readonly report: RebuildReport;
}

const NOTHING_REBUILT: RebuildReport = { chunks: 0, instances: 0, studs: 0 };

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function editLabel(edit: EditSummary | null): string | null {
  if (edit === null) return null;
  switch (edit.kind) {
    case "place":
      return "place";
    case "rotate":
      return "rotate";
    case "remove":
      return "delete";
    case "road":
      return `road stroke (${counted(edit.placements, "plate", "plates")})`;
    case "lay-track":
      return `lay ${counted(edit.pieces, "piece", "pieces")}`;
    case "throw-switch":
      return "throw switch";
    default: {
      const unhandled: never = edit;
      throw new Error(`unhandled edit ${JSON.stringify(unhandled)}`);
    }
  }
}

interface RestoredWorld {
  readonly consists: ReadonlyArray<ConsistPose>;
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
    history: {
      undo: null,
      redo: null,
      undoLabel: null,
      redoLabel: null,
      undoDepth: 0,
      redoDepth: 0,
    },
    lastLatency: null,
    latencies: [],
    stats: null,
    studs: null,
    tier: null,
    farTier: "loading",
    farTierError: null,
    pendingItem: null,
    meshes: {
      detailedPartMeshes: NO_MESHES,
      farPartMeshes: NO_MESHES,
      farModelMeshes: NO_MESHES,
      undrawnParts: [],
    },
    measuring: false,
    measurement: null,
    credits: null,
    roads: EMPTY_ROADS,
    showJoins: true,
    showGrid: true,
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
    connectorGaps: [],
    queuedPlacement: null,
    trains: [],
  };
  private world = new World();
  private consists = new ConsistLayout();
  private history = new EditHistory(this.world, this.consists);
  private readonly consistRefs = new Map<ConsistHandle, ConsistRef>();
  private selectedTrain: ConsistHandle | null = null;
  private activeTrain: PlayModel | null = null;
  private trainAim: RailAim | null = null;
  private ghostOnRails = false;
  private readonly ray = new Float64Array(RAY_FLOATS);
  private catalogItems: ReadonlyArray<CatalogItemView> = [];
  private bundleColorCodes: ReadonlyArray<number> | null = null;
  private placed: PlacedChunks;
  private active: Placeable | null = null;
  private activeRefId = -1;
  private selected: PlacedModel | null = null;
  private selectedTrack: number | null = null;
  private ghostRot = 0;
  private placeRot = 0;
  private turnDirection: TurnDirection = 1;
  private hoverX = 0;
  private hoverZ = 0;
  private hoverYPlates = 0;
  private hoverRefusal: string | null = null;
  private queuedClick: QueuedClick | null = null;
  private hovering = false;
  private hitX = 0;
  private hitZ = 0;
  private track: TrackDrawing | null = null;
  private trackCatalog: TrackCatalog | null = null;
  private readonly modelTrack = new Map<Placeable, ModelTrackEnds>();
  private heldTrackModels: ReadonlyArray<PlacedModel> = [];
  private readonly heldRanges = new Map<PlacedModel, readonly [number, number]>();
  private readonly searchIds = new Map<PlacedModel, number>();
  private readonly searchModels = new Map<number, PlacedModel>();
  private readonly connected = new Map<Placeable, Connected>();
  private readonly studChecks = new Set<Placeable>();
  private nextSearchId = 1;
  private newTrack: (() => TrackDrawing) | null = null;
  private roadDrawing: RoadDrawing | null = null;
  private roadPreviewMarkers: ReadonlyArray<EdgeMarker> = [];
  private lastTrackCommit: TrackCommitResult | null = null;
  private trackEndTarget = "";
  private held: HeldPiece | null = null;
  private roadModels: ReadonlyArray<PlacedModel> = [];
  private roadExtents: ReadonlyArray<CellExtent> = [];
  private roadNetwork = new RoadNetwork([]);
  private roadReport: RoadJoinReport = new RoadNetwork([]).report();
  private readonly planDelta = new PlanDelta();

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
    @inject(PLAN_SERVICE) private readonly plans: IPlanService,
    @inject(EDITOR_CAMERA) private readonly camera: IEditorCamera,
    @inject(WORLD_SESSION) private readonly session: IWorldSession,
    @inject(EDITOR_FRAME_LOOP) private readonly frames: IEditorFrameLoop,
    @inject(PLACEABLE_CATALOG) private readonly catalog: IPlaceableCatalog,
    @inject(PLACEMENT_SEARCH) private readonly search: IPlacementSearch,
    @inject(CONNECTOR_TABLES) private readonly connectorTables: IConnectorTables,
    @inject(TABLE_GROUND) private readonly ground: ITableGround,
    @inject(RAIL_YARD) private readonly railYard: IRailYard,
  ) {
    this.placed = new PlacedChunks(backend);
    this.state = { ...this.state, ...session.view(), ...frames.view(), ...ground.view() };
    session.subscribe(() => this.sessionChanged());
    frames.subscribe(() => this.update(this.frames.view()));
    ground.subscribe(() => this.update(this.ground.view()));
    catalog.subscribe(() => this.update({ meshes: catalog.meshProgress() }));
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
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
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
      this.ground.lay(index.tablePlane);
      const catalog = await this.catalog.start(index);
      this.catalogItems = catalog.items;
      this.bundleColorCodes = index.colors.map((color) => color.code);
      this.plans.setTableTopY(this.baseplateBottomY());
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
        const refId = this.catalog.itemRefId(outcome.item.id);
        const imported = refId === null ? null : this.catalog.placeables()[refId];
        if (imported) await this.connectorTables.load(imported);
        const reported = { ...importing, report: outcome.report, studio: outcome.studio };
        this.addImportedItem(outcome.item, outcome.credit, {
          ...reported,
          status: "placeable",
          item: outcome.item.id,
        });
        return outcome.item.id;
      }
      case "checking": {
        await this.connectorTables.load(outcome.pending);
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
    writeViewUpdate(this.planDelta, view);
    this.plans.apply(this.planDelta);
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

  private async ensureStoredPlaceables({ shards, consists }: StoredContents): Promise<void> {
    const refIds = new Set<number>();
    const placed = [...shards.flatMap((shard) => shard.placements), ...consists];
    for (const { ref, color } of placed) {
      const target = this.catalog.resolveRef(ref, color);
      if (target) refIds.add(target.refId);
    }
    const placeables = await Promise.all([...refIds].map((refId) => this.catalog.load(refId)));
    await Promise.all(placeables.map((placeable) => this.connectorTables.load(placeable)));
  }

  private baseplateBottomY(): number {
    const baseplate = this.loadedPlaceables().find((p) => p.kind === "baseplate");
    if (!baseplate) throw new Error("the bundle has no baseplate");
    return baseplate.box.min[1];
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
        shortLabel: title,
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
    if (this.state.mode === "road") {
      this.roadDragEnd(ndcX, ndcY, eventTimeMs);
      return;
    }
    const track = this.track;
    if (!track) return;
    const hit = this.groundHit(ndcX, ndcY);
    if (hit) track.moveDrag(this.hitX, this.hitZ);
    const stayed = (track.dragView()?.pieces ?? 0) === 0;
    const outcome = track.endDrag();
    this.backend.setGhost(null);
    this.showTrackEnds(null);
    if (hit && stayed && this.throwSwitchAt(this.hitX, this.hitZ, eventTimeMs)) return;
    if (outcome.refusal) {
      this.lastTrackCommit = `refused-${outcome.refusal}`;
    } else if (outcome.change.lay.length > 0) {
      this.show(this.history.commit("lay-track", [], outcome.change), eventTimeMs, {
        item: TRACK_ITEM_ID,
        rot: 0,
        x: this.hoverX,
        z: this.hoverZ,
      });
      this.lastTrackCommit =
        outcome.goal !== null && track.joinsAt(outcome.goal) ? "joined" : "laid";
    }
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
      pendingItem: null,
      connectorGaps: [],
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
    this.update({
      mode: "select",
      activeItem: null,
      pendingItem: null,
      roadStroke: null,
      roadErase: false,
    });
  }

  chooseItem(id: string | null): void {
    if (id !== null && this.state.readOnly) return;
    this.queueClick(null);
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
    const loaded = refId === null ? null : (this.catalog.placeables()[refId] ?? null);
    if (id !== null && refId !== null && (!loaded || !this.connectorTables.loaded(loaded))) {
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
    this.activeTrain = placeable ? this.catalog.playModel(placeable) : null;
    this.trainAim = null;
    this.ghostOnRails = false;
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
      connectorGaps: placeable
        ? (this.connectorTables.loaded(placeable)?.withoutRecords ?? [])
        : [],
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
      connectorGaps: [],
    });
    void this.catalog
      .load(refId)
      .then((placeable) => this.connectorTables.load(placeable))
      .then(
        () => {
          if (this.state.pendingItem !== id) return;
          const queued = this.queuedClick;
          this.chooseItem(id);
          if (queued?.item === id) this.commitQueuedClick(queued);
        },
        (error: unknown) => {
          if (this.state.pendingItem !== id) return;
          this.queueClick(null);
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
    const joins = track.joinedPairs();
    const change = track.pieceChange(held.catalogIndex, snap.placement);
    this.show(this.history.commit("lay-track", [], change), eventTimeMs);
    this.lastTrackCommit = track.joinedPairs() > joins ? "joined" : "laid";
    this.held = { ...held, snap: null };
    this.showHeldPiece();
    this.update({ track: this.trackView() });
  }

  private applyTrack(change: TrackChange): RebuildReport {
    const track = this.track;
    if (!track || change.lift.length + change.lay.length === 0) return NOTHING_REBUILT;
    if (track.dragView()) {
      track.cancelDrag();
      this.backend.setGhost(null);
    }
    let instances = 0;
    let studs = 0;
    const chunks = track.applyTrack(change);
    for (const key of chunks) {
      const chunk = track.chunkInstances(key);
      if (!chunk) {
        this.backend.deleteChunk(key);
        continue;
      }
      this.backend.setChunk(key, chunk);
      instances += chunk.count;
      studs += chunk.studs.count;
    }
    this.showTrackEnds(null);
    return { chunks: chunks.length, instances, studs };
  }

  private switchHolder(placement: number): string | null {
    const standing = this.railYard.standingOn(placement);
    return standing ? this.placeableAt(standing.pose.refId).label : null;
  }

  private refuseThrow(holder: string, x: number, z: number): void {
    const reason = `${holder} stands on this switch, so it can't be thrown under it.`;
    this.refuse(TRACK_ITEM_ID, x, z, 0, reason);
  }

  private throwRefused(next: EditSummary | null): boolean {
    if (next?.kind !== "throw-switch") return false;
    const holder = this.switchHolder(next.switchAt);
    if (holder === null) return false;
    const lever = this.track?.switchLevers().find((view) => view.placement === next.switchAt);
    this.refuseThrow(holder, Math.round(lever?.xLdu ?? 0), Math.round(lever?.zLdu ?? 0));
    return true;
  }

  private throwSwitchAt(xLdu: number, zLdu: number, eventTimeMs: number): boolean {
    const placement = this.track?.switchAt(xLdu, zLdu) ?? null;
    return placement !== null && this.throwSwitch(placement, xLdu, zLdu, eventTimeMs);
  }

  private throwSwitch(placement: number, xLdu: number, zLdu: number, eventTimeMs: number): boolean {
    const track = this.track;
    if (!track || this.state.readOnly) return false;
    const holder = this.switchHolder(placement);
    if (holder !== null) {
      this.refuseThrow(holder, Math.round(xLdu), Math.round(zLdu));
      return true;
    }
    const thrown = track.switchThrow(placement);
    if (!thrown) return false;
    this.show(this.history.commit("throw-switch", [], thrown.change), eventTimeMs, {
      item: `switch #${placement + 1}`,
      rot: 0,
      x: Math.round(xLdu),
      z: Math.round(zLdu),
    });
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
    this.trainAim = this.activeTrain
      ? this.railYard.aim(this.activeTrain, this.ray, this.placeRot % 2 === 1)
      : null;
    const aim = this.trainAim;
    if (aim && aim.kind !== "off") {
      this.hoverRefusal = aim.kind === "refused" ? aim.reason : null;
      const seat = aim.seat;
      if (seat) {
        const ghost = this.railYard.ghost(seat);
        this.backend.setGhost(ghost.instances);
        this.backend.placeGhost(ghost.x, 0, ghost.z, 0);
        this.ghostOnRails = true;
        return;
      }
    }
    if (this.ghostOnRails) {
      this.ghostOnRails = false;
      this.backend.setGhost({ ...this.active.parts, studs: this.active.studs });
    }
    if (aim && aim.kind === "refused") {
      this.backend.placeGhost(this.hoverX, GHOST_LIFT_LDU, this.hoverZ, this.placeRot);
      return;
    }
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
      onRails: this.active !== null && this.trainAim !== null && this.trainAim.kind !== "off",
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
    const queued = this.queuedClick;
    if (queued && !(this.hovering && this.onQueuedCell(queued))) this.queueClick(null);
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
    this.queueClick(null);
    this.update({ hover: null });
  }

  private onQueuedCell(queued: QueuedClick): boolean {
    return snapToLattice(this.hitX) === queued.x && snapToLattice(this.hitZ) === queued.z;
  }

  private queueClick(queued: QueuedClick | null): void {
    if (queued === null && this.queuedClick === null) return;
    this.queuedClick = queued;
    this.update({
      queuedPlacement:
        queued === null ? null : { item: queued.item, x: queued.x, z: queued.z, rot: queued.rot },
    });
  }

  private commitQueuedClick(queued: QueuedClick): void {
    const holding = this.active !== null && !this.state.readOnly && this.state.pendingItem === null;
    if (!holding || !this.groundHit(queued.ndcX, queued.ndcY)) return;
    if (!this.onQueuedCell(queued)) return;
    this.pointerMove(queued.ndcX, queued.ndcY);
    this.click(queued.ndcX, queued.ndcY, queued.eventTimeMs);
  }

  click(ndcX: number, ndcY: number, eventTimeMs: number): void {
    if (this.state.mode === "road") return;
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
      this.queueClick({
        item: pendingItem,
        x: snapToLattice(this.hitX),
        z: snapToLattice(this.hitZ),
        rot: this.placeRot,
        ndcX,
        ndcY,
        eventTimeMs,
      });
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
      const aim = this.trainAim;
      if (aim?.kind === "seat") {
        this.show(
          this.history.placeConsist({
            refId: this.activeRefId,
            colorId: this.active.worldColor,
            anchor: aim.seat.anchor,
          }),
          eventTimeMs,
        );
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
    const train = this.railYard.pick(this.ray);
    const trackHit = this.track?.pieceOnRay(this.ray) ?? null;
    const trainT = train?.t ?? Number.POSITIVE_INFINITY;
    const trackT = trackHit?.distance ?? Number.POSITIVE_INFINITY;
    if (train && trainT < bestT && trainT <= trackT) {
      this.selectTrain(train.handle);
      return;
    }
    if (trackHit && trackT < bestT) {
      this.clickTrack(trackHit.placement, ndcX, ndcY, eventTimeMs);
      return;
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

  private clickTrack(placement: number, ndcX: number, ndcY: number, eventTimeMs: number): void {
    if (this.groundHit(ndcX, ndcY)) this.throwSwitch(placement, this.hitX, this.hitZ, eventTimeMs);
    this.selectTrack(placement);
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
    const undo = this.history.nextUndo();
    const redo = this.history.nextRedo();
    return {
      undo: undo?.kind ?? null,
      redo: redo?.kind ?? null,
      undoLabel: editLabel(undo),
      redoLabel: editLabel(redo),
      undoDepth: this.history.undoDepth,
      redoDepth: this.history.redoDepth,
    };
  }

  private placeableAt(refId: number): Placeable {
    const placeable = this.catalog.placeables()[refId];
    if (!placeable) throw new Error(`no catalog item has ref id ${refId}`);
    return placeable;
  }

  private show(
    edit: AppliedEdit,
    eventTimeMs: number,
    sample: EditSample | null = this.sampleOf(edit),
  ): ViewUpdate {
    this.applyConsists(edit);
    const view = this.placed.apply(edit, (refId) => this.placeableAt(refId));
    for (const model of view.removed) this.unsearchable(model);
    for (const model of view.added) this.searchable(model);
    const { added } = view;
    for (let i = 0; i < added.length; i++) {
      const placeable = added[i]?.placeable;
      if (!placeable || this.seenEarlier(added, i, placeable)) continue;
      this.requestMeshes(placeable);
      this.requestFarModel(placeable);
    }
    const trackChanged = edit.track.lift.length + edit.track.lay.length > 0;
    const track = this.applyTrack(edit.track);
    const worldChanged = edit.changes.length > 0 || !trackChanged;
    if (worldChanged) this.session.placementsEdited(edit);
    if (trackChanged) this.session.trackEdited(edit.track.lift);
    if (sample) {
      this.timeEdit({
        ...sample,
        step: edit.step,
        action: edit.kind,
        startMs: eventTimeMs,
        rebuiltMs: performance.now(),
        report: {
          chunks: view.report.chunks + track.chunks,
          instances: view.report.instances + track.instances,
          studs: view.report.studs + track.studs,
        },
      });
    }
    this.refreshRoads();
    this.syncModelTrack();
    if (trackChanged) this.railsChanged();
    this.refreshTrains();
    this.placeGhost();
    this.update({
      selectionRefusal: null,
      placements: this.world.size,
      hover: this.hoverView(),
      studs: this.placed.studTotals(),
      history: this.historyView(),
      track: this.trackView(),
    });
    if (worldChanged) {
      writeViewUpdate(this.planDelta, view);
      this.plans.apply(this.planDelta);
    }
    if (trackChanged && this.track) {
      writeTrackChange(this.planDelta, this.track, edit.track);
      this.plans.apply(this.planDelta);
    }
    return view;
  }

  private seenEarlier(
    models: ReadonlyArray<PlacedModel>,
    before: number,
    placeable: Placeable,
  ): boolean {
    for (let i = 0; i < before; i++) {
      if (models[i]?.placeable === placeable) return true;
    }
    return false;
  }

  private applyConsists(edit: AppliedEdit): void {
    for (const change of edit.consists) {
      if (change.removed) {
        this.railYard.remove(change.removed);
        this.consistRefs.delete(change.removed);
      }
      if (change.added) {
        this.consistRefs.set(change.added, change.consist);
        this.parkConsist(change.added);
      }
    }
  }

  private parkConsist(handle: ConsistHandle): void {
    const placeable = this.placeableAt(handle.pose.refId);
    const model = this.catalog.playModel(placeable);
    if (!model) return;
    this.requestMeshes(placeable);
    this.railYard.add(handle, model);
  }

  private sampleOf(edit: AppliedEdit): EditSample | null {
    const primary = edit.changes[0];
    const pose = primary?.to ?? primary?.from ?? null;
    if (pose) return { item: this.placeableAt(pose.refId).id, rot: pose.rot, x: pose.x, z: pose.z };
    const piece = edit.track.lay[0] ?? edit.track.lift[0];
    const track = this.track;
    if (!piece || !track) return null;
    const studs = zeta16ToStuds(piece.pose.position);
    return {
      item: `${TRACK_PIECE_PREFIX}${track.pieceByIndex(piece.piece).piece.id}`,
      rot: piece.pose.heading,
      x: Math.round(studs.x * STUD_LDU),
      z: Math.round(studs.z * STUD_LDU),
    };
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
    const onRails = new Set(this.railYard.trains().map((train) => train.handle));
    this.update({
      trains: this.consists.consists().map((handle) => {
        const placeable = this.placeableAt(handle.pose.refId);
        return { item: placeable.id, label: placeable.label, onRails: onRails.has(handle) };
      }),
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

  setShowGrid(show: boolean): void {
    this.ground.setShowGrid(show);
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
      const region = scope.kind === "region" ? scope.region : null;
      let placements =
        countPlacements(this.world, contents, counter, region) +
        (this.track?.countParts(counter, region) ?? 0);
      for (const handle of this.consists.consists()) {
        const box = this.railYard.box(handle);
        if (region && !box) continue;
        if (box && region) {
          const x = (box.minX + box.maxX) / 2;
          const z = (box.minZ + box.maxZ) / 2;
          if (x < region.minX || x >= region.maxX || z < region.minZ || z >= region.maxZ) continue;
        }
        contents.addTo(counter, handle.pose.refId, handle.pose.colorId);
        placements++;
      }
      return {
        name: EDITOR_WORLD_NAME,
        lod: "standard",
        placements,
        counter,
        uncounted: uncounted(),
      };
    }
    const piece = this.selectedTrack;
    if (piece !== null && this.track) {
      this.track.countPiece(counter, piece);
      return {
        name: `selection-${this.track.laidPieceView(piece).piece.replace(FILE_NAME_UNSAFE, "_")}`,
        lod: "standard",
        placements: 1,
        counter,
        uncounted: [],
      };
    }
    const train = this.selectedTrain;
    const selected = this.selected;
    const chosen = train?.live
      ? { refId: train.pose.refId, colorId: train.pose.colorId }
      : selected?.handle.live
        ? { refId: selected.handle.refId, colorId: selected.handle.colorId }
        : null;
    if (!chosen) throw new Error("nothing is selected");
    contents.addTo(counter, chosen.refId, chosen.colorId);
    return {
      name: `selection-${this.placeableAt(chosen.refId).id.replace(FILE_NAME_UNSAFE, "_")}`,
      lod: "standard",
      placements: 1,
      counter,
      uncounted: uncounted(),
    };
  }

  private selectTrack(placement: number): void {
    const track = this.track;
    if (!track) return;
    const piece = track.laidPieceView(placement);
    this.selected = null;
    this.selectedTrain = null;
    this.selectedTrack = placement;
    this.backend.setSelectionBox(piece.box);
    this.update({
      selectionRefusal: null,
      selection: {
        kind: "track",
        item: `${TRACK_PIECE_PREFIX}${piece.piece}`,
        x: Math.round(piece.xLdu),
        z: Math.round(piece.zLdu),
        yPlates: piece.yPlates,
        chunkKey: piece.chunkKey,
        slot: placement,
        box: piece.box,
      },
    });
  }

  private select(model: PlacedModel | null): void {
    this.selected = model;
    this.selectedTrain = null;
    this.selectedTrack = null;
    this.backend.setSelectionBox(model ? model.box : null);
    this.update({
      selectionRefusal: null,
      selection: model
        ? {
            kind: "model",
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

  private selectTrain(handle: ConsistHandle): void {
    const box = this.railYard.box(handle);
    const placeable = this.placeableAt(handle.pose.refId);
    const train = this.railYard.trains().find((candidate) => candidate.handle === handle);
    if (!box || !train) {
      this.select(null);
      return;
    }
    this.selected = null;
    this.selectedTrack = null;
    this.selectedTrain = handle;
    this.backend.setSelectionBox(box);
    this.update({
      selectionRefusal: null,
      selection: {
        kind: "train",
        item: placeable.id,
        vehicles: train.consist.vehicles.length,
        lengthLdu: train.consist.vehicles.reduce((sum, vehicle) => sum + vehicle.spec.lengthLdu, 0),
        box,
      },
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
    const passenger = this.trainOnTrackOf(model);
    if (passenger) {
      refuseTurn(
        `${label}: ${passenger} stands on its track, so turning it would leave the train off the rails.`,
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

  removeTrain(index: number, eventTimeMs: number): void {
    if (this.state.readOnly) return;
    const handle = this.consists.consists()[index];
    const ref = handle ? this.consistRefs.get(handle) : undefined;
    if (!ref) return;
    if (this.selectedTrain === handle) this.select(null);
    this.show(this.history.removeConsist(ref), eventTimeMs);
  }

  deleteSelection(eventTimeMs: number): void {
    if (this.state.readOnly) return;
    const train = this.selectedTrain;
    const trainRef = train ? this.consistRefs.get(train) : undefined;
    if (trainRef) {
      this.show(this.history.removeConsist(trainRef), eventTimeMs);
      this.select(null);
      return;
    }
    const piece = this.selectedTrack;
    if (piece !== null) {
      this.deleteTrackPiece(piece, eventTimeMs);
      return;
    }
    const model = this.selected;
    if (!model) return;
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
    const passenger = this.trainOnTrackOf(model);
    if (passenger) {
      const reason = `${model.placeable.label}: ${passenger} stands on its track, so deleting it would leave the train off the rails. Delete ${passenger} first.`;
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

  private deleteTrackPiece(placement: number, eventTimeMs: number): void {
    const track = this.track;
    if (!track || this.state.readOnly) return;
    const standing = this.railYard.standingOn(placement);
    if (standing) {
      const train = this.placeableAt(standing.pose.refId).label;
      const piece = track.laidPieceView(placement);
      const reason = `${train} stands on this track piece, so deleting it would leave the train off the rails. Delete ${train} first.`;
      this.refuse(
        `${TRACK_PIECE_PREFIX}${piece.piece}`,
        Math.round(piece.xLdu),
        Math.round(piece.zLdu),
        0,
        reason,
      );
      this.update({ selectionRefusal: `Can't delete. ${reason}` });
      return;
    }
    this.show(this.history.commit("remove", [], track.removal(placement)), eventTimeMs);
    this.select(null);
  }

  undo(eventTimeMs: number): void {
    if (this.state.readOnly || this.throwRefused(this.history.nextUndo())) return;
    this.replay(this.history.undo(), eventTimeMs);
  }

  redo(eventTimeMs: number): void {
    if (this.state.readOnly || this.throwRefused(this.history.nextRedo())) return;
    this.replay(this.history.redo(), eventTimeMs);
  }

  private replay(edit: AppliedEdit | null, eventTimeMs: number): void {
    if (!edit) return;
    const selected = this.selected;
    const selectedTrain = this.selectedTrain;
    const restored = this.show(edit, eventTimeMs).added.at(-1);
    if (this.held) this.showHeldPiece();
    if (this.active) return;
    const restoredTrain = edit.consists.at(-1)?.added;
    const [restoredPiece, ...more] = edit.track.lay;
    const restoredTrack = edit.kind === "remove" && restoredPiece && more.length === 0;
    if (restored) this.select(restored);
    else if (restoredTrain) this.selectTrain(restoredTrain);
    else if (restoredTrack) this.selectTrack(restoredPiece.index);
    else if (selected && !selected.handle.live) this.select(null);
    else if (selectedTrain && !selectedTrain.live) this.select(null);
    else if (this.selectedTrack !== null && edit.track.lift.length > 0) this.select(null);
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
      consists: this.consistRecords(),
    };
  }

  private consistRecords(): ReadonlyArray<ConsistRecordV1> {
    return this.consists.consists().map(({ pose }) => ({
      ref: this.catalog.refs()[pose.refId] ?? "",
      color: pose.colorId,
      track: this.pieceRecord(pose.anchor.track),
      route: pose.anchor.route,
      reversed: pose.anchor.reversed,
      offsetLdu: pose.anchor.offsetLdu,
    }));
  }

  private pieceRecord(track: TrackPieceRef): ConsistPieceV1 {
    switch (track.kind) {
      case "laid":
        return laidPieceRecord(this.trackCatalog?.pieces ?? [], track);
      case "carried": {
        const { refId, colorId, x, z, yPlates, rot } = track.carrier;
        const ref = this.catalog.refs()[refId] ?? "";
        return { on: "model", ref, color: colorId, x, z, yPlates, rot, piece: track.piece };
      }
      default: {
        const unhandled: never = track;
        throw new Error(`unhandled track piece ref ${String(unhandled)}`);
      }
    }
  }

  private pieceRef(record: ConsistPieceV1): TrackPieceRef | null {
    switch (record.on) {
      case "track":
        return laidPieceRef(this.trackCatalog?.pieces ?? [], record);
      case "model": {
        const target = this.catalog.resolveRef(record.ref, record.color);
        if (!target) return null;
        const { x, z, yPlates, rot, piece } = record;
        const carrier = { refId: target.refId, colorId: target.colorId, x, z, yPlates, rot };
        return { kind: "carried", carrier, piece };
      }
      default: {
        const unhandled: never = record;
        throw new Error(`unhandled consist piece ${String(unhandled)}`);
      }
    }
  }

  placedCredits(): ReadonlyArray<ModelCredit> {
    return this.placed
      .models()
      .flatMap((model) => (model.placeable.credit ? [model.placeable.credit] : []));
  }

  private connectedOf(placeable: Placeable): Connected {
    let connected = this.connected.get(placeable);
    if (!connected) {
      const tables = this.connectorTables.loaded(placeable);
      if (!tables) throw new Error(`${placeable.id} has no connector tables loaded yet`);
      const parts = this.catalog.parts();
      const boxes = partBoxes(placeable.partBoxes);
      connected = {
        model: this.search.model(
          tables.tables,
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
    if (this.searchIds.has(model)) return;
    if (!this.connectorTables.loaded(model.placeable)) {
      this.connectorTables.load(model.placeable).then(
        () => {
          if (this.placed.models().includes(model)) this.searchable(model);
        },
        (error: unknown) => {
          if (!this.placed.models().includes(model)) return;
          this.update({
            catalogError: `${model.placeable.label}'s connector records can't be read: ${errorText(error)}`,
          });
        },
      );
      return;
    }
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
    this.heldRanges.clear();
    const held: FramedTrackPiece[] = [];
    let nextRunFrame = WORLD_TRACK_FRAME.id + 1;
    for (const model of carrying) {
      const track = this.trackOf(model.placeable);
      const { x, z, yPlates, rot } = model.handle;
      const frame = latticeFrame(x, z, rot);
      if (!track || !frame) continue;
      const first = held.length;
      held.push(
        ...heldPieces(track, frame, yPlates),
        ...heldRuns(track, frame, yPlates, nextRunFrame),
      );
      this.heldRanges.set(model, [first, held.length]);
      nextRunFrame += track.runs.length;
    }
    drawing.syncHeld(held);
    this.showTrackEnds(null);
    this.railsChanged();
    this.update({ track: this.trackView() });
  }

  private trainOnTrackOf(model: PlacedModel): string | null {
    const range = this.heldRanges.get(model);
    const laid = this.track?.pieceCount ?? 0;
    if (!range) return null;
    for (let p = laid + range[0]; p < laid + range[1]; p++) {
      const standing = this.railYard.standingOn(p);
      if (standing) return this.placeableAt(standing.pose.refId).label;
    }
    return null;
  }

  private railsChanged(): void {
    const track = this.track;
    const laid = track?.pieceCount ?? 0;
    const carriers = this.heldTrackModels.flatMap((model) => {
      const range = this.heldRanges.get(model);
      if (!range) return [];
      const { refId, colorId, x, z, yPlates, rot } = model.handle;
      const pose = { refId, colorId, x, z, yPlates, rot };
      return [{ pose, first: laid + range[0], count: range[1] - range[0] }];
    });
    this.railYard.setTrack(track?.playTrack() ?? null, carriers);
    this.refreshTrains();
  }

  validate(stored: StoredContents): ReadonlyArray<Issue> {
    const restored = this.restore(stored);
    return restored.ok ? [] : restored.issues;
  }

  async load(stored: StoredContents): Promise<ReadonlyArray<Issue>> {
    await this.ensureStoredPlaceables(stored);
    const restored = this.restore(stored);
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
    this.railsChanged();
    for (const consist of restored.value.consists) {
      const handle = this.consists.add(consist);
      this.consistRefs.set(handle, this.history.adoptConsist(handle));
      this.parkConsist(handle);
    }
    this.refreshTrains();
    const fullRebuild = new PlanDelta();
    writeFullRebuild(fullRebuild, this.placed.models(), this.track);
    this.plans.apply(fullRebuild);
    return [];
  }

  private restore({ shards, consists }: StoredContents): Decoded<RestoredWorld> {
    const world = new World();
    const handles = addShards(world, shards, (ref, color) => this.catalog.resolveRef(ref, color));
    if (!handles.ok) return handles;
    const track = this.newTrack?.() ?? null;
    const restored = track?.restore(worldTrack(shards));
    if (restored && !restored.ok) return restored;
    const issues: Issue[] = [];
    const poses: ConsistPose[] = [];
    consists.forEach((record, index) => {
      const path = `consist ${index}`;
      const target = this.catalog.resolveRef(record.ref, record.color);
      const placeable = target ? this.catalog.placeables()[target.refId] : null;
      const piece = this.pieceRef(record.track);
      if (!target) issues.push({ path, message: `"${record.ref}" isn't in the catalog` });
      else if (placeable && !this.catalog.playModel(placeable)) {
        issues.push({ path, message: `${placeable.label} has no running gear to stand on rails` });
      }
      if (!piece) {
        issues.push({ path, message: `"${record.track.ref}" isn't a track piece or a model` });
      }
      if (!target || !piece) return;
      const pose: ConsistPose = {
        refId: target.refId,
        colorId: target.colorId,
        anchor: {
          track: piece,
          route: record.route,
          reversed: record.reversed,
          offsetLdu: record.offsetLdu,
        },
      };
      const problem = consistPoseProblem(pose);
      if (problem) issues.push({ path, message: problem });
      else poses.push(pose);
    });
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: { world, handles: handles.value, track, consists: poses } };
  }

  private replaceWorld({ world, handles, track }: RestoredWorld): void {
    this.select(null);
    this.placed.clear();
    this.railYard.clear();
    this.consistRefs.clear();
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
    this.consists = new ConsistLayout();
    this.history = new EditHistory(world, this.consists);
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

  async rollingDiagnostics(item: string): Promise<RollingDiagnosticsPanel | null> {
    const view = await this.catalog.rollingDiagnostics(item);
    return view === null ? null : rollingDiagnosticsPanel(view);
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
      laidTrack: this.track?.records() ?? [],
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

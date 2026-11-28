import type { BundleColor, BundleLod } from "@brr/schema/bundle";
import {
  PART_BUNDLE_LOADER,
  type IPartBundleLoader,
  type ModelCells,
  type PartModelLattice,
} from "@brr/catalog";
import { NO_MESHES, type MeshProgress } from "./mesh-progress.ts";
import {
  BomCounter,
  WORLD_TRACK_FRAME,
  countPlacements,
  EditHistory,
  NO_ROW,
  PlanDelta,
  placementKeyText,
  RoadFit,
  World,
  addShards,
  shardPoses,
  ConsistLayout,
  consistPoseProblem,
  type AppliedEdit,
  type ConsistHandle,
  type ConsistPose,
  type ConsistRef,
  NO_TRACK_CHANGE,
  tableTypeSize,
  type TrackPieceAt,
  type TrackPieceRef,
  type EditKind,
  type EditSummary,
  type EventChange,
  type HistoryStep,
  type NoteChange,
  type PlanChange,
  type PlanState,
  type PlacementHandle,
  type PlacementKey,
  type PlacementContents,
  type PlacementPose,
  type PlacementRegion,
  type PlacementRequest,
  type PlateHeights,
  type RoadEdgeSegment,
  type RoadJoinReport,
  type RoadPlacement,
  type RoadSurface,
  type TrackChange,
  MateReport,
  type LatticePose,
  type OverlapHit,
  type SnapShapes,
  roadwayCells,
  PartTally,
  type PartSink,
  outlinesOverlap,
  GENDER_MALE,
  NO_SHAPE,
  type ModelConnectors,
} from "@brr/domain";
import {
  BRICK_LDU,
  CHUNK_LDU,
  IDENTIFICATION_ACCEPTED_DEVIATION_LDU,
  PLATE_LDU,
  SIXTEENTHS_PER_LDU,
  STUD_LDU,
  isLatticePose,
  pose16Equals,
  zeta16ToStuds,
  type Pose16,
  planeHypot,
} from "@brr/math";
import {
  PLAN_SCENE_BACKEND,
  PROJECTION_FLOATS,
  RAY_FLOATS,
  SCENE_BACKEND,
  type BackendInfo,
  type EdgeMarker,
  type ChunkTier,
  type GhostVerdict,
  type GraphicsApi,
  type ChunkInstances,
  type IPlanSceneBackend,
  type LookSettings,
  type ISceneBackend,
  type WorldBox,
} from "@brr/render";
import type { Decoded, Issue } from "@brr/schema/decode";
import type { ImportReport, LayoutPart, StudioReport } from "@brr/import";
import {
  importRef,
  importedSha256,
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
import { ShoppingListBuilder, type ShoppingList } from "../bom/shopping-list.ts";
import type { IPlanSheetSource, PlanSheetShapes } from "../plan/plan-sheet-service.ts";
import { dumpPlacements, type PlacementDump } from "../scene/placements.ts";
import type { ModelCredit } from "../scene/viewer-scene.ts";
import type { IEventDetails } from "../event/event-details.ts";
import {
  CONNECTOR_TABLES,
  EDITOR_FRAME_LOOP,
  EVENT_DETAILS,
  PLACEABLE_CATALOG,
  PLACEMENT_SEARCH,
  RAIL_YARD,
  ROAD_EDIT_SESSION,
  TALLEST_TRAIN,
  TRACK_PIERS,
  SNAP_SHAPES,
  TRACK_EDIT_SESSION,
  TRACK_PATH_SELECTION,
  TRACK_WORLD,
  WORLD_SESSION,
} from "../tokens.ts";
import { NOTHING_REBUILT, type ITrackWorld } from "./track-world.ts";
import type { ITrackPathSelection, TrackPathScope } from "./track-path-selection.ts";
import {
  TRACK_PIECE_PREFIX,
  type ExtensionAttempt,
  type ITrackEditSession,
  type SwitchAttempt,
  type SwitchThrowRequest,
  type TrackEditView,
  type TrackLayRequest,
  type TrackClickRefusal,
} from "./track-edit-session.ts";
import type { RoadNeighbourhood } from "./road-drawing.ts";
import type { IRoadEditSession, RoadEditView } from "./road-edit-session.ts";
import type { ITrackPiers, PierPiece } from "./track-piers.ts";
import type { ITallestTrain } from "../trains/tallest-train.ts";
import type { TrackSupport } from "./track-support.ts";
import type { FrameLoopView, FrameTimes, IEditorFrameLoop } from "./editor-frame-loop.ts";
import type { IConnectorTables, PartWithoutConnectorRecord } from "../connect/connector-tables.ts";
import {
  type CatalogItemView,
  type CheckedStuds,
  type IPlaceableCatalog,
  type SkippedCatalogModel,
} from "../catalog/placeable-catalog.ts";
import {
  heldPieces,
  heldRuns,
  latticeFrame,
  type FramedTrackPiece,
} from "../connect/model-track-ends.ts";
import { partBoxes } from "../connect/part-boxes.ts";
import { FrozenTechnic } from "../connect/frozen-technic.ts";
import type {
  HoverRefusalHit,
  HoverWait,
  PlacedModelView,
  PlacementHover,
  PlacementMode,
} from "./placement-hover.ts";
import { effectivePlacementMode } from "./placement-mode.ts";
import {
  MOVE_CLEAR,
  blockRefusalText,
  failedLoadText,
  mateCounts,
  refusalText,
} from "./placement-hover-view.ts";
import { ghostSettles, ghostVerdict, sameVerdict } from "./placement-feedback.ts";
import { FrozenVolumes } from "../connect/placeable-volumes.ts";
import {
  CLASH_RANK,
  NO_CLASH_PART,
  NO_SKIP,
  PartClash,
  PosedPlaceable,
  clashOut,
} from "../trains/part-clash.ts";
import {
  NOT_WAITING,
  placementChoice,
  type IPlacementSearch,
  type PlacementChoice,
} from "../connect/placement-search.ts";
import type {
  RaisedPiece,
  SolidRects,
  TrackBlockView,
  TrackDrawing,
  TrackRouteView,
} from "./track-drawing.ts";
import type { ExtensionTurn } from "./track-extension.ts";
import { BOX_FLOATS } from "./local-box.ts";
import {
  NO_MODELS,
  ON_TOP_FACE,
  PlacedChunks,
  posedBox,
  posedSeatsStudAt,
  writePosedPartBoxes,
  type PlacedModel,
  type RebuildReport,
  type StudTotals,
  type ViewUpdate,
} from "./placed-chunks.ts";
import type { Placeable } from "./placeable.ts";
import { AssistSession, type AssistHost, type Connected } from "./assist-session.ts";
import {
  CursorPick,
  HELD_TURN_ONLY,
  PRECISE_RADIUS,
  RESTS_ON_TABLE_Y_PLATES,
} from "./cursor-pick.ts";
import { PlanFacts } from "./plan-facts.ts";
import { OBSTACLE_RECT_FLOATS, seatsPending } from "./track-obstacles.ts";
import {
  ANY_TURN,
  HELD_TURN,
  NO_ROAD_SURFACE,
  overlapsPlacedRoad,
  roadOverlapCells,
  snapToRoadEdge,
  type PlacedRoads,
  type ProbedRoad,
  type RestingHeights,
  type RoadSnap,
} from "./road-snap.ts";
import { LiveRoads, roadPlacementOf } from "./live-roads.ts";
import { quarterTurned, type TurnDirection } from "./turn.ts";
import {
  QUAD_FLOATS,
  footprintInside,
  latticeCentre,
  nearestStud,
  pieceTranslated,
  pieceTurnedAbout,
  translated,
  turnedAbout,
  unionBox,
  type LatticePoint,
} from "./group-transform.ts";
import { groupGhost, type GhostMember } from "./group-ghost.ts";
import {
  Selection,
  boxesOf,
  tallyOf,
  type SelectionMember,
  type SelectionTally,
  type SelectionView,
  type SelectionViews,
  type TrackSelectionView,
  type TrainSelectionView,
} from "./selection.ts";
import {
  ANNOTATION_SERVICE,
  EDITOR_CAMERA,
  NOTE_EDIT_SESSION,
  PLAN_SERVICE,
  TABLE_GROUND,
} from "../tokens.ts";
import type { GroundView, ITableGround } from "../ground/table-ground.ts";
import type { IAnnotationService } from "../notes/annotation-service.ts";
import type { INoteEditSession, NoteEditView } from "../notes/note-edit-session.ts";
import {
  noteToolOf,
  type NoteModelView,
  type NotePointer,
  type NoteToolKind,
} from "../notes/note-tool.ts";
import type { IPlanService } from "../plan/plan-service.ts";
import { placementsBox } from "../plan/placements-box.ts";
import {
  appendTrackChange,
  appendViewUpdate,
  writeFullRebuild,
  writeModelUpdates,
} from "../plan/plan-producer.ts";
import type { IEditorCamera } from "../camera/editor-camera.ts";
import type { PlayModel } from "../play/play-models.ts";
import type {
  CoupledEnd,
  IRailYard,
  RailAim,
  RailSeat,
  TrainMember,
  VehicleFootprint,
} from "../trains/rail-yard.ts";
import { laidPieceRecord, laidPieceRef } from "../trains/rail-track.ts";
import { errorText } from "./error-text.ts";
import { boxLabel, type LabelView } from "./size-labels.ts";
import { MeasureTool } from "./measure-tool.ts";
import { guideGridAround, TableTool, type ArmedTable } from "./table-tool.ts";
import {
  FillTool,
  DEFAULT_FILL_GRID_STUDS,
  MAX_FILL_TILES,
  nextFillGrid,
  type FillView,
} from "./fill-tool.ts";
import type {
  ExportedWorld,
  IEditedWorld,
  IWorldFiles,
  IWorldSession,
  ModelFileInput,
  ModelFileOutcome,
  ModelImportNotice,
  PlanContents,
  PlanImport,
  StoredContents,
  StoredPlan,
  WorldContents,
  WorldSessionView,
} from "./world-session.ts";
import {
  rollingDiagnosticsPanel,
  type RollingDiagnosticsPanel,
} from "../inspect/rolling-diagnostics.ts";

export type { TurnDirection } from "./turn.ts";
export type {
  ModelSelectionView,
  SelectionItemView,
  SelectionTally,
  SelectionView,
  TrackSelectionView,
  TrainSelectionView,
} from "./selection.ts";
export type EditorStatus = "loading" | "ready" | "error";
export type EditAction = EditKind;
export type EditorMode = "place" | "select" | "track" | "road" | "measure" | "table" | NoteToolKind;

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

export type SelectDragKind = "box" | "move";

export type GestureView =
  | ({ readonly kind: "box" } & SelectionTally)
  | ({
      readonly kind: "move" | "paste";
      readonly dx: number;
      readonly dz: number;
      readonly refusal: string | null;
    } & SelectionTally);

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

export type RoadSnapState = "snapped" | "free" | "mismatched" | "refused";

export interface RoadSnapView {
  readonly state: RoadSnapState;
  readonly metCells: number;
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

export interface FillResult {
  readonly item: string;
  readonly placed: number;
  readonly refused: number;
  readonly alreadyThere: number;
  readonly reason: string | null;
}

export interface QueuedPlacement {
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly rot: number;
}

interface QueuedClick extends QueuedPlacement {
  readonly mode: PlacementMode;
  readonly ray: Float64Array;
  readonly hitX: number;
  readonly hitZ: number;
  readonly reachLdu: number;
  readonly eventTimeMs: number;
}

export type FarTierStatus = "loading" | "ready" | "unavailable";

export interface RampDump {
  readonly part: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rot: number;
  readonly studMates: number;
}

export interface CrossingDump {
  readonly tracks: ReadonlyArray<number>;
  readonly roads: ReadonlyArray<number>;
  readonly roadwayCells: number;
  readonly ramps: ReadonlyArray<RampDump>;
}

export interface CouplingView {
  readonly end: CoupledEnd;
  readonly train: string;
}

export interface HoverView {
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly refusal: string | null;
  readonly waiting: string | null;
  readonly onRails: boolean;
  readonly couples: CouplingView | null;
  readonly placement: PlacementHover | null;
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

export type ModelImportStatus =
  | "importing"
  | "checking"
  | "placeable"
  | "check-failed"
  | "refused"
  | "held";

export interface ModelImportView {
  readonly file: string;
  readonly status: ModelImportStatus;
  readonly item: string | null;
  readonly reason: string | null;
  readonly report: ImportReport | null;
  readonly studio: StudioReport | null;
}

export interface EditorSnapshot
  extends WorldSessionView, FrameLoopView, GroundView, TrackEditView, RoadEditView, NoteEditView {
  readonly status: EditorStatus;
  readonly error: string | null;
  readonly loadMs: number | null;
  readonly backend: BackendInfo | null;
  readonly catalog: ReadonlyArray<CatalogItemView>;
  readonly catalogSkipped: ReadonlyArray<SkippedCatalogModel>;
  readonly mode: EditorMode;
  readonly activeItem: string | null;
  readonly ghostRot: number;
  readonly hover: HoverView | null;
  readonly selection: SelectionView | null;
  readonly selectionRefusal: string | null;
  readonly gesture: GestureView | null;
  readonly clipboard: number;
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
  readonly placementMode: PlacementMode;
  readonly placementModeOverride: boolean;
  readonly snap: RoadSnapView | null;
  readonly refusedClicks: number;
  readonly lastRefusal: RefusedClick | null;
  readonly bundleVersion: string | null;
  readonly catalogError: string | null;
  readonly modelImport: ModelImportView | null;
  readonly studChecks: number;
  readonly connectorGaps: ReadonlyArray<PartWithoutConnectorRecord>;
  readonly queuedPlacement: QueuedPlacement | null;
  readonly trains: ReadonlyArray<RailTrainView>;
  readonly rulers: number;
  readonly rulerDraft: boolean;
  readonly hoveredTable: string | null;
  readonly armedTable: ArmedTableView | null;
  readonly fillGridStuds: number;
  readonly fillDraft: FillView | null;
  readonly lastFill: FillResult | null;
  readonly labels: ReadonlyArray<LabelView>;
  readonly ghostSettled: boolean;
}

export interface ArmedTableView extends ArmedTable {
  readonly name: string;
  readonly widthMm: number;
  readonly depthMm: number;
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
  readonly cells: Omit<
    ModelCells,
    "footprint" | "flat" | "columnBottom" | "columnTop" | "footing" | "partCells"
  > & {
    readonly footprint: ReadonlyArray<number>;
    readonly flat: ReadonlyArray<number>;
    readonly columnBottom: ReadonlyArray<number>;
    readonly columnTop: ReadonlyArray<number>;
    readonly footing: {
      readonly instance: ReadonlyArray<number>;
      readonly cell: ReadonlyArray<number>;
    };
    readonly partCellEntries: number | null;
  };
}

function cellsView(cells: ModelCells): ModelBakeView["cells"] {
  const { partCells, ...columns } = cells;
  return {
    ...columns,
    footprint: [...cells.footprint],
    flat: [...cells.flat],
    columnBottom: [...cells.columnBottom],
    columnTop: [...cells.columnTop],
    footing: {
      instance: [...cells.footing.instance],
      cell: [...cells.footing.cell],
    },
    partCellEntries: partCells?.instance.length ?? null,
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
  readonly crossings: ReadonlyArray<CrossingDump>;
  readonly studs: StudTotals;
  readonly studChecks: number;
}

export interface EditorOptions {
  readonly api: GraphicsApi;
  readonly pixelRatio: number;
  readonly look: LookSettings;
  readonly tier: ChunkTier | null;
}

export interface IEditor extends IBomSource, IPlanSheetSource, IWorldFiles {
  start(canvas: HTMLCanvasElement, options: EditorOptions): Promise<void>;
  subscribe(listener: () => void): () => void;
  snapshot(): EditorSnapshot;
  chooseItem(id: string | null): void;
  pointerMove(ndcX: number, ndcY: number): void;
  pointerLeave(): void;
  click(ndcX: number, ndcY: number, eventTimeMs: number): void;
  toggleSelected(ndcX: number, ndcY: number): void;
  selectTrackPath(ndcX: number, ndcY: number, scope: TrackPathScope): boolean;
  selectPlacements(keys: ReadonlyArray<PlacementKey>): void;
  selectDragStart(ndcX: number, ndcY: number, additive: boolean): SelectDragKind | null;
  selectDragMove(ndcX: number, ndcY: number): void;
  selectDragEnd(ndcX: number, ndcY: number, eventTimeMs: number): void;
  cancelGesture(): void;
  moveSelectionBy(dx: number, dz: number, eventTimeMs: number): void;
  moveSelectionTo(xStuds: number, zStuds: number, eventTimeMs: number): void;
  turnSelectedModelTo(rot: number, eventTimeMs: number): void;
  copySelection(): void;
  pasteClipboard(): void;
  dragStart(ndcX: number, ndcY: number): boolean;
  dragMove(ndcX: number, ndcY: number): void;
  dragEnd(ndcX: number, ndcY: number, eventTimeMs: number): void;
  rotate(eventTimeMs: number, direction?: TurnDirection): void;
  mirrorPiece(): void;
  cycleConnector(): void;
  extendTrack(turn: ExtensionTurn | null, eventTimeMs: number): void;
  cycleTrackChoice(step: 1 | -1): void;
  raiseTrack(plates: number): void;
  setTrackRampPlates(plates: number): void;
  selectTrackChoice(index: number): void;
  dropTrackEnd(): boolean;
  previewTrackLoop(key: string | null): void;
  closeTrackLoop(key: string | null, eventTimeMs: number): void;
  deleteSelection(eventTimeMs: number): void;
  removeTrain(index: number, eventTimeMs: number): void;
  undo(eventTimeMs: number): void;
  redo(eventTimeMs: number): void;
  setShowJoins(show: boolean): void;
  setShowGrid(show: boolean): void;
  setSnapRoads(snap: boolean): void;
  setPlacementMode(mode: PlacementMode): void;
  setPlacementModeOverride(held: boolean): void;
  goTo(x: number, z: number): void;
  importModelFile(file: ModelFileInput): Promise<boolean>;
  importLayoutFile(file: ModelFileInput): Promise<boolean>;
  measureFrames(): void;
  cycleTier(): void;
  trackRoutes(): ReadonlyArray<TrackRouteView>;
  setRoadErase(erase: boolean): void;
  setMeasuring(on: boolean): void;
  setTableTool(on: boolean): void;
  armTableType(typeId: number | null): void;
  checkLayout(): void;
  setNoteTool(tool: NoteToolKind | null): void;
  finishNote(): void;
  cycleFillGrid(): void;
  fillTables(eventTimeMs: number): void;
  clearRulers(): void;
  projectLabels(out: Float64Array): void;
  rollingDiagnostics(item: string): Promise<RollingDiagnosticsPanel | null>;
  dump(): EditorDump;
}

const EDITOR_LOD: BundleLod = "standard";
const ASSIST_TOLERANCE_PX = 32;
const ASSIST_FLOOR_LDU = STUD_LDU;
const ASSIST_BASIN_LDU = 3 * STUD_LDU;
const LOOP_SCAN_FRAME_BUDGET_MS = 10;
const NDC_SPAN = 2;
const NOTE_PLANE_Y_LDU = 0;
const NO_NOTE_MODELS: ReadonlyArray<NoteModelView> = [];
const HALF_STUD_LDU = STUD_LDU / 2;
const ORIGIN_INTS = 3;

function cellsWithin(reachLdu: number): number {
  return Math.ceil(reachLdu / STUD_LDU);
}

function platesWithin(reachLdu: number): number {
  return Math.floor(reachLdu / PLATE_LDU);
}

function farthestLatticeReachLdu(limitLdu: number): number {
  const limitSquared = limitLdu * limitLdu;
  const studs = Math.floor(limitLdu / STUD_LDU);
  const plates = platesWithin(limitLdu);
  let farthestSquared = 0;
  for (let across = 0; across <= studs; across++) {
    for (let along = 0; along <= across; along++) {
      const planSquared = (across * across + along * along) * STUD_LDU * STUD_LDU;
      for (let up = 0; up <= plates; up++) {
        const squared = planSquared + up * up * PLATE_LDU * PLATE_LDU;
        if (squared <= limitSquared && squared > farthestSquared) farthestSquared = squared;
      }
    }
  }
  return rootNotBelow(farthestSquared);
}

function rootNotBelow(squared: number): number {
  const root = Math.sqrt(squared);
  return root * root >= squared ? root : root * (1 + Number.EPSILON);
}

const DEGREES_PER_QUARTER_TURN = 90;
interface RoadCellCounts {
  readonly mismatchedCells: number;
  readonly overlappingCells: number;
}
const NO_ROAD_CELLS: RoadCellCounts = { mismatchedCells: 0, overlappingCells: 0 };

function sameLatticePose(a: LatticePose, b: LatticePose): boolean {
  return a.x === b.x && a.z === b.z && a.rot === b.rot && a.yPlates === b.yPlates;
}

function roadOverlapText(placeable: Placeable, overlapping: number): string {
  return `${placeable.label}'s road would lie on ${overlapping} studs of placed road there, at the same height. ${MOVE_CLEAR}`;
}

type SeatOnRails = "allowed" | "refused";

interface BomContents extends PlacementContents {
  addPiece(placement: number): void;
}

interface ScopedBom {
  readonly name: string;
  readonly placements: number;
}

interface PlacementCheck {
  aim: RailAim | null;
  yPlates: number;
  waitingOn: number;
  refusal: string | null;
  trackBlock: TrackBlockView | null;
}

function railSeatRefusal(placeable: Placeable): string {
  return `${placeable.label} would stand on the rails there. Set it on the rails with a click.`;
}

function boxAround(boxes: ReadonlyArray<WorldBox>): WorldBox | null {
  const [first, ...rest] = boxes;
  if (!first) return null;
  return rest.reduce(
    (around, box) => ({
      minX: Math.min(around.minX, box.minX),
      minY: Math.min(around.minY, box.minY),
      minZ: Math.min(around.minZ, box.minZ),
      maxX: Math.max(around.maxX, box.maxX),
      maxY: Math.max(around.maxY, box.maxY),
      maxZ: Math.max(around.maxZ, box.maxZ),
    }),
    first,
  );
}

function standsOnTable(model: PlacedModel): boolean {
  return model.handle.yPlates <= RESTS_ON_TABLE_Y_PLATES;
}

function boxesTouch(a: WorldBox, b: WorldBox): boolean {
  return (
    a.minX <= b.maxX &&
    b.minX <= a.maxX &&
    a.minY <= b.maxY &&
    b.minY <= a.maxY &&
    a.minZ <= b.maxZ &&
    b.minZ <= a.maxZ
  );
}

function placementRefused(check: PlacementCheck, seat: SeatOnRails): boolean {
  const kind = check.aim?.kind;
  return (
    kind === "refused" ||
    kind === "waiting" ||
    check.waitingOn !== NOT_WAITING ||
    (seat === "refused" && kind === "seat") ||
    check.refusal !== null ||
    check.trackBlock !== null
  );
}

function placementRefusal(
  placeable: Placeable,
  check: PlacementCheck,
  seat: SeatOnRails,
): string | null {
  const { aim } = check;
  if (aim?.kind === "refused" || aim?.kind === "waiting") return aim.reason;
  if (aim?.kind === "seat") return seat === "refused" ? railSeatRefusal(placeable) : null;
  if (check.refusal) return check.refusal;
  return check.trackBlock ? blockRefusalText(placeable.label, check.trackBlock) : null;
}

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
const REFUSED_SEAT_LIFT_LDU = BRICK_LDU;
const NO_HELD_TRACK: ReadonlyArray<FramedTrackPiece> = [];

interface SolidProbe {
  placeable: Placeable | null;
  x: number;
  z: number;
  rot: number;
  yPlates: number;
}
const HANDLE_TOLERANCE_PX = 8;

interface ModelMember {
  readonly model: PlacedModel | null;
  readonly placeable: Placeable;
  readonly pose: PlacementPose;
  readonly component: number;
}

interface PieceMember {
  readonly index: number | null;
  readonly piece: number;
  readonly pose: Pose16;
  readonly yPlates: number;
  readonly rise: number;
}

interface GroupTargets {
  readonly modelPoses: ReadonlyArray<PlacementPose>;
  readonly piecePoses: ReadonlyArray<Pose16>;
}

interface GroupPlacement extends GroupTargets {
  readonly refusal: RefusedClick | null;
}

type GroupAction = "turn" | "move" | "delete";

const GROUP_EDITS: ReadonlySet<EditKind> = new Set<EditKind>(["place", "rotate", "move", "remove"]);

interface BoxDrag {
  readonly kind: "box";
  readonly startNdcX: number;
  readonly startNdcY: number;
  readonly additive: boolean;
}

interface ModelCheck {
  readonly models: ReadonlyArray<ModelMember>;
  readonly exempt: ReadonlySet<PlacedModel>;
  readonly placedRoads: PlacedRoads;
  readonly trackSkip: TrackSkip;
}

interface GroupEdit extends ModelCheck {
  readonly action: GroupAction;
  readonly pieces: ReadonlyArray<PieceMember>;
  readonly block: RefusedClick | null;
}

interface TrackSkip {
  readonly moving: ReadonlySet<number>;
  readonly owners: ReadonlySet<number>;
}

const NO_TRACK_SKIP: TrackSkip = { moving: new Set(), owners: new Set() };

interface HeldGroup extends GroupEdit {
  readonly kind: "move" | "paste";
  readonly frameModel: number | null;
  readonly frame: PlacementPose;
  readonly grabX: number;
  readonly grabZ: number;
  readonly placement: GroupPlacement | null;
}

interface Copied {
  readonly models: ReadonlyArray<ModelMember>;
  readonly pieces: ReadonlyArray<PieceMember>;
  readonly pivot: LatticePoint;
}

type ModelStranding =
  | { readonly kind: "none" }
  | { readonly kind: "stranded"; readonly model: PlacedModel }
  | { readonly kind: "waiting"; readonly model: PlacedModel; readonly failed: boolean };

const NOT_STRANDED: ModelStranding = { kind: "none" };

const ACTION_VERBS: Readonly<Record<GroupAction, string>> = {
  turn: "turning",
  move: "moving",
  delete: "deleting",
};

const NO_OFFSET = { dx: 0, dz: 0 } as const;
const TABLE_Y_LDU = RESTS_ON_TABLE_Y_PLATES * PLATE_LDU;

class FixedHeight implements RestingHeights {
  yLdu = TABLE_Y_LDU;

  restingYLdu(): number {
    return this.yLdu;
  }
}

interface KeptRoadSnap {
  readonly item: string;
  readonly cursorX: number;
  readonly cursorZ: number;
  readonly ghostRot: number;
  readonly revision: number;
  readonly placedRoads: PlacedRoads;
  readonly pose: LatticePose;
  readonly view: RoadSnapView;
}

interface RoadOverlap {
  readonly reason: string;
  readonly counts: RoadCellCounts;
}

class RoadSnapQuery {
  surface: RoadSurface | null = null;
  rot = 0;
  direction = 0;
  turns = 0;
  cursorX = 0;
  cursorZ = 0;
  revision = -1;
  placedRoads: PlacedRoads | null = null;
  snap: RoadSnap | null = null;

  answers(
    surface: RoadSurface,
    rot: number,
    direction: number,
    turns: number,
    cursorX: number,
    cursorZ: number,
    revision: number,
    placedRoads: PlacedRoads,
  ): boolean {
    return (
      this.surface === surface &&
      this.rot === rot &&
      this.direction === direction &&
      this.turns === turns &&
      this.cursorX === cursorX &&
      this.cursorZ === cursorZ &&
      this.revision === revision &&
      this.placedRoads === placedRoads
    );
  }

  remember(
    surface: RoadSurface,
    rot: number,
    direction: number,
    turns: number,
    cursorX: number,
    cursorZ: number,
    revision: number,
    placedRoads: PlacedRoads,
    snap: RoadSnap | null,
  ): void {
    this.surface = surface;
    this.rot = rot;
    this.direction = direction;
    this.turns = turns;
    this.cursorX = cursorX;
    this.cursorZ = cursorZ;
    this.revision = revision;
    this.placedRoads = placedRoads;
    this.snap = snap;
  }
}
const WHOLE_GROUP_COMPONENT = 0;
const NO_PIECES: ReadonlyArray<PieceMember> = [];
const NO_LIFTED: ReadonlyArray<PlacedModel> = [];
const NOTHING_DRAWN = "nothing in the file is drawn";
const WORLD_FRAME: PlacementPose = { refId: -1, colorId: -1, x: 0, z: 0, yPlates: 0, rot: 0 };
const PASTE_REFUSED = "Can't paste here.";
const DELETE_REFUSED = "Can't delete.";
const GROUP_TURN_REFUSED = "Can't turn the group.";
const PIECE_TURN_REFUSED = "Can't turn it.";
const SEATS_PENDING =
  "a model under the track is still checking its studs, so track can't move onto it yet";

function poseOf(model: PlacedModel): PlacementPose {
  const { handle } = model;
  return {
    refId: handle.refId,
    colorId: handle.colorId,
    x: handle.x,
    z: handle.z,
    yPlates: handle.yPlates,
    rot: handle.rot,
  };
}

function partTopsLdu(boxes: Float32Array): readonly [number, number] {
  let lowest = Number.POSITIVE_INFINITY;
  let highest = Number.NEGATIVE_INFINITY;
  for (let b = 0; b < boxes.length; b += BOX_FLOATS) {
    const top = boxes[b + 4] ?? 0;
    lowest = Math.min(lowest, top);
    highest = Math.max(highest, top);
  }
  return [lowest, highest];
}

function liesUnder(model: PlacedModel, topLdu: number): boolean {
  const [, highest] = partTopsLdu(model.placeable.partBoxes);
  return model.handle.yPlates * PLATE_LDU + highest <= topLdu;
}

interface LayoutPiece {
  readonly refId: number;
  readonly placeable: Placeable;
}

interface LayoutMembers {
  readonly members: ReadonlyArray<ModelMember>;
  readonly leftOut: ReadonlyArray<string>;
}

function layoutMembers(pieces: ReadonlyArray<LayoutPiece>): LayoutMembers {
  const [anchor] = pieces;
  if (!anchor) return { members: [], leftOut: [] };
  const [anchorX, anchorY, anchorZ] = anchor.placeable.frameShift;
  const members: ModelMember[] = [];
  const leftOut: string[] = [];
  for (const { refId, placeable } of pieces) {
    const [shiftX, shiftY, shiftZ] = placeable.frameShift;
    const plates = (anchorY - shiftY) / PLATE_LDU;
    const yPlates = Math.round(plates);
    if (Math.abs(plates - yPlates) * PLATE_LDU > IDENTIFICATION_ACCEPTED_DEVIATION_LDU) {
      leftOut.push(
        `${placeable.label}: its height isn't a whole number of plates from ${anchor.placeable.label}'s`,
      );
      continue;
    }
    const x = anchorX - shiftX + 0;
    const z = anchorZ - shiftZ + 0;
    const pose = { refId, colorId: placeable.worldColor, x, z, yPlates, rot: 0 };
    members.push({ model: null, placeable, pose, component: WHOLE_GROUP_COMPONENT });
  }
  const lowest = Math.min(...members.map(({ pose }) => pose.yPlates));
  const resting = RESTS_ON_TABLE_Y_PLATES - lowest;
  return {
    members: members.map((member) => ({
      ...member,
      pose: { ...member.pose, yPlates: member.pose.yPlates + resting },
    })),
    leftOut,
  };
}

function refusedAt(
  item: string,
  at: { readonly x: number; readonly z: number; readonly rot: number },
  reason: string,
  fit: RoadCellCounts = NO_ROAD_CELLS,
): RefusedClick {
  return {
    item,
    x: at.x,
    z: at.z,
    rot: at.rot,
    mismatchedCells: fit.mismatchedCells,
    overlappingCells: fit.overlappingCells,
    reason,
  };
}

function shapesWaitText(subject: string, other: string): string {
  return `Waiting for part shapes to check ${subject} against ${other}…`;
}

function waitingText(subject: string, neighbour: string, checked: string): string {
  return `${subject}: ${neighbour} beside it is still reading its connectors, so ${checked} can't be checked yet.`;
}

function remedy(action: GroupAction, other: string): string {
  return action === "delete"
    ? `Delete ${other} first, or select it too.`
    : `Select ${other} too to take it along.`;
}

function samePose(a: PlacementPose, b: PlacementPose): boolean {
  return a.x === b.x && a.z === b.z && a.yPlates === b.yPlates && a.rot === b.rot;
}

function byIndex(a: TrackPieceAt, b: TrackPieceAt): number {
  return a.index - b.index;
}

function moveRefused(edit: GroupEdit): string {
  return edit.models.length + edit.pieces.length === 1
    ? "Can't move it there."
    : "Can't move them there.";
}

function restoredMembers(
  added: ReadonlyArray<PlacedModel>,
  track: TrackChange,
): ReadonlyArray<SelectionMember> {
  return [
    ...added.map((model): SelectionMember => ({ kind: "model", model })),
    ...track.lay.map((at): SelectionMember => ({ kind: "track", placement: at.index })),
  ];
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
    case "move":
      return "move";
    case "remove":
      return "delete";
    case "road":
      return `road stroke (${counted(edit.placements, "plate", "plates")})`;
    case "fill":
      return `fill (${counted(edit.placements, "placement", "placements")})`;
    case "lay-track": {
      const laid = `lay ${counted(edit.pieces, "piece", "pieces")}`;
      return edit.lifted === 0 ? laid : `${laid} in place of ${edit.lifted}`;
    }
    case "throw-switch":
      return "throw switch";
    case "plan":
      return "plan edit";
    case "note":
      return "note edit";
    case "event":
      return "event details";
    case "open-plan":
      return `open plan (${counted(edit.placements, "placement", "placements")}, ${counted(edit.pieces, "track piece", "track pieces")})`;
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
}

function sameModels(a: ReadonlyArray<PlacedModel>, b: ReadonlyArray<PlacedModel>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function changesAny<T extends object>(state: T, patch: Partial<T>): boolean {
  for (const key in patch) {
    if (!Object.is(patch[key], state[key])) return true;
  }
  return false;
}

function sameHover(a: HoverView | null, b: HoverView | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.z === b.z && a.yPlates === b.yPlates;
}

const NO_LOW_CLEARANCE: ReadonlyMap<number, PlateHeights> = new Map();
const NO_LABELS: ReadonlyArray<LabelView> = [];

interface ReachBox {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

function footprintMeetsBox(vehicle: VehicleFootprint, box: WorldBox): boolean {
  if (vehicle.topLdu <= box.minY || box.maxY <= vehicle.railTopLdu) return false;
  const rect = Float64Array.of(
    box.minX,
    box.minZ,
    box.maxX,
    box.minZ,
    box.maxX,
    box.maxZ,
    box.minX,
    box.maxZ,
  );
  return outlinesOverlap(vehicle.outline, 0, 0, rect, 0, 0);
}

function labelsNeedUpdate(previous: EditorSnapshot, next: EditorSnapshot): boolean {
  if (next.mode !== previous.mode || next.selection !== previous.selection) return true;
  if (next.mode === "track" && next.track !== previous.track) return true;
  return (
    next.mode === "place" &&
    (!sameHover(next.hover, previous.hover) ||
      next.ghostRot !== previous.ghostRot ||
      next.activeItem !== previous.activeItem)
  );
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
    trackTools: [],
    mode: "select",
    activeItem: null,
    ghostRot: 0,
    hover: null,
    selection: null,
    selectionRefusal: null,
    gesture: null,
    clipboard: 0,
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
    placementMode: "assist",
    placementModeOverride: false,
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
    rulers: 0,
    rulerDraft: false,
    hoveredTable: null,
    armedTable: null,
    noteTool: null,
    fillGridStuds: DEFAULT_FILL_GRID_STUDS,
    fillDraft: null,
    lastFill: null,
    labels: [],
    ghostSettled: false,
  };
  private world = new World();
  private consists = new ConsistLayout();
  private history: EditHistory;
  private readonly consistRefs = new Map<ConsistHandle, ConsistRef>();
  private activeTrain: PlayModel | null = null;
  private trainAim: RailAim | null = null;
  private ghostOnRails = false;
  private readonly ray = new Float64Array(RAY_FLOATS);
  private readonly tileRay = new Float64Array(RAY_FLOATS);
  private readonly check: PlacementCheck = {
    aim: null,
    yPlates: 0,
    waitingOn: NOT_WAITING,
    refusal: null,
    trackBlock: null,
  };
  private catalogItems: ReadonlyArray<CatalogItemView> = [];
  private bundleColors: ReadonlyArray<BundleColor> | null = null;
  private placed: PlacedChunks;
  private active: Placeable | null = null;
  private activeRefId = -1;
  private readonly selection = new Selection();
  private readonly views: SelectionViews = {
    piece: (placement) => this.pieceView(placement),
    train: (train) => this.trainView(train),
  };
  private gesture: BoxDrag | HeldGroup | null = null;
  private copied: Copied | null = null;
  private readonly boxQuad = new Float64Array(QUAD_FLOATS);
  private readonly groundScratch = new Float64Array(2);
  private readonly boxedPlacements: number[] = [];
  private ghostRot = 0;
  private placeRot = 0;
  private turnDirection: TurnDirection = 1;
  private hoverX = 0;
  private hoverZ = 0;
  private railRefusal: string | null = null;
  private railWaiting: string | null = null;
  private queuedClick: QueuedClick | null = null;
  private readonly pick = new CursorPick();
  private readonly surface = new Float64Array(3);
  private readonly topFaceShift = new Float64Array(2);
  private readonly sideRay = new Float64Array(6);
  private readonly tilePose = { x: 0, z: 0, yPlates: 0, rot: 0 };
  private readonly tileChoice = placementChoice();
  private readonly groupChoice = placementChoice();
  private readonly liftChoice = placementChoice();
  private readonly liftNeighbours: PlacedModel[] = [];
  private readonly liftTrack: number[] = [];
  private readonly memberMates = new MateReport();
  private solidBoxes = new Float64Array(0);
  private solidRects = new Float64Array(0);
  private canvas: HTMLCanvasElement | null = null;
  private pointerNdcX = 0;
  private pointerNdcY = 0;
  private assistLdu = 0;
  private readonly assist: AssistSession;
  private shownVerdict: GhostVerdict | null = null;
  private dropping = false;
  private readonly verdictShownFor: {
    mode: EditorMode | null;
    hovered: boolean;
    refusal: string | null;
    placement: PlacementHover | null;
    grouped: boolean;
    groupRefusal: string | null;
    filling: boolean;
    settled: boolean;
    placementMode: PlacementMode | null;
    override: boolean;
  } = {
    mode: null,
    hovered: false,
    refusal: null,
    placement: null,
    grouped: false,
    groupRefusal: null,
    filling: false,
    settled: false,
    placementMode: null,
    override: false,
  };
  private hovering = false;
  private hitX = 0;
  private hitZ = 0;
  private labelsReusable = false;
  private labelsMeasured: ReadonlyArray<LabelView> = NO_LABELS;
  private labelsNoted: ReadonlyArray<LabelView> = NO_LABELS;
  private labelsTabled: ReadonlyArray<LabelView> = NO_LABELS;
  private labelsFilling: LabelView | null = null;
  private labelsSelection: SelectionView | null = null;
  private labelsHeights: ReadonlyArray<LabelView> = NO_LABELS;
  private labelsPreview: ReadonlyArray<LabelView> = NO_LABELS;
  private lastLabels: ReadonlyArray<LabelView> = NO_LABELS;
  private readonly searchIds = new Map<number, number>();
  private readonly awaitingIds = new Map<number, number>();
  private readonly searchModels = new Map<number, PlacedModel>();
  private readonly connected = new Map<string, Connected>();
  private studShapeFlags = new Uint8Array(0);
  private readonly studShapes: Pick<ReadonlySet<number>, "has"> = {
    has: (shape) => this.studShapeFlags[shape] === 1,
  };
  private readonly frozenVolumes = new Map<string, FrozenVolumes>();
  private replayReachLdu: number | null = null;
  private waitingFill: {
    readonly placeable: Placeable;
    readonly rot: number;
    readonly eventTimeMs: number;
  } | null = null;
  private readonly studChecks = new Set<Placeable>();
  private readonly studsLanding = new Map<string, Promise<void>>();
  private nextSearchId = 1;
  private readonly facts: PlanFacts;
  private readonly factUpdates: PlacedModel[] = [];
  private factsQueued = false;
  private mappingRequested = false;
  private trackSupportError: string | null = null;
  private trackSupportLoad: Promise<void> | null = null;
  private readonly liveRoads = new LiveRoads();
  private readonly joinMarkers = new WeakMap<RoadEdgeSegment, EdgeMarker>();
  private placedRoads: PlacedRoads = this.liveRoads.placedRoads;
  private keptRoadSnap: KeptRoadSnap | null = null;
  private pendingTurns = HELD_TURN;
  private pendingTurnsAtX = 0;
  private pendingTurnsAtZ = 0;
  private readonly snapMates = new MateReport();
  private readonly snapQuery = new RoadSnapQuery();
  private readonly groupHeight = new FixedHeight();
  private readonly restingHeights: RestingHeights = {
    restingYLdu: (x, z) => this.restingYPlatesAt(x, z) * PLATE_LDU,
  };
  private readonly roadFit = new RoadFit();
  private readonly nearModels: PlacedModel[] = [];
  private readonly noteNeighbours: PlacedModel[] = [];
  private readonly restingModels: PlacedModel[] = [];
  private readonly tileModels: PlacedModel[] = [];
  private readonly restingTop = new Float64Array(1);
  private readonly solidProbe: SolidProbe = { placeable: null, x: 0, z: 0, rot: 0, yPlates: 0 };
  private readonly probeSeatsStud = (cellX: number, cellZ: number, baseLdu: number): boolean => {
    const { placeable, x, z, rot, yPlates } = this.solidProbe;
    return (
      placeable !== null &&
      posedSeatsStudAt(placeable, x, z, rot, yPlates * PLATE_LDU, cellX, cellZ, baseLdu)
    );
  };
  private readonly solidSpan: [number, number] = [0, 0];
  private readonly trainReach: ReachBox = {
    minX: 0,
    maxX: 0,
    minY: 0,
    maxY: 0,
    minZ: 0,
    maxZ: 0,
  };
  private readonly trainNeighbours: PlacedModel[] = [];
  private readonly posedModel = new PosedPlaceable();
  private readonly clash = clashOut();
  private readonly modelClash = clashOut();
  private partClash: PartClash | null = null;
  private solidsAwaited = false;
  private heldShapesWait = false;
  private readonly solidHit = { rects: new Float64Array(0), floats: 0 };
  private readonly solidRectsIn: SolidRects = (bottomLdu, topLdu) => {
    const { placeable, x, z, rot, yPlates } = this.solidProbe;
    const hit = this.solidHit;
    if (!placeable) {
      hit.floats = 0;
      return hit;
    }
    this.solidSpan[0] = bottomLdu;
    this.solidSpan[1] = topLdu;
    hit.floats = this.solidRectsAt(placeable, x, z, rot, yPlates, this.solidSpan);
    hit.rects = this.solidRects;
    return hit;
  };
  private readonly roadProbeScratch: ProbedRoad = {
    id: -1,
    x: 0,
    z: 0,
    yLdu: 0,
    rot: 0,
    surface: NO_ROAD_SURFACE,
  };
  private readonly restingPoint = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };
  private readonly planDelta = new PlanDelta();
  private measure: MeasureTool | null = null;
  private tables: TableTool | null = null;
  private fillTool: FillTool | null = null;
  private reportedPlans: PlanState;

  constructor(
    @inject(PART_BUNDLE_LOADER) private readonly loader: IPartBundleLoader,
    @inject(SCENE_BACKEND) private readonly backend: ISceneBackend,
    @inject(PLAN_SERVICE) private readonly plans: IPlanService,
    @inject(ANNOTATION_SERVICE) private readonly annotations: IAnnotationService,
    @inject(NOTE_EDIT_SESSION) private readonly notes: INoteEditSession,
    @inject(EDITOR_CAMERA) private readonly camera: IEditorCamera,
    @inject(WORLD_SESSION) private readonly session: IWorldSession,
    @inject(EDITOR_FRAME_LOOP) private readonly frames: IEditorFrameLoop,
    @inject(PLACEABLE_CATALOG) private readonly catalog: IPlaceableCatalog,
    @inject(PLACEMENT_SEARCH) private readonly search: IPlacementSearch,
    @inject(SNAP_SHAPES) private readonly shapes: SnapShapes,
    @inject(CONNECTOR_TABLES) private readonly connectorTables: IConnectorTables,
    @inject(TABLE_GROUND) private readonly ground: ITableGround,
    @inject(RAIL_YARD) private readonly railYard: IRailYard,
    @inject(TRACK_WORLD) private readonly trackWorld: ITrackWorld,
    @inject(TRACK_EDIT_SESSION) private readonly tracks: ITrackEditSession,
    @inject(ROAD_EDIT_SESSION) private readonly roads: IRoadEditSession,
    @inject(TALLEST_TRAIN) private readonly tallestTrains: ITallestTrain,
    @inject(TRACK_PIERS) private readonly piers: ITrackPiers,
    @inject(TRACK_PATH_SELECTION) private readonly trackPaths: ITrackPathSelection,
    @inject(EVENT_DETAILS) private readonly events: IEventDetails,
    @inject(PLAN_SCENE_BACKEND) plan: IPlanSceneBackend,
  ) {
    this.history = new EditHistory(this.world, this.consists, annotations);
    this.placed = new PlacedChunks(backend, plan, (placeable, handle) =>
      this.trackWorld.carriedTrackAt(placeable, handle),
    );
    this.facts = new PlanFacts(
      this.placed,
      search,
      {
        idOf: (model) => this.searchIds.get(model.id),
        modelAt: (id) => this.searchModels.get(id),
      },
      catalog,
      RESTS_ON_TABLE_Y_PLATES,
    );
    this.state = { ...this.state, ...session.view(), ...frames.view(), ...ground.view() };
    this.reportedPlans = {
      regions: plans.plans(),
      activePlanId: plans.activePlanId(),
      tableTypes: plans.tableTypes(),
    };
    session.subscribe(() => this.sessionChanged());
    frames.subscribe(() => this.update(this.frames.view()));
    ground.subscribe(() => this.update(this.ground.view()));
    this.assist = new AssistSession(search, this.assistHost());
    railYard.watchModels({
      models: () => this.placed.models(),
      carriedParts: (placeable) => this.trackWorld.carriedParts(placeable),
    });
    frames.setFrameWork(this.frameWork);
    catalog.subscribe(() => {
      this.update({ meshes: catalog.meshProgress() });
      if (this.solidsAwaited) void Promise.resolve().then(() => this.solidsArrived());
    });
    plans.subscribe(() => this.plansChanged());
    plans.onEdit((change) => this.planEdited(change));
    annotations.onEdit((change) => this.notesEdited(change));
    events.onEdit((change) => this.eventEdited(change));
    notes.subscribe(() => this.noteToolChanged());
  }

  private noteToolChanged(): void {
    this.update({ ...this.notes.view(), labels: this.labelsOf(this.state) });
  }

  private sessionChanged(): void {
    this.update(this.session.view());
    if (!this.state.readOnly) return;
    if (this.active || this.tracks.holding() || this.gesture || this.state.mode === "road") {
      this.chooseItem(null);
    }
    if (this.state.mode === "table") this.setTableTool(false);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): EditorSnapshot {
    return this.state;
  }

  private update(patch: Partial<EditorSnapshot>): void {
    const before = this.state;
    if (
      !changesAny(before, patch) &&
      ghostSettles(before, before, this.dropping) === before.ghostSettled
    ) {
      return;
    }
    const merged = { ...before, ...patch };
    const ghostSettled = ghostSettles(before, merged, this.dropping);
    const next = merged.ghostSettled === ghostSettled ? merged : { ...merged, ghostSettled };
    this.state =
      patch.labels === undefined && labelsNeedUpdate(before, next)
        ? { ...next, labels: this.labelsOf(next) }
        : next;
    this.showGhostVerdict();
    for (const listener of this.listeners) listener();
  }

  private labelsOf(state: EditorSnapshot): ReadonlyArray<LabelView> {
    const measured = this.measure?.labels() ?? NO_LABELS;
    const tabled = state.mode === "table" && this.tables ? this.tables.labels() : NO_LABELS;
    const filling = this.fillTool?.label() ?? null;
    const active = this.active;
    const ghostAt = state.mode === "place" && active && !filling ? state.hover : null;
    const { selection } = state;
    const track = this.trackWorld.drawing();
    const drawn = state.mode === "track" ? track : null;
    const heights = drawn ? drawn.heightLabels() : NO_LABELS;
    const preview = drawn ? drawn.previewLabels() : NO_LABELS;
    const noted = this.notes.labels();
    if (
      this.labelsReusable &&
      ghostAt === null &&
      noted === this.labelsNoted &&
      measured === this.labelsMeasured &&
      tabled === this.labelsTabled &&
      filling === this.labelsFilling &&
      selection === this.labelsSelection &&
      heights === this.labelsHeights &&
      preview === this.labelsPreview
    ) {
      return this.lastLabels;
    }
    const labels = [...measured, ...tabled];
    if (filling) labels.push(filling);
    if (active && ghostAt) {
      const { x, z, yPlates } = ghostAt;
      labels.push(
        boxLabel("ghost", "ghost", posedBox(active.box, x, z, yPlates * PLATE_LDU, state.ghostRot)),
      );
    }
    if (selection) labels.push(boxLabel("selection", "selection", selection.box));
    labels.push(...preview, ...heights, ...noted);
    this.labelsReusable = ghostAt === null;
    this.labelsNoted = noted;
    this.labelsMeasured = measured;
    this.labelsTabled = tabled;
    this.labelsFilling = filling;
    this.labelsSelection = selection;
    this.labelsHeights = heights;
    this.labelsPreview = preview;
    this.lastLabels = labels;
    return labels;
  }

  private showGhostVerdict(): void {
    const { mode, hover, ghostSettled, placementMode, placementModeOverride } = this.state;
    const { gesture, fillDraft } = this.state;
    const hovered = hover !== null;
    const refusal = hover?.refusal ?? null;
    const placement = hover?.placement ?? null;
    const grouped = gesture !== null && gesture.kind !== "box";
    const groupRefusal = gesture !== null && gesture.kind !== "box" ? gesture.refusal : null;
    const filling = fillDraft !== null;
    const shown = this.verdictShownFor;
    if (
      shown.mode === mode &&
      shown.hovered === hovered &&
      shown.refusal === refusal &&
      shown.placement === placement &&
      shown.grouped === grouped &&
      shown.groupRefusal === groupRefusal &&
      shown.filling === filling &&
      shown.settled === ghostSettled &&
      shown.placementMode === placementMode &&
      shown.override === placementModeOverride
    ) {
      return;
    }
    shown.mode = mode;
    shown.hovered = hovered;
    shown.refusal = refusal;
    shown.placement = placement;
    shown.grouped = grouped;
    shown.groupRefusal = groupRefusal;
    shown.filling = filling;
    shown.settled = ghostSettled;
    shown.placementMode = placementMode;
    shown.override = placementModeOverride;
    const verdict = ghostVerdict(this.state);
    if (sameVerdict(verdict, this.shownVerdict)) return;
    this.shownVerdict = verdict;
    this.backend.setGhostVerdict(verdict);
  }

  async start(canvas: HTMLCanvasElement, options: EditorOptions): Promise<void> {
    this.canvas = canvas;
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
      this.canvas = canvas;
      this.measure = new MeasureTool(-index.tablePlane.depthBelowTopLdu);
      this.tables = new TableTool(this.plans, -index.tablePlane.depthBelowTopLdu);
      this.fillTool = new FillTool(-index.tablePlane.depthBelowTopLdu);
      this.notes.start(NOTE_PLANE_Y_LDU);
      const catalog = await this.catalog.start(index);
      this.catalogItems = catalog.items;
      this.bundleColors = index.colors;
      this.plans.setTableTopY(this.baseplateBottomY());
      this.trackWorld.start(index, this.placed);
      this.loadTrackSupport();
      const trackItems = this.tracks.start();
      this.roads.start(index.colors);
      this.update({ catalog: [...catalog.items, ...trackItems] });
      const loadMs = performance.now() - started;
      await this.session.start(this, index.bundleVersion);
      this.update({
        status: "ready",
        loadMs,
        bundleVersion: index.bundleVersion,
        backend,
        catalogSkipped: catalog.skipped,
        ...this.tracks.view(),
        ...this.roads.view(),
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

  async addImportedModel(file: ImportedFile, notice: ModelImportNotice): Promise<ModelFileOutcome> {
    const id = importRef(file.sha256);
    if (this.catalog.itemRefId(id) !== null) return { kind: "added", item: id };
    const announced = notice === "announce";
    const importing = {
      file: file.name,
      status: "importing",
      item: null,
      reason: null,
      report: null,
      studio: null,
    } as const;
    if (announced) this.update({ modelImport: importing });
    const outcome = await this.catalog.addImported(file);
    switch (outcome.kind) {
      case "refused": {
        const reported = { ...importing, report: outcome.report, studio: outcome.studio };
        if (announced) {
          this.update({ modelImport: { ...reported, status: "refused", reason: outcome.refusal } });
        }
        return { kind: "refused", reason: outcome.refusal };
      }
      case "placeable": {
        const refId = this.catalog.itemRefId(outcome.item.id);
        const imported = refId === null ? null : this.catalog.placeables()[refId];
        if (imported) await this.connectorTables.load(imported);
        this.remeasureTrains(imported);
        const reported = { ...importing, report: outcome.report, studio: outcome.studio };
        this.addImportedItem(
          outcome.item,
          outcome.credit,
          announced ? { ...reported, status: "placeable", item: outcome.item.id } : null,
        );
        return { kind: "added", item: outcome.item.id };
      }
      case "checking": {
        await this.connectorTables.load(outcome.pending);
        this.remeasureTrains(outcome.pending);
        this.studChecks.add(outcome.pending);
        this.addImportedItem(
          outcome.item,
          outcome.credit,
          announced ? { ...importing, status: "checking", item: outcome.item.id } : null,
        );
        const landed = outcome.checked.then((checked) =>
          this.studsChecked(outcome.pending, checked),
        );
        this.studsLanding.set(outcome.item.id, landed);
        void landed.finally(() => this.studsLanding.delete(outcome.item.id));
        return { kind: "added", item: outcome.item.id };
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
    modelImport: ModelImportView | null,
  ): void {
    this.catalogItems = [...this.catalogItems, item];
    const credits = this.state.credits;
    this.update({
      catalog: [...this.state.catalog, item],
      ...(modelImport ? { modelImport } : {}),
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
    this.flushQueuedFacts();
    const view = this.placed.replacePlaceable(pending, checked);
    const gesture = this.gesture;
    if (
      gesture &&
      gesture.kind !== "box" &&
      (gesture.pieces.length > 0 || view.removed.some((model) => gesture.exempt.has(model)))
    ) {
      this.cancelGesture();
    }
    let swapped = false;
    view.removed.forEach((model, index) => {
      const replaced = view.added[index];
      if (!replaced) return;
      const id = this.searchIds.get(replaced.id) ?? this.awaitingIds.get(replaced.id);
      if (id !== undefined) this.searchModels.set(id, replaced);
      if (this.selection.swap(model, replaced)) swapped = true;
    });
    const connected = this.connected.get(checked.id);
    if (connected) this.noteStudShapes(checked, connected.model);
    if (swapped && !this.gesture) this.showSelection();
    this.facts.noteReplaced(view.removed, view.added);
    this.refreshRoads();
    const carriedTrackChanged = this.syncModelTrack();
    this.refreshTrains();
    this.placeGhost();
    const delta = this.planDelta;
    delta.reset();
    writeModelUpdates(delta, view.added, view.added.length);
    if (carriedTrackChanged) this.trackWorld.writeIssues(delta);
    this.plans.apply(delta);
    this.trackWorld.invalidateObstacles();
    const trackMode = this.trackWorld.drawing() !== null && this.state.mode === "track";
    if (trackMode) this.trackWorld.ensureObstacles();
    this.layoutChanged();
    if (!trackMode) {
      this.update(this.tracks.view());
      return;
    }
    if (this.tracks.dragging()) this.update(this.tracks.moveDrag(this.hitX, this.hitZ));
    else this.update(this.tracks.view());
    this.repaintTrackPreview();
  }

  private loadTrackSupport(): void {
    const loading = this.trackWorld.loadSupport();
    if (!loading) return;
    this.trackSupportLoad = loading.then(
      () => {
        if (this.trackSupportError !== null && this.state.catalogError === this.trackSupportError) {
          this.update({ catalogError: null });
        }
        this.trackSupportError = null;
        this.layoutChanged();
        if (this.tracks.dragging()) this.update(this.tracks.moveDrag(this.hitX, this.hitZ));
        else {
          this.update(this.tracks.view());
          this.repaintTrackPreview();
        }
      },
      (error: unknown) => {
        this.trackSupportError = `track connector records can't be read: ${errorText(error)}`;
        this.update({ catalogError: this.trackSupportError });
      },
    );
  }

  private layoutChanged(): void {
    if (this.trackWorld.drawing() !== null && this.trackWorld.support() === null) {
      this.loadTrackSupport();
    }
    this.trackWorld.measureSupport();
    this.pushUnsupported();
    this.reportClearance();
    this.trackWorld.refreshCrossings();
  }

  private forgetLayout(): void {
    this.pushUnsupported();
    if (this.trackWorld.drawing() !== null) {
      this.plans.setLowClearance(NO_LOW_CLEARANCE, NO_LOW_CLEARANCE, "");
    }
    this.trackWorld.refreshCrossings();
  }

  private reportClearance(): void {
    const track = this.trackWorld.drawing();
    if (!track) return;
    if (track.raisedCount() > 0 || track.drawingPlates > 0) this.measureTallestTrain();
    const low = this.trackWorld.measureClearance();
    if (!low) {
      this.plans.setLowClearance(NO_LOW_CLEARANCE, NO_LOW_CLEARANCE, "");
      return;
    }
    this.plans.setLowClearance(low.laid, low.carriers, track.tallestTrain?.model ?? "");
  }

  private measureTallestTrain(): void {
    const track = this.trackWorld.drawing();
    if (!track) return;
    this.tallestTrains.measure(track.playTrack().railPart).then(
      () => this.applyTallestTrain(),
      (error: unknown) => {
        this.update({
          catalogError: `trains can't be measured for clearance: ${errorText(error)}`,
        });
      },
    );
  }

  private applyTallestTrain(): void {
    const track = this.trackWorld.drawing();
    const tallest = this.tallestTrains.current();
    if (!track || track.tallestTrain === tallest) return;
    track.setTallestTrain(tallest);
    this.layoutChanged();
    this.repaintTrackPreview();
    this.update(this.tracks.view());
  }

  private remeasureTrains(placeable: Placeable | undefined | null): void {
    if (!placeable || !this.catalog.playModel(placeable)) return;
    this.tallestTrains.invalidate();
    if (this.trackWorld.drawing()?.tallestTrain) this.measureTallestTrain();
  }

  private async loadedSupport(): Promise<TrackSupport | null> {
    if (!this.trackWorld.support()) this.loadTrackSupport();
    await this.trackSupportLoad;
    return this.trackWorld.support();
  }

  private async piersFor(
    track: TrackDrawing,
    raised: ReadonlyArray<RaisedPiece>,
    change: TrackChange,
  ): Promise<ReadonlyArray<PlacementPose>> {
    const support = await this.loadedSupport();
    if (!support) return [];
    const unseated = raised.filter((piece) => !track.seated(piece));
    const rampEnds = track.rampEndsAbove(change).filter((rest) => !track.rampEndSeated(rest));
    if (unseated.length === 0 && rampEnds.length === 0) return [];
    const levelPieces = unseated.map((piece): PierPiece => {
      const { partFrame } = track.pieceByIndex(piece.catalogIndex).piece;
      const box = track.pieceBox(piece.catalogIndex, piece.placement);
      return {
        indices: [piece.index],
        bottomLdu: track.bandBottomLdu(piece.yPlates),
        antiStuds: support.antiStudCells(piece.catalogIndex, partFrame, piece.placement),
        centreX: (box.minX + box.maxX) / 2,
        centreZ: (box.minZ + box.maxZ) / 2,
      };
    });
    const rampPieces = rampEnds.map((rest): PierPiece => ({
      indices: rest.indices,
      bottomLdu: track.bandBottomLdu(rest.yPlates),
      antiStuds: rest.antiStuds,
      centreX: rest.xLdu,
      centreZ: rest.zLdu,
    }));
    const pieces = [...levelPieces, ...rampPieces];
    const trains = this.railYard.standingFootprints();
    return this.piers.piersFor({
      pieces,
      studsChecked: (item) => this.studsLanding.get(item) ?? Promise.resolve(),
      fits: (pier, pose, posed, piece) => {
        if (track.changeOverlaps(change, piece.indices, posed)) return false;
        if (trains.some((train) => footprintMeetsBox(train, posed))) return false;
        const member = { model: null, placeable: pier, pose, component: 0 };
        const check: ModelCheck = {
          models: [member],
          exempt: NO_MODELS,
          placedRoads: this.placedRoads,
          trackSkip: NO_TRACK_SKIP,
        };
        return this.modelRefusal(check, [pose]) === null;
      },
    });
  }

  private pushUnsupported(): void {
    const unsupported = this.trackWorld.unsupported();
    this.plans.setUnsupported(unsupported.laid, this.facts.unsupported, unsupported.carriers);
  }

  async importModelFile(file: ModelFileInput): Promise<boolean> {
    const added = await this.session.addModelFile(file, "announce");
    if (added.kind === "refused") return false;
    if (!this.state.readOnly) this.chooseItem(added.item);
    return true;
  }

  async importLayoutFile(file: ModelFileInput): Promise<boolean> {
    if (this.state.readOnly) return false;
    const layout = { file: file.name, item: null, report: null, studio: null } as const;
    this.update({ modelImport: { ...layout, status: "importing", reason: null } });
    const parts = await this.catalog.layoutParts(file.name, file.bytes).catch(errorText);
    if (typeof parts === "string") {
      this.update({ modelImport: { ...layout, status: "refused", reason: parts } });
      return false;
    }
    const pieces: LayoutPiece[] = [];
    const unplaced: string[] = [];
    for (const part of parts) {
      const piece = await this.layoutPiece(part);
      if (typeof piece === "string") unplaced.push(`${part.name}: ${piece}`);
      else pieces.push(piece);
    }
    const { members, leftOut } = layoutMembers(pieces);
    const omitted = [...unplaced, ...leftOut].join("; ");
    const [frame] = members;
    if (!frame) {
      const reason = omitted === "" ? NOTHING_DRAWN : omitted;
      this.update({ modelImport: { ...layout, status: "refused", reason } });
      return false;
    }
    const reason = omitted === "" ? null : `Left out: ${omitted}.`;
    this.update({ modelImport: { ...layout, status: "held", reason } });
    this.chooseItem(null);
    for (const { placeable } of members) this.requestMeshes(placeable);
    const boxes = members.map(({ placeable, pose }) =>
      posedBox(placeable.box, pose.x, pose.z, pose.yPlates * PLATE_LDU, pose.rot),
    );
    const pivot = latticeCentre(unionBox(boxes));
    this.holdGroup({
      kind: "paste",
      ...this.pasteEdit(members, NO_PIECES),
      frameModel: 0,
      frame: frame.pose,
      grabX: pivot.x,
      grabZ: pivot.z,
      placement: null,
    });
    return true;
  }

  private async layoutPiece(part: LayoutPart): Promise<LayoutPiece | string> {
    const bytes = new TextEncoder().encode(part.text);
    const added = await this.session.addModelFile({ name: part.name, bytes }, "quiet");
    if (added.kind === "refused") return added.reason;
    const refId = this.catalog.itemRefId(added.item);
    if (refId === null) throw new Error(`${added.item} isn't in the catalog`);
    return { refId, placeable: this.placeableAt(refId) };
  }

  private requestMeshes(placeable: Placeable): void {
    this.catalog.requestMeshes(new Set(placeable.parts.partIndex));
  }

  private async ensureStoredPlaceables({
    shards,
    consists,
  }: Pick<StoredContents, "shards" | "consists">): Promise<void> {
    const refIds = new Set<number>();
    const placed = [
      ...shards.flatMap((shard) => shard.placements),
      ...consists.flatMap((consist) => [consist, ...(consist.coupled ?? [])]),
    ];
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

  private refreshTrackPreview(): void {
    const view = this.trackPreviewView();
    if (view) this.update(view);
  }

  private trackPreviewView(): TrackEditView | null {
    return this.tracks.refreshPreview(
      this.state.mode === "track",
      this.hovering,
      this.hitX,
      this.hitZ,
    );
  }

  private repaintTrackPreview(): void {
    const view = this.tracks.repaint(
      this.state.mode === "track",
      this.hovering,
      this.hitX,
      this.hitZ,
    );
    if (view) this.update(view);
  }

  private readonly roadNeighbourhood: RoadNeighbourhood = {
    near: (area, roadModels, otherModels) => {
      const models = this.nearModels;
      const count = this.placed.over(area, models);
      roadModels.length = 0;
      otherModels.length = 0;
      for (let m = 0; m < count; m++) {
        const model = models[m];
        if (!model) continue;
        if (model.placeable.road === null) otherModels.push(model);
        else roadModels.push(model);
      }
    },
  };

  dragStart(ndcX: number, ndcY: number): boolean {
    this.cancelFill();
    this.waitingFill = null;
    this.fillTool?.end();
    if (noteToolOf(this.state.mode) !== null) return this.noteDragStart(ndcX, ndcY);
    if (this.state.mode === "measure") return this.rulerDragStart(ndcX, ndcY);
    if (this.state.mode === "table") return this.tableDragStart(ndcX, ndcY);
    if (this.state.mode === "road") return this.roadDragStart(ndcX, ndcY);
    if (this.state.mode === "place") return this.fillDragStart(ndcX, ndcY);
    if (this.state.mode !== "track" || this.trackWorld.drawing() === null) return false;
    if (this.state.readOnly || this.tracks.holding()) return false;
    if (this.tracks.piering() || !this.groundHit(ndcX, ndcY)) return false;
    this.tracks.beginDrag(this.hitX, this.hitZ, this.hoverX, this.hoverZ);
    this.update(this.tracks.view());
    return true;
  }

  private roadDragStart(ndcX: number, ndcY: number): boolean {
    if (this.state.readOnly || !this.groundHit(ndcX, ndcY)) return false;
    this.roads.beginStroke(this.hitX, this.hitZ, this.roadNeighbourhood);
    this.update(this.roads.view());
    return true;
  }

  private roadDragEnd(ndcX: number, ndcY: number, eventTimeMs: number): void {
    if (this.state.readOnly) {
      this.roads.cancelStroke();
      return;
    }
    if (this.groundHit(ndcX, ndcY)) this.roads.extendStroke(this.hitX, this.hitZ);
    const requests = this.roads.endStroke(this.roadNeighbourhood);
    if (requests === null) return;
    if (requests.length > 0) this.show(this.history.commit("road", requests), eventTimeMs);
    this.update(this.roads.view());
  }

  dragMove(ndcX: number, ndcY: number): void {
    if (noteToolOf(this.state.mode) !== null) {
      const pointer = this.notePointer(ndcX, ndcY);
      if (pointer) this.notes.drag(pointer);
      return;
    }
    const fill = this.fillTool;
    if (fill?.drafting) {
      if (this.groundHit(ndcX, ndcY) && fill.drag(this.hitX, this.hitZ)) this.previewFill(fill);
      return;
    }
    if (this.measure?.drafting) {
      if (this.groundHit(ndcX, ndcY) && this.measure.drag(this.hoverX, this.hoverZ)) {
        this.showGuides();
      }
      return;
    }
    if (this.state.mode === "table") {
      const tables = this.tables;
      if (tables?.dragging && this.groundHit(ndcX, ndcY) && tables.move(this.hitX, this.hitZ)) {
        this.showGuides();
      }
      return;
    }
    if (this.state.mode === "road") {
      if (this.groundHit(ndcX, ndcY)) {
        const view = this.roads.moveStroke(this.hitX, this.hitZ, this.roadNeighbourhood);
        if (view) this.update(view);
      }
      return;
    }
    if (!this.tracks.dragging() || !this.groundHit(ndcX, ndcY)) return;
    this.update(this.tracks.moveDrag(this.hitX, this.hitZ));
  }

  dragEnd(ndcX: number, ndcY: number, eventTimeMs: number): void {
    if (noteToolOf(this.state.mode) !== null) {
      this.notes.release(this.notePointer(ndcX, ndcY));
      return;
    }
    const fill = this.fillTool;
    if (fill?.drafting) {
      this.fillDragEnd(fill, ndcX, ndcY, eventTimeMs);
      return;
    }
    const measure = this.measure;
    if (measure?.drafting) {
      if (this.groundHit(ndcX, ndcY)) measure.drag(this.hoverX, this.hoverZ);
      measure.end();
      this.showGuides();
      return;
    }
    if (this.state.mode === "table") {
      const tables = this.tables;
      if (tables?.dragging) {
        if (this.groundHit(ndcX, ndcY)) tables.move(this.hitX, this.hitZ);
        tables.end();
      }
      this.showGuides();
      return;
    }
    if (this.state.mode === "road") {
      this.roadDragEnd(ndcX, ndcY, eventTimeMs);
      return;
    }
    const hit = this.tracks.dragging() && this.groundHit(ndcX, ndcY);
    const end = this.tracks.endDrag(hit, this.hitX, this.hitZ, this.hoverX, this.hoverZ);
    switch (end.kind) {
      case "idle":
        this.repaintTrackPreview();
        return;
      case "click":
        this.hovering = true;
        this.trackClick(eventTimeMs);
        return;
      case "settled":
        this.update(this.tracks.view());
        this.repaintTrackPreview();
        return;
      case "lay":
        this.commitLay(end.lay, eventTimeMs);
        this.tracks.settleLay(end.lay);
        this.update(this.tracks.view());
        this.repaintTrackPreview();
        return;
      default: {
        const unhandled: never = end;
        throw new Error(`unhandled drag end ${String(unhandled)}`);
      }
    }
  }

  private commitLay(lay: TrackLayRequest, eventTimeMs: number): void {
    const track = this.trackWorld.drawing();
    if (!track) return;
    const raised = track.levelRaisedPieces(lay.change);
    const ready = this.trackWorld.support() !== null;
    const rampEnds = track.rampEndsAbove(lay.change);
    const rampsWaiting = !ready && lay.change.lay.some((at) => at.rise !== 0);
    const allSeated =
      ready &&
      raised.every((piece) => track.seated(piece)) &&
      rampEnds.every((rest) => track.rampEndSeated(rest));
    if ((raised.length === 0 && rampEnds.length === 0 && !rampsWaiting) || allSeated) {
      this.show(
        this.history.commit("lay-track", [], lay.change),
        eventTimeMs,
        lay.sample ?? undefined,
      );
      this.tracks.finishLay(lay);
      return;
    }
    const depth = this.history.undoDepth;
    const redo = this.history.redoDepth;
    this.tracks.setPiering(true);
    this.update(this.tracks.view());
    this.piersFor(track, raised, lay.change).then(
      (piers) => {
        this.tracks.setPiering(false);
        const unchanged =
          this.trackWorld.drawing() === track &&
          this.history.undoDepth === depth &&
          this.history.redoDepth === redo;
        if (!unchanged) {
          this.tracks.abandonLay();
          this.update(this.tracks.view());
          return;
        }
        const requests = piers.map((to) => ({ placement: null, to }));
        this.show(
          this.history.commit("lay-track", requests, lay.change),
          eventTimeMs,
          lay.sample ?? undefined,
        );
        this.tracks.finishLay(lay);
        this.update(this.tracks.view());
        this.repaintTrackPreview();
      },
      (error: unknown) => {
        this.tracks.setPiering(false);
        this.update({
          ...this.tracks.view(),
          catalogError: `track piers can't be built: ${errorText(error)}`,
        });
      },
    );
  }

  private commitThrow(thrown: SwitchThrowRequest, eventTimeMs: number): void {
    this.show(this.history.commit("throw-switch", [], thrown.change), eventTimeMs, thrown.sample);
    this.tracks.finishThrow(thrown);
  }

  private refuseTrack(refusal: TrackClickRefusal): void {
    this.refuse(
      refusedAt(refusal.item, { x: refusal.x, z: refusal.z, rot: 0 }, refusal.reason),
      null,
    );
  }

  private trackClick(eventTimeMs: number): void {
    if (this.trackWorld.drawing() === null) return;
    this.repaintTrackPreview();
    if (this.tracks.onExtension(this.hitX, this.hitZ)) {
      this.extendTrack(null, eventTimeMs);
      return;
    }
    if (this.throwSwitchAt(this.hitX, this.hitZ, eventTimeMs)) return;
    if (this.selection.pieces.length > 0) this.select([]);
    if (this.tracks.dropExtension()) this.refreshTrackPreview();
  }

  extendTrack(turn: ExtensionTurn | null, eventTimeMs: number): void {
    if (this.state.mode !== "track" || this.state.readOnly || this.tracks.holding()) return;
    if (this.tracks.dragging() || this.tracks.piering()) return;
    this.layExtension(this.tracks.extend(turn), eventTimeMs);
  }

  private appendTrackPiece(id: string): boolean {
    if (this.state.mode !== "track") return false;
    return this.layExtension(this.tracks.appendPiece(id), performance.now());
  }

  private layExtension(attempt: ExtensionAttempt, eventTimeMs: number): boolean {
    switch (attempt.kind) {
      case "none":
        return false;
      case "blocked":
        this.update(this.tracks.view());
        return true;
      case "lay":
        this.commitLay(attempt.lay, eventTimeMs);
        this.repaintTrackPreview();
        return true;
      default: {
        const unhandled: never = attempt;
        throw new Error(`unhandled extension attempt ${String(unhandled)}`);
      }
    }
  }

  raiseTrack(plates: number): void {
    if (this.state.mode !== "track") return;
    const height = this.tracks.raise(plates);
    if (height === null) return;
    if (height > 0) this.measureTallestTrain();
    if (this.hovering) this.groundHit(this.pointerNdcX, this.pointerNdcY);
    if (this.tracks.dragging()) this.update(this.tracks.moveDrag(this.hitX, this.hitZ));
    else this.refreshTrackPreview();
    this.update({ ...this.tracks.view(), hover: this.hoverView() });
  }

  setTrackRampPlates(plates: number): void {
    if (!this.tracks.setRampPlates(plates)) return;
    if (this.tracks.dragging()) this.update(this.tracks.moveDrag(this.hitX, this.hitZ));
    else this.repaintTrackPreview();
    this.update(this.tracks.view());
  }

  cycleTrackChoice(step: 1 | -1): void {
    if (this.state.mode !== "track") return;
    if (this.tracks.resizeHeld(step)) {
      this.showHeldPiece();
      return;
    }
    const view = this.tracks.cycleChoice(step);
    if (view) this.update(view);
  }

  selectTrackChoice(index: number): void {
    if (this.state.mode !== "track") return;
    const view = this.tracks.selectChoice(index);
    if (view) this.update(view);
  }

  dropTrackEnd(): boolean {
    if (this.state.mode !== "track" || !this.tracks.dropExtension()) return false;
    this.repaintTrackPreview();
    return true;
  }

  previewTrackLoop(key: string | null): void {
    if (this.state.mode !== "track") return;
    const view = this.tracks.previewLoop(key);
    if (view) this.update(view);
  }

  closeTrackLoop(key: string | null, eventTimeMs: number): void {
    if (this.state.mode !== "track" || this.state.readOnly || this.tracks.holding()) return;
    if (this.tracks.dragging() || this.tracks.piering()) return;
    const lay = this.tracks.closeLoop(key);
    if (!lay) return;
    this.commitLay(lay, eventTimeMs);
    this.repaintTrackPreview();
  }

  private enterRoadMode(id: string): void {
    this.ghostRot = this.placeRot;
    if (this.state.mode === "track") this.tracks.drop();
    this.active = null;
    this.backend.setGhost(null);
    this.select([]);
    this.update({
      mode: "road",
      activeItem: id,
      pendingItem: null,
      connectorGaps: [],
      ghostRot: this.ghostRot,
      ...this.roads.view(),
      ...this.tracks.view(),
    });
  }

  private leaveRoadMode(): void {
    this.roads.drop();
    this.update({ mode: "select", activeItem: null, pendingItem: null, ...this.roads.view() });
  }

  chooseItem(id: string | null): void {
    if (noteToolOf(this.state.mode) !== null) this.setNoteTool(null);
    if (this.state.mode === "measure") this.setMeasuring(false);
    if (this.state.mode === "table") this.setTableTool(false);
    this.cancelFill();
    this.waitingFill = null;
    if (id !== null && this.state.readOnly) return;
    this.queueClick(null);
    this.cancelGesture();
    if (this.state.mode === "road" && id !== this.state.activeItem) this.leaveRoadMode();
    if (id !== null && this.roads.pick(id, this.placeRot)) {
      this.enterRoadMode(id);
      return;
    }
    if (id !== null && this.appendTrackPiece(id)) return;
    if (id !== null && this.tracks.pick(id)) {
      this.active = null;
      this.select([]);
      if (this.state.mode !== "track") this.trackWorld.setObstacles();
      this.update({ mode: "track", activeItem: id, pendingItem: null, ...this.tracks.view() });
      this.showHeldPiece();
      this.repaintTrackPreview();
      return;
    }
    if (this.state.mode === "track") {
      this.tracks.drop();
      this.update({ mode: "select", activeItem: null, ...this.tracks.view() });
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
      this.select([]);
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
    if (placeable) this.select([]);
    this.keptRoadSnap = null;
    this.placeRot = this.ghostRot;
    this.placeGhost();
    const snap = this.roadFallback(this.pendingTurns) ?? this.roadReadout();
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
    this.select([]);
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
          if (queued?.item === id) this.replayQueued(queued);
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

  private showHeldPiece(): void {
    const view = this.heldPieceView();
    if (view) this.update(view);
  }

  private heldPieceView(): TrackEditView | null {
    return this.tracks.showHeld(this.hovering, this.hitX, this.hitZ, this.hoverX, this.hoverZ);
  }

  private placeHeldPiece(eventTimeMs: number): void {
    const placement = this.tracks.placeHeld(this.hoverX, this.hoverZ);
    switch (placement.kind) {
      case "none":
        return;
      case "refused":
        this.refuseTrack(placement.refusal);
        this.update(this.tracks.view());
        return;
      case "lay":
        this.commitLay(placement.lay, eventTimeMs);
        this.tracks.settleLay(placement.lay);
        this.showHeldPiece();
        this.update(this.tracks.view());
        return;
      default: {
        const unhandled: never = placement;
        throw new Error(`unhandled held placement ${String(unhandled)}`);
      }
    }
  }

  private applyTrackChange(change: TrackChange): RebuildReport {
    if (this.trackWorld.drawing() === null || change.lift.length + change.lay.length === 0) {
      return NOTHING_REBUILT;
    }
    this.tracks.interruptDrag();
    const report = this.trackWorld.apply(change);
    this.tracks.clearEnds();
    return report;
  }

  private throwRefused(next: EditSummary | null): boolean {
    if (next?.kind !== "throw-switch") return false;
    const lever = this.trackWorld
      .drawing()
      ?.switchLevers()
      .find((view) => view.placement === next.switchAt);
    const refusal = this.tracks.switchRefusal(next.switchAt, lever?.xLdu ?? 0, lever?.zLdu ?? 0);
    if (refusal === null) return false;
    this.refuseTrack(refusal);
    return true;
  }

  private throwSwitchAt(xLdu: number, zLdu: number, eventTimeMs: number): boolean {
    return this.attemptThrow(this.tracks.throwSwitchAt(xLdu, zLdu), eventTimeMs);
  }

  private throwSwitch(placement: number, xLdu: number, zLdu: number, eventTimeMs: number): boolean {
    return this.attemptThrow(this.tracks.throwSwitch(placement, xLdu, zLdu), eventTimeMs);
  }

  private attemptThrow(attempt: SwitchAttempt, eventTimeMs: number): boolean {
    switch (attempt.kind) {
      case "none":
        return false;
      case "refused":
        this.refuseTrack(attempt.refusal);
        return true;
      case "throw":
        this.commitThrow(attempt.thrown, eventTimeMs);
        this.update(this.tracks.view());
        return true;
      default: {
        const unhandled: never = attempt;
        throw new Error(`unhandled switch attempt ${String(unhandled)}`);
      }
    }
  }

  cycleConnector(): void {
    if (this.tracks.holding()) {
      this.tracks.nextConnector();
      this.showHeldPiece();
      return;
    }
    if (this.state.mode !== "track" || this.state.readOnly) return;
    const view = this.tracks.nextPreviewEnd();
    if (view) this.update(view);
  }

  mirrorPiece(): void {
    const item = this.tracks.mirror();
    if (item === null) return;
    this.update({ activeItem: item });
    this.showHeldPiece();
  }

  private groundPoint(
    ndcX: number,
    ndcY: number,
    out: Float64Array,
    at: number,
    planeY = 0,
  ): boolean {
    this.backend.rayThrough(ndcX, ndcY, this.ray);
    const originY = this.ray[1] ?? 0;
    const directionY = this.ray[4] ?? 0;
    if (directionY >= 0 || originY <= planeY) return false;
    const t = (planeY - originY) / directionY;
    out[at] = (this.ray[0] ?? 0) + (this.ray[3] ?? 0) * t;
    out[at + 1] = (this.ray[2] ?? 0) + (this.ray[5] ?? 0) * t;
    return true;
  }

  private drawingTrack(): TrackDrawing | null {
    return this.state.mode === "track" ? this.trackWorld.drawing() : null;
  }

  private groundHit(ndcX: number, ndcY: number): boolean {
    this.pointerNdcX = ndcX;
    this.pointerNdcY = ndcY;
    const drawing = this.drawingTrack();
    const planeY = drawing ? drawing.bandBottomLdu(drawing.drawingPlates) : 0;
    if (!this.groundPoint(ndcX, ndcY, this.groundScratch, 0, planeY)) return false;
    this.hitX = this.groundScratch[0] ?? 0;
    this.hitZ = this.groundScratch[1] ?? 0;
    this.hoverX = nearestStud(this.hitX);
    this.hoverZ = nearestStud(this.hitZ);
    return true;
  }

  private checkPlacement(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
    aimRay: Float64Array,
    placedRoads: PlacedRoads,
  ): PlacementCheck {
    const check = this.check;
    const train = this.activeTrain;
    check.aim = train ? this.aimTrain(train, aimRay, rot % 2 === 1) : null;
    check.yPlates = RESTS_ON_TABLE_Y_PLATES;
    check.waitingOn = NOT_WAITING;
    check.refusal = null;
    check.trackBlock = null;
    if (check.aim && check.aim.kind !== "off") return check;
    const connected = this.connectedOf(placeable);
    const pose = this.tilePose;
    pose.x = x;
    pose.z = z;
    pose.rot = rot;
    pose.yPlates = this.restingYPlatesAt(x, z);
    const { model, volumes, boxes, technic } = connected;
    const choice = this.tileChoice;
    this.search.check(model, volumes, boxes, technic, pose, RESTS_ON_TABLE_Y_PLATES, choice);
    check.yPlates = pose.yPlates;
    if (choice.waitingOn !== NOT_WAITING) {
      const neighbour = this.searchModels.get(choice.waitingOn)?.placeable.label ?? "";
      if (choice.waitFailed) check.refusal = failedLoadText(placeable.label, neighbour, "there");
      else check.waitingOn = choice.waitingOn;
      return check;
    }
    if (!choice.accepted) {
      check.refusal = refusalText(placeable.label, this.refusalHit(choice.overlap));
      return check;
    }
    check.trackBlock = this.modelTrackBlock(placeable, x, z, rot, check.yPlates, NO_TRACK_SKIP);
    check.refusal = this.roadOverlap(placeable, placedRoads, pose)?.reason ?? null;
    return check;
  }

  private placeGhost(): void {
    const placeable = this.active;
    if (!placeable || !this.hovering || this.fillTool?.previewing) {
      this.assist.cancel();
      this.railRefusal = null;
      this.railWaiting = null;
      return;
    }
    const startedMs = performance.now();
    if (this.placeOnRails(placeable)) return;
    const connected = this.connectedOf(placeable);
    const mode = this.placementMode();
    this.aimPick(this.placeRot, HELD_TURN_ONLY, mode);
    this.assist.aim({ placeable, connected, mode }, this.pick, startedMs);
  }

  private readonly frameWork = (startMs: number): void => {
    this.assistFrame(startMs);
    this.loopScanFrame(startMs);
  };

  private loopScanFrame(startMs: number): void {
    if (this.state.mode !== "track") return;
    const view = this.tracks.scanLoops(startMs + LOOP_SCAN_FRAME_BUDGET_MS);
    if (view) this.update(view);
  }

  private assistFrame(startMs: number): void {
    const outcome = this.assist.frame(startMs);
    switch (outcome) {
      case "quiet":
        return;
      case "published": {
        const snap = this.roadFallback(this.pendingTurns) ?? this.roadReadout();
        this.update({ hover: this.hoverView(), snap, ghostRot: this.placeRot });
        return;
      }
      case "restart":
        this.placeGhost();
        this.update({ hover: this.hoverView() });
        return;
      default: {
        const unhandled: never = outcome;
        throw new Error(`unhandled assist frame ${String(unhandled)}`);
      }
    }
  }

  private assistHost(): AssistHost {
    return {
      mateCounts: (report) =>
        mateCounts(report, this.shapes, this.studShapes, (owner) => this.placedViewOf(owner)),
      refusalHit: (overlap) => this.refusalHit(overlap),
      heldPoseRefusal: (placeable, pose) => this.heldPoseRefusal(placeable, pose),
      heldPoseWaits: () => this.heldShapesWait,
      restsOn: (connected, pose) =>
        this.search
          .restingOn(connected.volumes, pose, null)
          .flatMap((owner) => this.placedViewOf(owner) ?? []),
      lifts: (placeable, connected, pose) =>
        [...(this.liftUnder(placeable, connected, pose)?.keys() ?? [])].flatMap(
          (owner) => this.placedViewOf(owner) ?? [],
        ),
      neighbourhood: () => ({
        ldu: this.assistLdu,
        cells: cellsWithin(this.assistLdu),
        plates: platesWithin(this.assistLdu),
      }),
      showGhost: (pose) =>
        this.backend.placeGhost(pose.x, pose.yPlates * PLATE_LDU, pose.z, pose.rot),
      hoverWait: (choice) => this.hoverWait(choice),
    };
  }

  private hoverWait(choice: PlacementChoice): HoverWait | null {
    if (choice.waitingOn === NOT_WAITING) return null;
    const placed = this.placedViewOf(choice.waitingOn);
    return placed ? { placed, failed: choice.waitFailed } : null;
  }

  private heldPoseRefusal(
    placeable: Placeable,
    pose: LatticePose,
    lifted: ReadonlySet<PlacedModel> = NO_MODELS,
  ): string | null {
    this.heldShapesWait = false;
    return (
      this.trackPlacementRefusal(placeable, pose, lifted) ??
      this.roadOverlap(placeable, this.roadsWithout(lifted), pose)?.reason ??
      this.standingTrainCut(placeable, pose)
    );
  }

  private liftUnder(
    placeable: Placeable,
    { model, volumes, boxes, technic }: Connected,
    pose: LatticePose,
  ): ReadonlyMap<number, PlacedModel> | null {
    const [baseTopLdu, topLdu] = partTopsLdu(placeable.partBoxes);
    if (topLdu <= baseTopLdu) return null;
    const lifted = new Map<number, PlacedModel>();
    const choice = this.liftChoice;
    for (;;) {
      this.search.withdrawn(new Set(lifted.keys()), () =>
        this.search.check(model, volumes, boxes, technic, pose, RESTS_ON_TABLE_Y_PLATES, choice),
      );
      if (choice.accepted || choice.waitingOn !== NOT_WAITING) break;
      const blocker = this.searchModels.get(choice.overlap.owner);
      if (!blocker || !liesUnder(blocker, pose.yPlates * PLATE_LDU + baseTopLdu)) return null;
      lifted.set(choice.overlap.owner, blocker);
    }
    const models = new Set(lifted.values());
    const free =
      choice.accepted &&
      models.size > 0 &&
      this.groupBlock([...models], NO_PIECES, "delete") === null &&
      ![...lifted].some(([owner, blocker]) => this.bearsLoad(owner, blocker, models)) &&
      this.heldPoseRefusal(placeable, pose, models) === null;
    return free ? lifted : null;
  }

  private bearsLoad(owner: number, model: PlacedModel, lifted: ReadonlySet<PlacedModel>): boolean {
    this.placed.touching(model.box, this.liftNeighbours);
    const carries = this.liftNeighbours.some(
      (other) =>
        !lifted.has(other) &&
        this.search
          .restingOn(
            this.volumesOf(other.placeable),
            poseOf(other),
            this.searchIds.get(other.id) ?? null,
          )
          .includes(owner),
    );
    const track = this.trackWorld.drawing();
    track?.placementsWithin((box) => model.meetsInPlan(box), this.liftTrack);
    return carries || (track !== null && this.liftTrack.length > 0);
  }

  private assistReachLdu(): number {
    return farthestLatticeReachLdu(
      Math.min(Math.max(this.toleranceLdu(), ASSIST_FLOOR_LDU), ASSIST_BASIN_LDU),
    );
  }

  private toleranceLdu(): number {
    const widthPx = this.canvas?.clientWidth ?? 0;
    if (widthPx <= 0) return ASSIST_FLOOR_LDU;
    const sideNdcX = this.pointerNdcX + (NDC_SPAN * ASSIST_TOLERANCE_PX) / widthPx;
    const side = this.sideRay;
    this.backend.rayThrough(sideNdcX, this.pointerNdcY, side);
    const directionY = side[4] ?? 0;
    if (directionY >= 0) return ASSIST_BASIN_LDU;
    const t = -(side[1] ?? 0) / directionY;
    const dx = (side[0] ?? 0) + (side[3] ?? 0) * t - this.hitX;
    const dz = (side[2] ?? 0) + (side[5] ?? 0) * t - this.hitZ;
    return planeHypot(dx, dz);
  }

  private aimPick(rot: number, turns: number, mode: PlacementMode): void {
    const pick = this.pick;
    pick.x = this.hoverX;
    pick.z = this.hoverZ;
    pick.yPlates = RESTS_ON_TABLE_Y_PLATES;
    pick.rot = rot;
    pick.turns = turns;
    this.assistLdu = this.replayReachLdu ?? this.assistReachLdu();
    const reach = mode === "assist" ? this.assistLdu : PRECISE_RADIUS;
    pick.radiusLdu = reach;
    pick.cells = cellsWithin(reach);
    pick.plates = platesWithin(reach);
    pick.yPlates = this.aimedYPlates(this.ray, this.hitX, this.hitZ);
    pick.x = this.hoverX + nearestStud(this.topFaceShift[0] ?? 0);
    pick.z = this.hoverZ + nearestStud(this.topFaceShift[1] ?? 0);
  }

  private aimedYPlates(ray: Float64Array, groundX: number, groundZ: number): number {
    let nearest = Number.POSITIVE_INFINITY;
    let top = Number.NaN;
    let onTopFace = false;
    for (const model of this.placed.models()) {
      if (!model.aimedTop(ray, groundX, groundZ, this.surface)) continue;
      const t = this.surface[0] ?? Number.POSITIVE_INFINITY;
      if (t >= nearest) continue;
      nearest = t;
      top = this.surface[1] ?? Number.NaN;
      onTopFace = this.surface[2] === ON_TOP_FACE;
    }
    this.topFaceShift[0] = onTopFace ? (ray[0] ?? 0) + (ray[3] ?? 0) * nearest - groundX : 0;
    this.topFaceShift[1] = onTopFace ? (ray[2] ?? 0) + (ray[5] ?? 0) * nearest - groundZ : 0;
    if (!Number.isFinite(top)) return RESTS_ON_TABLE_Y_PLATES;
    return Math.max(RESTS_ON_TABLE_Y_PLATES, Math.floor(top / PLATE_LDU));
  }

  private searchPick(connected: Connected, moving: number | null, out: PlacementChoice): void {
    this.search.search(
      connected.model,
      connected.volumes,
      connected.boxes,
      connected.technic,
      this.pick,
      RESTS_ON_TABLE_Y_PLATES,
      moving,
      out,
    );
  }

  private aimTrain(train: PlayModel, ray: Float64Array, reversed: boolean): RailAim {
    const aim = this.railYard.aim(train, ray, reversed);
    if (aim.kind !== "seat" && aim.kind !== "couple") return aim;
    const track = this.trackWorld.drawing();
    const meetsTrack =
      track !== null &&
      track.raisedCount() > 0 &&
      this.railYard
        .seatFootprints(aim.seat, train.label)
        .some(({ outline, railTopLdu, topLdu }) =>
          track.raisedTrackOverlaps(outline, railTopLdu, topLdu, aim.seat.pieces),
        );
    if (meetsTrack) {
      const reason = `${train.label} would run into raised track there. Put it where it fits under every bridge.`;
      return { kind: "refused", reason, seat: aim.seat };
    }
    const model = this.modelMeetingSeat(aim.seat);
    if (!model) return aim;
    const { kind, part } = this.clash;
    const modelLabel = model.placeable.label;
    const { seat } = aim;
    switch (kind) {
      case "clear":
        return aim;
      case "clash": {
        const reason = `${train.label} would run into ${modelLabel} there. Put it where it clears every model.`;
        return { kind: "refused", reason, seat };
      }
      case "waiting":
        this.solidsAwaited = true;
        return { kind: "waiting", reason: shapesWaitText(train.label, modelLabel), seat };
      case "missing": {
        const reason = `${train.label} can't be checked against ${modelLabel}: ${this.partTitle(part)}'s shape didn't load.`;
        return { kind: "refused", reason, seat };
      }
      default: {
        const unhandled: never = kind;
        throw new Error(`unhandled clash ${String(unhandled)}`);
      }
    }
  }

  private partTitle(partIndex: number): string {
    const part = this.catalog.parts()[partIndex];
    return part ? `${part.id.replace(/^ldraw:/u, "")} ${part.title}` : `palette part ${partIndex}`;
  }

  private partClashes(): PartClash {
    this.partClash ??= new PartClash(this.catalog.partSolids());
    return this.partClash;
  }

  private modelMeetingSeat(seat: RailSeat): PlacedModel | null {
    const { bounds } = seat.solids;
    const reach = this.catalog.partSolids().studReach();
    const area = this.trainReach;
    area.minX = (bounds[0] ?? 0) - reach;
    area.minY = bounds[1] ?? 0;
    area.minZ = (bounds[2] ?? 0) - reach;
    area.maxX = (bounds[3] ?? 0) + reach;
    area.maxY = bounds[4] ?? 0;
    area.maxZ = (bounds[5] ?? 0) + reach;
    const models = this.trainNeighbours;
    const count = this.placed.over(area, models);
    const clash = this.clash;
    const found = this.modelClash;
    clash.kind = "clear";
    clash.part = NO_CLASH_PART;
    let named: PlacedModel | null = null;
    const solids = this.catalog.partSolids();
    for (let m = 0; m < count; m++) {
      const model = models[m];
      if (!model) continue;
      const { x, z, yPlates, rot } = model.handle;
      this.posedModel.place(model.placeable, x, z, yPlates * PLATE_LDU, rot, solids);
      const skip = this.trackWorld.carriedParts(model.placeable);
      this.partClashes().first(seat.solids, NO_SKIP, this.posedModel, skip, found);
      if (CLASH_RANK[found.kind] <= CLASH_RANK[clash.kind]) continue;
      clash.kind = found.kind;
      clash.part = found.part;
      named = model;
      if (found.kind === "clash") break;
    }
    return named;
  }

  private standingTrainCut(placeable: Placeable, pose: LatticePose): string | null {
    const solids = this.catalog.partSolids();
    this.posedModel.place(placeable, pose.x, pose.z, pose.yPlates * PLATE_LDU, pose.rot, solids);
    const skip = this.trackWorld.carriedParts(placeable);
    const clash = this.clash;
    const train = this.railYard.standingClash(this.posedModel, skip, this.partClashes(), clash);
    if (train === null) return null;
    switch (clash.kind) {
      case "clear":
        return null;
      case "clash":
        return `${placeable.label} would cut through ${train} standing there.`;
      case "waiting":
        this.solidsAwaited = true;
        this.heldShapesWait = true;
        return shapesWaitText(placeable.label, train);
      case "missing":
        return `${placeable.label} can't be checked against ${train}: ${this.partTitle(clash.part)}'s shape didn't load.`;
      default: {
        const unhandled: never = clash.kind;
        throw new Error(`unhandled clash ${String(unhandled)}`);
      }
    }
  }

  private placeOnRails(placeable: Placeable): boolean {
    const train = this.activeTrain;
    const aim = train ? this.aimTrain(train, this.ray, this.placeRot % 2 === 1) : null;
    this.trainAim = aim;
    if (!aim || aim.kind === "off") {
      if (this.ghostOnRails) {
        this.ghostOnRails = false;
        this.backend.setGhost({ ...placeable.parts, studs: placeable.studs });
      }
      return false;
    }
    this.assist.leave();
    this.railRefusal = aim.kind === "refused" ? aim.reason : null;
    this.railWaiting = aim.kind === "waiting" ? aim.reason : null;
    if (aim.seat) {
      const ghost = this.railYard.ghost(aim.seat);
      this.backend.setGhost(ghost.instances);
      this.backend.placeGhost(ghost.x, 0, ghost.z, 0);
      this.ghostOnRails = true;
      return true;
    }
    if (this.ghostOnRails) {
      this.ghostOnRails = false;
      this.backend.setGhost({ ...placeable.parts, studs: placeable.studs });
    }
    this.backend.placeGhost(this.hoverX, REFUSED_SEAT_LIFT_LDU, this.hoverZ, this.placeRot);
    return true;
  }

  private placedViewOf(owner: number): PlacedModelView | null {
    const model = this.searchModels.get(owner);
    if (!model) return null;
    const { x, z, yPlates, rot } = model.handle;
    return {
      item: model.placeable.id,
      label: model.placeable.label,
      pose: { x, z, yPlates, rot },
    };
  }

  private refusalHit(overlap: OverlapHit): HoverRefusalHit | null {
    const model = this.searchModels.get(overlap.owner);
    const placed = this.placedViewOf(overlap.owner);
    if (!model || !placed) return null;
    const partIndex = model.placeable.partTransforms.partIndex[overlap.instance];
    const asset = this.catalog.parts()[partIndex ?? -1];
    if (!asset) {
      throw new Error(`${placed.label} has no catalogue part at instance ${overlap.instance}`);
    }
    return {
      placed,
      part: asset.id,
      partLabel: asset.title,
      cellX: overlap.cellX,
      cellZ: overlap.cellZ,
      placedBottomLdu: overlap.bottomLdu,
      placedTopLdu: overlap.topLdu,
      heldBottomLdu: overlap.candidateBottomLdu,
      heldTopLdu: overlap.candidateTopLdu,
    };
  }

  private hoverView(): HoverView | null {
    if (!this.hovering) return null;
    const aim = this.active !== null ? this.trainAim : null;
    const onRails = aim !== null && aim.kind !== "off";
    const refusal = onRails ? this.railRefusal : this.assist.refusal;
    const waiting = onRails ? this.railWaiting : null;
    const yPlates = this.drawingTrack()?.drawingPlates ?? this.assist.yPlates;
    const { placement } = this.assist;
    const couples =
      aim?.kind === "couple" ? { end: aim.end, train: this.trainLabelOf(aim.holder.pose) } : null;
    const shown = this.state.hover;
    if (
      shown !== null &&
      shown.x === this.hoverX &&
      shown.z === this.hoverZ &&
      shown.yPlates === yPlates &&
      shown.refusal === refusal &&
      shown.waiting === waiting &&
      shown.onRails === onRails &&
      shown.couples?.end === couples?.end &&
      shown.couples?.train === couples?.train &&
      shown.placement === placement
    ) {
      return shown;
    }
    return {
      x: this.hoverX,
      z: this.hoverZ,
      yPlates,
      refusal,
      waiting,
      onRails,
      couples,
      placement,
    };
  }

  private roadReadout(): RoadSnapView | null {
    const surface = this.active?.road;
    if (!surface || !this.hovering || !this.state.snapRoads) return null;
    const pose = this.assist.placement?.pose ?? this.cursorPose();
    const probe = this.reusedRoadProbe(surface, pose);
    const fit = this.placedRoads.network.fit(probe, this.roadFit);
    const overlapping = roadOverlapCells(this.placedRoads, probe);
    const state = overlapping > 0 ? "refused" : fit.mismatchedCells > 0 ? "mismatched" : "free";
    return { state, ...fit, overlappingCells: overlapping };
  }

  private cursorPose(): LatticePose {
    const pose = this.tilePose;
    pose.x = this.hoverX;
    pose.z = this.hoverZ;
    pose.rot = this.placeRot;
    pose.yPlates = this.restingYPlatesAt(pose.x, pose.z);
    return pose;
  }

  private restingYPlatesAt(x: number, z: number): number {
    const point = this.restingPoint;
    point.minX = x;
    point.maxX = x;
    point.minZ = z;
    point.maxZ = z;
    const models = this.restingModels;
    const count = this.placed.over(point, models);
    const highest = this.restingTop;
    highest[0] = Number.NEGATIVE_INFINITY;
    for (let m = 0; m < count; m++) models[m]?.raiseToTopOver(x, z, highest);
    const top = highest[0] ?? Number.NEGATIVE_INFINITY;
    if (!Number.isFinite(top)) return RESTS_ON_TABLE_Y_PLATES;
    return Math.max(RESTS_ON_TABLE_Y_PLATES, Math.floor(top / PLATE_LDU));
  }

  private roadFallback(turns: number): RoadSnapView | null {
    const placeable = this.active;
    const surface = placeable?.road ?? null;
    if (!placeable || !surface || !this.hovering || !this.state.snapRoads) return null;
    if (this.placementMode() !== "assist") return null;
    const shown = this.assist.placement;
    const kept = this.keptRoadSnap;
    if (shown && !shown.settled && kept && sameLatticePose(kept.pose, shown.pose)) {
      return kept.view;
    }
    if (!shown || !shown.settled || !shown.accepted) return null;
    const cursorX = nearestStud(this.hitX);
    const cursorZ = nearestStud(this.hitZ);
    const snap = this.snapNear(surface, cursorX, cursorZ, turns);
    if (!snap) return null;
    const { pose } = shown;
    const moved = snap.x !== pose.x || snap.z !== pose.z || snap.rot !== pose.rot;
    if (moved && !this.roadSnapAccepted(placeable, snap, shown.joints)) return null;
    const snapped = moved ? { ...this.tilePose } : { ...pose };
    if (moved) {
      this.hoverX = snap.x;
      this.hoverZ = snap.z;
      this.placeRot = snap.rot;
      this.aimRoadSnap(placeable, snapped);
    }
    if (turns !== HELD_TURN) {
      this.ghostRot = snap.rot;
      this.pendingTurns = HELD_TURN;
    }
    const view: RoadSnapView = {
      state: "snapped",
      metCells: snap.metCells,
      joinedCells: snap.joinedCells,
      joinedRoadCells: snap.joinedRoadCells,
      mismatchedCells: 0,
      overlappingCells: 0,
    };
    this.keptRoadSnap = {
      item: placeable.id,
      cursorX,
      cursorZ,
      ghostRot: this.ghostRot,
      revision: this.search.revision(),
      placedRoads: this.placedRoads,
      pose: snapped,
      view,
    };
    return view;
  }

  private snapNear(
    surface: RoadSurface,
    cursorX: number,
    cursorZ: number,
    turns: number,
  ): RoadSnap | null {
    const query = this.snapQuery;
    const revision = this.search.revision();
    const { ghostRot, turnDirection, placedRoads } = this;
    if (
      query.answers(
        surface,
        ghostRot,
        turnDirection,
        turns,
        cursorX,
        cursorZ,
        revision,
        placedRoads,
      )
    ) {
      return query.snap;
    }
    const snap = snapToRoadEdge(
      placedRoads,
      surface,
      ghostRot,
      turnDirection,
      this.restingHeights,
      cursorX,
      cursorZ,
      turns,
    );
    query.remember(
      surface,
      ghostRot,
      turnDirection,
      turns,
      cursorX,
      cursorZ,
      revision,
      placedRoads,
      snap,
    );
    return snap;
  }

  private keptSnapHolds(): KeptRoadSnap | null {
    const kept = this.keptRoadSnap;
    const placeable = this.active;
    const holds =
      kept !== null &&
      placeable !== null &&
      this.hovering &&
      this.state.snapRoads &&
      this.placementMode() === "assist" &&
      kept.item === placeable.id &&
      kept.cursorX === nearestStud(this.hitX) &&
      kept.cursorZ === nearestStud(this.hitZ) &&
      kept.ghostRot === this.ghostRot &&
      kept.revision === this.search.revision() &&
      kept.placedRoads === this.placedRoads;
    return holds ? kept : null;
  }

  private roadSnapAccepted(placeable: Placeable, snap: RoadSnap, joints: number): boolean {
    const { model, volumes, boxes, technic } = this.connectedOf(placeable);
    const pose = this.tilePose;
    pose.x = snap.x;
    pose.z = snap.z;
    pose.rot = snap.rot;
    pose.yPlates = this.restingYPlatesAt(snap.x, snap.z);
    const choice = this.tileChoice;
    this.search.check(model, volumes, boxes, technic, pose, RESTS_ON_TABLE_Y_PLATES, choice);
    if (!choice.accepted || choice.waitingOn !== NOT_WAITING) return false;
    if (this.heldPoseRefusal(placeable, pose) !== null) return false;
    this.search.evaluate(model, pose, this.snapMates);
    return this.snapMates.jointCount >= joints;
  }

  private aimRoadSnap(placeable: Placeable, pose: LatticePose): void {
    const connected = this.connectedOf(placeable);
    this.aimPick(pose.rot, HELD_TURN_ONLY, "precise");
    this.pick.x = pose.x;
    this.pick.z = pose.z;
    this.pick.yPlates = pose.yPlates;
    this.assist.aim({ placeable, connected, mode: "assist" }, this.pick, performance.now());
  }

  private reusedRoadProbe(surface: RoadSurface, pose: LatticePose): RoadPlacement {
    const probe = this.roadProbeScratch;
    probe.x = pose.x;
    probe.z = pose.z;
    probe.yLdu = pose.yPlates * PLATE_LDU;
    probe.rot = pose.rot;
    probe.surface = surface;
    return probe;
  }

  private roadOverlap(
    placeable: Placeable,
    placedRoads: PlacedRoads,
    pose: LatticePose,
  ): RoadOverlap | null {
    const surface = this.state.snapRoads ? placeable.road : null;
    if (!surface) return null;
    const probe = this.reusedRoadProbe(surface, pose);
    const overlapping = roadOverlapCells(placedRoads, probe);
    if (overlapping === 0) return null;
    const fit = placedRoads.network.fit(probe, this.roadFit);
    return {
      reason: roadOverlapText(placeable, overlapping),
      counts: { mismatchedCells: fit.mismatchedCells, overlappingCells: overlapping },
    };
  }

  pointerMove(ndcX: number, ndcY: number): void {
    this.hovering = this.groundHit(ndcX, ndcY);
    if (noteToolOf(this.state.mode) !== null) {
      this.notes.hover(this.hovering ? this.notePointer(ndcX, ndcY) : null);
    }
    const kept = this.keptSnapHolds();
    if (!kept) this.keptRoadSnap = null;
    this.forgetPendingTurnsAway();
    const roadView =
      this.state.mode === "road" && this.hovering
        ? this.roads.hover(this.hitX, this.hitZ, this.roadNeighbourhood)
        : null;
    const tables = this.tables;
    if (this.state.mode === "table" && tables && this.hovering) {
      if (tables.hoverAt(this.hitX, this.hitZ, this.handleToleranceLdu(ndcX, ndcY))) {
        this.showGuides();
      }
    }
    const trackView = this.tracks.holding() ? this.heldPieceView() : this.trackPreviewView();
    const snap = kept ? this.keepRoadSnap(kept) : this.settleGhostHere();
    if (this.gesture?.kind === "paste" && this.hovering) this.aimHeld(this.gesture);
    const hover = this.hoverView();
    const ghostRot = this.placeRot;
    const state = this.state;
    if (
      roadView === null &&
      (trackView === null ||
        (trackView.track === state.track &&
          trackView.trackNotDrawable === state.trackNotDrawable &&
          trackView.trackTools === state.trackTools)) &&
      hover === state.hover &&
      snap === state.snap &&
      ghostRot === state.ghostRot
    ) {
      return;
    }
    this.update({ ...roadView, ...trackView, hover, snap, ghostRot });
  }

  private settleGhostHere(): RoadSnapView | null {
    this.placeRot = this.ghostRot;
    this.placeGhost();
    if (this.fillTool?.previewing) return null;
    return this.roadFallback(this.pendingTurns) ?? this.roadReadout();
  }

  private keepRoadSnap(kept: KeptRoadSnap): RoadSnapView {
    this.hoverX = kept.pose.x;
    this.hoverZ = kept.pose.z;
    this.placeRot = kept.pose.rot;
    return kept.view;
  }

  private forgetPendingTurnsAway(): void {
    if (this.pendingTurns === HELD_TURN) return;
    const atX = nearestStud(this.hitX);
    const atZ = nearestStud(this.hitZ);
    if (atX !== this.pendingTurnsAtX || atZ !== this.pendingTurnsAtZ) this.pendingTurns = HELD_TURN;
  }

  pointerLeave(): void {
    this.hovering = false;
    if (noteToolOf(this.state.mode) !== null) this.notes.hover(null);
    this.keptRoadSnap = null;
    this.assist.leave();
    this.update({ hover: null });
    if (this.state.mode === "table" && this.tables?.unhover()) this.showGuides();
  }

  private queueClick(queued: QueuedClick | null): void {
    if (queued === null && this.queuedClick === null) return;
    this.queuedClick = queued;
    this.update({
      queuedPlacement:
        queued === null ? null : { item: queued.item, x: queued.x, z: queued.z, rot: queued.rot },
    });
  }

  private clickedPick(item: string, eventTimeMs: number): QueuedClick {
    return {
      item,
      x: this.pick.x,
      z: this.pick.z,
      rot: this.ghostRot,
      mode: this.placementMode(),
      ray: Float64Array.from(this.ray),
      hitX: this.hitX,
      hitZ: this.hitZ,
      reachLdu: this.assistLdu,
      eventTimeMs,
    };
  }

  private replayQueued(queued: QueuedClick): void {
    const active = this.active;
    this.queueClick(null);
    if (!active || active.id !== queued.item || this.state.readOnly) return;
    if (this.state.pendingItem !== null || this.placementMode() !== queued.mode) return;
    const pointer = { hovering: this.hovering, ndcX: this.pointerNdcX, ndcY: this.pointerNdcY };
    const ghostRot = this.ghostRot;
    this.ray.set(queued.ray);
    this.hitX = queued.hitX;
    this.hitZ = queued.hitZ;
    this.hoverX = nearestStud(queued.hitX);
    this.hoverZ = nearestStud(queued.hitZ);
    this.ghostRot = queued.rot;
    this.replayReachLdu = queued.reachLdu;
    this.hovering = true;
    try {
      this.clickHeld(active, queued.eventTimeMs);
    } finally {
      this.replayReachLdu = null;
      this.ghostRot = ghostRot;
    }
    if (pointer.hovering) this.pointerMove(pointer.ndcX, pointer.ndcY);
    else this.pointerLeave();
  }

  private clickHeld(active: Placeable, eventTimeMs: number): void {
    const kept = this.keptSnapHolds();
    if (kept) {
      this.keepRoadSnap(kept);
    } else {
      this.keptRoadSnap = null;
      this.placeRot = this.ghostRot;
      this.placeGhost();
    }
    this.assist.commit();
    if (!kept && this.roadFallback(this.pendingTurns)) this.assist.commit();
    const at = { x: this.hoverX, z: this.hoverZ, rot: this.placeRot };
    const aim = this.trainAim;
    if (aim && aim.kind !== "off") {
      if (aim.kind === "refused") {
        this.refuse(refusedAt(active.id, at, aim.reason), null);
        return;
      }
      if (aim.kind === "waiting") {
        this.queueClick(this.clickedPick(active.id, eventTimeMs));
        return;
      }
      if (aim.kind === "couple") {
        this.couple(aim, { refId: this.activeRefId, colorId: active.worldColor }, eventTimeMs);
        return;
      }
      this.show(
        this.history.placeConsist({
          refId: this.activeRefId,
          colorId: active.worldColor,
          anchor: aim.seat.anchor,
          coupled: [],
        }),
        eventTimeMs,
      );
      return;
    }
    const placement = this.assist.placement;
    if (!placement) return;
    const { pose } = placement;
    if ((placement.waitingOn && !placement.waitingOn.failed) || this.assist.waitsOnShapes) {
      this.queueClick(this.clickedPick(active.id, eventTimeMs));
      return;
    }
    const lifted = placement.accepted ? this.liftedFor(active, placement) : null;
    if (!lifted) {
      const counts = this.roadOverlap(active, this.placedRoads, pose)?.counts ?? NO_ROAD_CELLS;
      this.refuse(refusedAt(active.id, pose, this.assist.refusal ?? "", counts), null);
      this.update({ hover: this.hoverView() });
      return;
    }
    this.dropping = true;
    try {
      this.placeAt(active, pose, lifted, eventTimeMs);
    } finally {
      this.dropping = false;
    }
  }

  click(ndcX: number, ndcY: number, eventTimeMs: number): void {
    const mode = this.state.mode;
    if (mode === "road" || mode === "measure" || mode === "table" || noteToolOf(mode) !== null) {
      return;
    }
    if (this.state.mode === "track") {
      if (!this.tracks.holding() || this.state.readOnly || !this.groundHit(ndcX, ndcY)) return;
      this.hovering = true;
      this.showHeldPiece();
      this.placeHeldPiece(eventTimeMs);
      return;
    }
    const pendingItem = this.state.pendingItem;
    if (pendingItem !== null) {
      if (this.state.readOnly || !this.groundHit(ndcX, ndcY)) return;
      this.aimPick(this.ghostRot, HELD_TURN_ONLY, this.placementMode());
      this.queueClick(this.clickedPick(pendingItem, eventTimeMs));
      return;
    }
    if (this.active && !this.state.readOnly) {
      if (!this.groundHit(ndcX, ndcY)) return;
      this.queueClick(null);
      this.hovering = true;
      this.clickHeld(this.active, eventTimeMs);
      return;
    }
    const gesture = this.gesture;
    if (gesture?.kind === "paste") {
      if (this.state.readOnly || !this.groundHit(ndcX, ndcY)) return;
      this.hovering = true;
      const placement = this.aimHeld(gesture);
      if (placement.refusal) {
        this.refuse(placement.refusal, `${PASTE_REFUSED} ${placement.refusal.reason}`);
        return;
      }
      this.endGesture();
      this.commitGroup("place", gesture, placement, eventTimeMs, PASTE_REFUSED, null);
      return;
    }
    const picked = this.pickAt(ndcX, ndcY);
    if (picked?.kind === "track") {
      this.clickTrack(picked.placement, ndcX, ndcY, eventTimeMs);
      return;
    }
    if (
      !picked &&
      this.groundHit(ndcX, ndcY) &&
      this.throwSwitchAt(this.hitX, this.hitZ, eventTimeMs)
    ) {
      return;
    }
    this.select(picked ? [picked] : []);
  }

  private clickTrack(placement: number, ndcX: number, ndcY: number, eventTimeMs: number): void {
    if (this.groundHit(ndcX, ndcY)) this.throwSwitch(placement, this.hitX, this.hitZ, eventTimeMs);
    this.select([{ kind: "track", placement }]);
  }

  toggleSelected(ndcX: number, ndcY: number): void {
    if (this.state.mode !== "select" || this.gesture) return;
    const picked = this.pickAt(ndcX, ndcY);
    if (!picked) return;
    this.selection.toggle(picked);
    this.showSelection();
  }

  selectTrackPath(ndcX: number, ndcY: number, scope: TrackPathScope): boolean {
    if (this.state.mode !== "select" || this.gesture) return false;
    const picked = this.pickAt(ndcX, ndcY);
    if (picked?.kind !== "track") return false;
    this.select(this.trackPaths.members(picked.placement, scope));
    return true;
  }

  selectPlacements(keys: ReadonlyArray<PlacementKey>): void {
    this.chooseItem(null);
    const wanted = new Set(keys.map(placementKeyText));
    const track = this.trackWorld.drawing();
    this.select([
      ...this.placed
        .models()
        .filter(({ handle }) => wanted.has(placementKeyText(handle)))
        .map((model): SelectionMember => ({ kind: "model", model })),
      ...keys
        .filter(
          ({ chunkKey, slot }) =>
            track !== null &&
            slot < track.pieceCount &&
            track.laidPieceView(slot).chunkKey === chunkKey,
        )
        .map(({ slot }): SelectionMember => ({ kind: "track", placement: slot })),
    ]);
  }

  private pickAt(ndcX: number, ndcY: number): SelectionMember | null {
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
    const trackHit = this.trackWorld.drawing()?.pieceOnRay(this.ray) ?? null;
    const trainT = train?.t ?? Number.POSITIVE_INFINITY;
    const trackT = trackHit?.distance ?? Number.POSITIVE_INFINITY;
    if (train && trainT < bestT && trainT <= trackT) return { kind: "train", train: train.handle };
    if (trackHit && trackT < bestT) return { kind: "track", placement: trackHit.placement };
    return best ? { kind: "model", model: best } : null;
  }

  private refuse(refusal: RefusedClick, selectionRefusal: string | null): void {
    this.update({
      refusedClicks: this.state.refusedClicks + 1,
      lastRefusal: refusal,
      selectionRefusal,
    });
  }

  private trackPlacementRefusal(
    placeable: Placeable,
    pose: LatticePose,
    exempt: ReadonlySet<PlacedModel>,
    skip: TrackSkip | null = null,
  ): string | null {
    const { x, z, yPlates, rot } = pose;
    const skipped = skip ?? this.trackSkip(NO_PIECES, exempt);
    const block = this.modelTrackBlock(placeable, x, z, rot, yPlates, skipped);
    return block === null ? null : blockRefusalText(placeable.label, block);
  }

  private modelTrackBlock(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
    yPlates: number,
    skip: TrackSkip,
  ): TrackBlockView | null {
    const drawing = this.trackWorld.drawing();
    if (!drawing) return null;
    const track = this.trackWorld.modelTrack(placeable);
    const carried = track && (track.pieces.length > 0 || track.runs.length > 0) ? track : null;
    const frame = carried ? latticeFrame(x, z, rot) : null;
    const pieces =
      carried && frame
        ? [
            ...heldPieces(carried, frame, yPlates),
            ...heldRuns(carried, frame, yPlates, WORLD_TRACK_FRAME.id + 1),
          ]
        : NO_HELD_TRACK;
    if (pieces.length === 0 && drawing.pieceCount + this.trackWorld.carriedModels().length === 0) {
      return null;
    }
    this.trackWorld.ensureObstacles();
    const probe = this.solidProbe;
    probe.placeable = placeable;
    probe.x = x;
    probe.z = z;
    probe.rot = rot;
    probe.yPlates = yPlates;
    return drawing.modelBlocker(
      this.solidRectsIn,
      pieces,
      skip.moving,
      skip.owners,
      this.probeSeatsStud,
    );
  }

  private trackSkip(
    pieces: ReadonlyArray<PieceMember>,
    exempt: ReadonlySet<PlacedModel>,
  ): TrackSkip {
    const track = this.trackWorld.drawing();
    if (!track || (pieces.length === 0 && exempt.size === 0)) return NO_TRACK_SKIP;
    const moving = new Set(pieces.flatMap(({ index }) => (index === null ? [] : [index])));
    for (const model of exempt) {
      const [first, last] = this.trackWorld.carriedRange(model) ?? [0, 0];
      for (let carried = first; carried < last; carried++) moving.add(track.pieceCount + carried);
    }
    const owners = new Set<number>();
    this.placed.models().forEach((model, index) => {
      if (exempt.has(model)) owners.add(index);
    });
    return { moving, owners };
  }

  private solidRectsAt(
    placeable: Placeable,
    x: number,
    z: number,
    rot: number,
    yPlates: number,
    [bottom, top]: readonly [number, number],
  ): number {
    const localBoxes = placeable.partBoxes;
    if (this.solidBoxes.length < localBoxes.length) {
      this.solidBoxes = new Float64Array(localBoxes.length);
      this.solidRects = new Float64Array((localBoxes.length / BOX_FLOATS) * OBSTACLE_RECT_FLOATS);
    }
    const boxes = writePosedPartBoxes(localBoxes, x, z, yPlates * PLATE_LDU, rot, this.solidBoxes);
    const rects = this.solidRects;
    const track = this.trackWorld.carriedParts(placeable);
    let floats = 0;
    for (let b = 0; b < localBoxes.length; b += BOX_FLOATS) {
      if (track.has(b / BOX_FLOATS)) continue;
      if ((boxes[b + 1] ?? 0) >= top || (boxes[b + 4] ?? 0) <= bottom) continue;
      rects[floats++] = boxes[b] ?? 0;
      rects[floats++] = boxes[b + 2] ?? 0;
      rects[floats++] = boxes[b + 3] ?? 0;
      rects[floats++] = boxes[b + 5] ?? 0;
    }
    return floats;
  }

  private labelOf(id: string): string {
    return this.catalogItems.find((item) => item.id === id)?.label ?? id;
  }

  private liftedFor(
    placeable: Placeable,
    { pose, lifts }: PlacementHover,
  ): ReadonlyArray<PlacedModel> | null {
    if (lifts.length === 0) return NO_LIFTED;
    const lifted = this.liftUnder(placeable, this.connectedOf(placeable), pose);
    return lifted && [...lifted.values()];
  }

  private placeAt(
    placeable: Placeable,
    pose: LatticePose,
    lifted: ReadonlyArray<PlacedModel>,
    eventTimeMs: number,
  ): void {
    const to = {
      refId: this.activeRefId,
      colorId: placeable.worldColor,
      x: pose.x,
      z: pose.z,
      yPlates: pose.yPlates,
      rot: pose.rot,
    };
    const lifts = lifted.map((model) => ({ placement: model.placement, to: null }));
    this.show(this.history.commit("place", [...lifts, { placement: null, to }]), eventTimeMs);
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

  private appendModelView(delta: PlanDelta, view: ViewUpdate): void {
    this.facts.noteRemoved(view.removed);
    this.facts.noteAdded(view.added);
    const updated = this.facts.flush(this.factUpdates);
    appendViewUpdate(delta, view);
    writeModelUpdates(delta, this.factUpdates, updated);
  }

  private queueFactFlush(): void {
    if (this.factsQueued) return;
    this.factsQueued = true;
    queueMicrotask(() => this.flushQueuedFacts());
  }

  private flushQueuedFacts(): void {
    if (!this.factsQueued) return;
    this.factsQueued = false;
    const updated = this.facts.flush(this.factUpdates);
    if (updated > 0) {
      this.planDelta.reset();
      writeModelUpdates(this.planDelta, this.factUpdates, updated);
      this.plans.apply(this.planDelta);
    }
    this.pushUnsupported();
  }

  private planEdited(change: PlanChange): void {
    this.show(this.history.commit("plan", [], NO_TRACK_CHANGE, change), performance.now());
  }

  private notesEdited(change: NoteChange): void {
    this.show(this.history.annotate(change), performance.now());
  }

  private eventEdited(change: EventChange): void {
    if (this.state.readOnly) return;
    this.show(this.history.editEvent(change), performance.now());
  }

  private show(
    edit: AppliedEdit,
    eventTimeMs: number,
    sample: EditSample | null = this.sampleOf(edit),
  ): ViewUpdate {
    if (edit.plan) this.plans.restore(edit.plan.after);
    if (edit.notes) this.annotations.restore(edit.notes.after);
    if (edit.event) this.events.restore(edit.event.after);
    const trackChanged = edit.track.lift.length + edit.track.lay.length > 0;
    const documentOnly =
      (edit.plan !== null || edit.notes !== null || edit.event !== null) &&
      edit.changes.length === 0 &&
      !trackChanged;
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
    const track = this.applyTrackChange(edit.track);
    const worldChanged = edit.changes.length > 0 || (!trackChanged && !documentOnly);
    if (worldChanged) this.session.placementsEdited(edit);
    if (trackChanged) this.session.trackEdited(edit.track.lift);
    if (edit.notes) this.session.notesEdited();
    if (edit.event) this.session.documentEdited();
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
    let carriedTrackChanged = false;
    if (!documentOnly) {
      this.refreshRoads();
      carriedTrackChanged = this.syncModelTrack();
      if (trackChanged) this.railsChanged();
      this.refreshTrains();
      this.placeGhost();
      if (!GROUP_EDITS.has(edit.kind)) this.followSelection(edit.track);
    }
    const hasTrack = this.trackWorld.drawing() !== null;
    const trackRows = trackChanged && hasTrack;
    if (worldChanged || trackRows) {
      const delta = this.planDelta;
      delta.reset();
      if (worldChanged) this.appendModelView(delta, view);
      if (trackRows) appendTrackChange(delta, this.trackWorld, edit.track);
      else if (carriedTrackChanged) this.trackWorld.writeIssues(delta);
      this.plans.apply(delta);
    }
    if (view.added.length + view.removed.length > 0) this.trackWorld.invalidateObstacles();
    if (!documentOnly) {
      if (hasTrack && this.state.mode === "track") this.trackWorld.ensureObstacles();
      this.layoutChanged();
    }
    this.update({
      selectionRefusal: null,
      placements: this.world.size,
      hover: this.hoverView(),
      studs: this.placed.studTotals(),
      history: this.historyView(),
      ...this.tracks.view(),
      lastFill: null,
    });
    this.repaintTrackPreview();
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

  private couple(
    aim: Extract<RailAim, { readonly kind: "couple" }>,
    held: { readonly refId: number; readonly colorId: number },
    eventTimeMs: number,
  ): void {
    const ref = this.consistRefs.get(aim.holder);
    if (!ref) throw new Error("the train being coupled to is not in the edit history");
    const standing = aim.holder.pose;
    const pose: ConsistPose =
      aim.end === "rear"
        ? {
            ...standing,
            anchor: aim.seat.anchor,
            coupled: [...standing.coupled, { ...held, reversed: aim.reversed }],
          }
        : {
            ...held,
            anchor: aim.seat.anchor,
            coupled: [
              { refId: standing.refId, colorId: standing.colorId, reversed: false },
              ...standing.coupled,
            ],
          };
    this.show(this.history.replaceConsist(ref, pose), eventTimeMs);
  }

  private trainLabelOf({ refId, coupled }: ConsistPose): string {
    return [refId, ...coupled.map((vehicle) => vehicle.refId)]
      .map((ref) => this.placeableAt(ref).label)
      .join(" + ");
  }

  private trainMembers(pose: ConsistPose): ReadonlyArray<TrainMember> | null {
    const members: TrainMember[] = [];
    for (const { refId, reversed } of [{ refId: pose.refId, reversed: false }, ...pose.coupled]) {
      const placeable = this.placeableAt(refId);
      const model = this.catalog.playModel(placeable);
      if (!model) return null;
      this.requestMeshes(placeable);
      members.push({ model, reversed });
    }
    return members;
  }

  private parkConsist(handle: ConsistHandle): void {
    const members = this.trainMembers(handle.pose);
    if (members) this.railYard.add(handle, members);
  }

  private sampleOf(edit: AppliedEdit): EditSample | null {
    const primary = edit.changes[0];
    const pose = primary?.to ?? primary?.from ?? null;
    if (pose) return { item: this.placeableAt(pose.refId).id, rot: pose.rot, x: pose.x, z: pose.z };
    const piece = edit.track.lay[0] ?? edit.track.lift[0];
    const track = this.trackWorld.drawing();
    if (!piece || !track) return null;
    const studs = zeta16ToStuds(piece.pose.position);
    return {
      item: `${TRACK_PIECE_PREFIX}${track.pieceByIndex(piece.piece).piece.id}`,
      rot: piece.pose.heading,
      x: Math.round(studs.x * STUD_LDU),
      z: Math.round(studs.z * STUD_LDU),
    };
  }

  private replanRoadStroke(): void {
    const view = this.roads.replanStroke(this.roadNeighbourhood);
    if (view) this.update(view);
  }

  private refreshRoads(): void {
    const started = performance.now();
    const roadModels = this.placed.models().filter((model) => model.placeable.road !== null);
    if (sameModels(roadModels, this.liveRoads.models)) {
      this.replanRoadStroke();
      return;
    }
    this.liveRoads.refresh(roadModels);
    this.trackWorld.setRoads(this.liveRoads.placements);
    this.placedRoads = this.liveRoads.placedRoads;
    this.facts.noteRoads(this.liveRoads.report, roadModels);
    this.replanRoadStroke();
    const checkMs = performance.now() - started;
    this.showMarkers();
    const report = this.liveRoads.report;
    const issues: RoadIssueView[] = [];
    for (const segment of report.segments) {
      if (segment.status === "joined" || issues.length >= LISTED_ROAD_ISSUES) continue;
      issues.push({
        status: segment.status,
        item: this.liveRoads.modelOf(segment.placement)?.placeable.id ?? "",
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
    if (this.selection.trains.some((train) => this.trainView(train) === null)) this.select([]);
    const onRails = new Set(this.railYard.trains().map((train) => train.handle));
    this.update({
      trains: this.consists.consists().map((handle) => ({
        item: this.placeableAt(handle.pose.refId).id,
        label: this.trainLabelOf(handle.pose),
        onRails: onRails.has(handle),
      })),
    });
  }

  private showMarkers(): void {
    const joins: EdgeMarker[] = this.state.showJoins
      ? this.liveRoads.report.segments.map((segment) => this.joinMarkerOf(segment))
      : [];
    this.roads.setJoinMarkers(joins);
  }

  private joinMarkerOf(segment: RoadEdgeSegment): EdgeMarker {
    let marker = this.joinMarkers.get(segment);
    if (!marker) {
      marker = { box: markerBox(segment), kind: segment.status };
      this.joinMarkers.set(segment, marker);
    }
    return marker;
  }

  setShowGrid(show: boolean): void {
    this.ground.setShowGrid(show);
  }

  setMeasuring(on: boolean): void {
    if (on === (this.state.mode === "measure")) return;
    if (!on) {
      this.measure?.cancel();
      this.showGuides();
      this.update({ mode: "select" });
      return;
    }
    if (this.state.status !== "ready") return;
    this.chooseItem(null);
    this.select([]);
    this.update({ mode: "measure", activeItem: null });
  }

  setTableTool(on: boolean): void {
    if (on === (this.state.mode === "table")) return;
    if (!on) {
      this.tables?.arm(null);
      this.update({ mode: "select" });
      this.showGuides();
      return;
    }
    if (this.state.status !== "ready" || this.state.readOnly) return;
    this.chooseItem(null);
    this.select([]);
    this.tables?.planChanged();
    this.update({ mode: "table", activeItem: null });
    this.showGuides();
  }

  armTableType(typeId: number | null): void {
    const tables = this.tables;
    if (!tables) return;
    if (typeId !== null) {
      this.setTableTool(true);
      if (this.state.mode !== "table") return;
    }
    tables.arm(typeId);
    this.showGuides();
  }

  checkLayout(): void {
    const laid = placementsBox(this.plans.placements());
    if (this.state.status !== "ready" || this.state.readOnly || laid === null) return;
    this.plans.drawTable(guideGridAround(laid));
  }

  private armedTableView(): ArmedTableView | null {
    const armed = this.state.mode === "table" ? (this.tables?.armedTable ?? null) : null;
    if (!armed) return null;
    const type = this.plans.tableTypes().find((t) => t.id === armed.typeId);
    return type ? { ...armed, name: type.name, ...tableTypeSize(type, armed.turn) } : null;
  }

  clearRulers(): void {
    this.measure?.clear();
    this.showGuides();
  }

  setNoteTool(tool: NoteToolKind | null): void {
    const current = noteToolOf(this.state.mode);
    if (tool === current) return;
    if (tool === null) {
      this.notes.setTool(null);
      this.update({ mode: "select" });
      return;
    }
    if (this.state.status !== "ready") return;
    if (current === null) {
      this.chooseItem(null);
      this.select([]);
    }
    this.notes.setTool(tool);
    this.update({ mode: tool, activeItem: null });
    if (this.hovering) this.notes.hover(this.notePointer(this.pointerNdcX, this.pointerNdcY));
  }

  finishNote(): void {
    if (noteToolOf(this.state.mode) !== null) this.notes.finish();
  }

  private noteDragStart(ndcX: number, ndcY: number): boolean {
    const pointer = this.notePointer(ndcX, ndcY);
    if (!pointer) return false;
    this.notes.press(pointer);
    return true;
  }

  private notePointer(ndcX: number, ndcY: number): NotePointer | null {
    if (!this.groundHit(ndcX, ndcY)) return null;
    const reachLdu = this.handleToleranceLdu(ndcX, ndcY);
    if (this.state.mode !== "ruler") {
      return { x: this.hitX, z: this.hitZ, reachLdu, models: NO_NOTE_MODELS };
    }
    return this.rulerPointer(reachLdu);
  }

  private rulerPointer(reachLdu: number): NotePointer {
    const { ray } = this;
    let front: PlacedModel | null = null;
    let frontT = Number.POSITIVE_INFINITY;
    for (const model of this.placed.models()) {
      const t = model.rayHit(ray);
      if (t < frontT) {
        frontT = t;
        front = model;
      }
    }
    const x = front ? (ray[0] ?? 0) + (ray[3] ?? 0) * frontT : this.hitX;
    const z = front ? (ray[2] ?? 0) + (ray[5] ?? 0) * frontT : this.hitZ;
    const near = this.noteNeighbours;
    const count = this.placed.over(
      {
        minX: x - reachLdu,
        minY: Number.NEGATIVE_INFINITY,
        minZ: z - reachLdu,
        maxX: x + reachLdu,
        maxY: Number.POSITIVE_INFINITY,
        maxZ: z + reachLdu,
      },
      near,
    );
    const models: NoteModelView[] = front ? [this.noteModel(front, true)] : [];
    for (let m = 0; m < count; m++) {
      const model = near[m];
      if (model && model !== front) models.push(this.noteModel(model, false));
    }
    return { x, z, reachLdu, models };
  }

  private noteModel(model: PlacedModel, under: boolean): NoteModelView {
    const { handle } = model;
    const ref = this.catalog.refs()[handle.refId];
    if (ref === undefined) throw new Error(`placement refId ${handle.refId} has no catalog id`);
    return {
      placement: {
        ref,
        color: handle.colorId,
        x: handle.x,
        z: handle.z,
        yPlates: handle.yPlates,
        rot: handle.rot,
      },
      label: model.placeable.label,
      box: model.box,
      under,
    };
  }

  cycleFillGrid(): void {
    this.update({ fillGridStuds: nextFillGrid(this.state.fillGridStuds) });
    this.reframeFill();
  }

  fillTables(eventTimeMs: number): void {
    const fill = this.fillTool;
    const placeable = this.active;
    const planId = this.plans.activePlanId();
    if (!fill || !placeable || this.state.readOnly || this.state.mode !== "place") return;
    if (planId === null || fill.drafting) return;
    const tables = this.plans.regionView(planId).tables.map((top) => top.surface);
    fill.layTables(placeable.box, this.ghostRot, this.state.fillGridStuds * STUD_LDU, tables);
    this.commitFill(fill, placeable, eventTimeMs);
  }

  private fillDragStart(ndcX: number, ndcY: number): boolean {
    const fill = this.fillTool;
    const placeable = this.active;
    if (!fill || !placeable || this.state.readOnly || !this.groundHit(ndcX, ndcY)) return false;
    const gridLdu = this.state.fillGridStuds * STUD_LDU;
    fill.begin(placeable.box, this.ghostRot, gridLdu, this.hitX, this.hitZ);
    return true;
  }

  private previewFill(fill: FillTool): void {
    const placeable = this.active;
    if (!placeable) return;
    this.backend.setGhost(null);
    this.settleFill(fill, placeable);
    this.showGuides();
    this.update({ fillDraft: fill.view() });
  }

  private fillDragEnd(fill: FillTool, ndcX: number, ndcY: number, eventTimeMs: number): void {
    if (this.groundHit(ndcX, ndcY)) fill.drag(this.hitX, this.hitZ);
    const started = fill.previewing;
    fill.end();
    if (fill.cancelled) return;
    const placeable = this.active;
    if (!started || !placeable) {
      fill.cancel();
      this.click(ndcX, ndcY, eventTimeMs);
      return;
    }
    this.backend.setGhost({ ...placeable.parts, studs: placeable.studs });
    this.commitFill(fill, placeable, eventTimeMs);
    this.showGuides();
    if (this.hovering) this.resettleAtCursor();
    else this.placeGhost();
  }

  private commitFill(fill: FillTool, placeable: Placeable, eventTimeMs: number): void {
    if (fill.overLimit) {
      const reason = `That fill needs ${fill.wanted} tiles; one fill places at most ${MAX_FILL_TILES}.`;
      fill.cancel();
      this.update({
        fillDraft: null,
        lastFill: { item: placeable.id, placed: 0, refused: 0, alreadyThere: 0, reason },
      });
      return;
    }
    const reason = this.settleFill(fill, placeable);
    if (reason.waitingOn !== NOT_WAITING) {
      const neighbour = this.searchModels.get(reason.waitingOn)?.placeable.label ?? "";
      this.waitingFill = { placeable, rot: this.ghostRot, eventTimeMs };
      this.update({
        fillDraft: null,
        lastFill: {
          item: placeable.id,
          placed: 0,
          refused: 0,
          alreadyThere: 0,
          reason: waitingText(placeable.label, neighbour, "the fill"),
        },
      });
      return;
    }
    const requests = fill.requests(this.activeRefId, placeable.worldColor, this.ghostRot);
    const result: FillResult = {
      item: placeable.id,
      placed: requests.length,
      refused: fill.refused,
      alreadyThere: fill.alreadyThere,
      reason: fill.laid === 0 ? `No whole ${placeable.label} fits there.` : reason.refusal,
    };
    fill.cancel();
    if (requests.length > 0) this.dropFill(requests, eventTimeMs);
    this.update({ fillDraft: null, lastFill: result });
  }

  private dropFill(requests: Parameters<EditHistory["commit"]>[1], eventTimeMs: number): void {
    this.dropping = true;
    try {
      this.show(this.history.commit("fill", requests), eventTimeMs);
    } finally {
      this.dropping = false;
    }
  }

  private cancelFill(): void {
    if (!this.fillTool?.drafting || this.fillTool.cancelled) return;
    this.fillTool.cancel();
    const active = this.active;
    if (active) this.backend.setGhost({ ...active.parts, studs: active.studs });
    this.showGuides();
    this.update({ fillDraft: null });
    if (active && this.hovering) this.resettleAtCursor();
    else this.placeGhost();
  }

  private reframeFill(): void {
    const fill = this.fillTool;
    const placeable = this.active;
    if (!fill?.drafting || fill.cancelled || !placeable) return;
    const gridLdu = this.state.fillGridStuds * STUD_LDU;
    if (fill.reframe(placeable.box, this.ghostRot, gridLdu)) this.previewFill(fill);
  }

  private settleFill(
    fill: FillTool,
    placeable: Placeable,
  ): { readonly refusal: string | null; readonly waitingOn: number } {
    const rot = this.ghostRot;
    let reason: string | null = null;
    let waitingOn = NOT_WAITING;
    const { placedRoads } = this;
    for (let tile = 0; tile < fill.laid; tile++) {
      const x = fill.xAt(tile);
      const z = fill.zAt(tile);
      const check = this.checkPlacement(placeable, x, z, rot, this.downRayAt(x, z), placedRoads);
      if (waitingOn === NOT_WAITING) waitingOn = check.waitingOn;
      const refused = placementRefused(check, "refused");
      const there = refused && this.alreadyPlacedAt(placeable, x, z, rot);
      if (refused && !there && reason === null) {
        reason = placementRefusal(placeable, check, "refused");
      }
      fill.settle(tile, check.yPlates, there ? "already-there" : refused ? "refused" : "free");
    }
    return { refusal: reason, waitingOn };
  }

  private alreadyPlacedAt(placeable: Placeable, x: number, z: number, rot: number): boolean {
    const models = this.tileModels;
    const count = this.placed.over(posedBox(placeable.box, x, z, 0, rot), models);
    const refId = this.activeRefId;
    const colorId = placeable.worldColor;
    for (let m = 0; m < count; m++) {
      const handle = models[m]?.handle;
      if (
        handle?.refId === refId &&
        handle.colorId === colorId &&
        handle.x === x &&
        handle.z === z &&
        handle.rot === rot
      ) {
        return true;
      }
    }
    return false;
  }

  private downRayAt(x: number, z: number): Float64Array {
    const ray = this.tileRay;
    ray[0] = x;
    ray[1] = 0;
    ray[2] = z;
    ray[3] = 0;
    ray[4] = -1;
    ray[5] = 0;
    return ray;
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
    this.showGuides();
    return true;
  }

  private tableDragStart(ndcX: number, ndcY: number): boolean {
    const tables = this.tables;
    if (!tables || !this.groundHit(ndcX, ndcY)) return false;
    tables.begin(this.hitX, this.hitZ, this.handleToleranceLdu(ndcX, ndcY));
    this.showGuides();
    return true;
  }

  private handleToleranceLdu(ndcX: number, ndcY: number): number {
    const x = this.hitX;
    const z = this.hitZ;
    const widthPx = this.canvas?.clientWidth ?? 0;
    const reached = widthPx > 0 && this.groundHit(ndcX + (2 * HANDLE_TOLERANCE_PX) / widthPx, ndcY);
    const tolerance = reached ? planeHypot(this.hitX - x, this.hitZ - z) : 0;
    this.groundHit(ndcX, ndcY);
    return Math.max(STUD_LDU, tolerance);
  }

  private plansChanged(): void {
    if (this.state.mode === "table" && this.tables?.planChanged()) this.showGuides();
    if (!this.mappingRequested && this.plans.plans().length > 0) void this.mapParts();
    this.reportPlans();
  }

  private reportPlans(): void {
    const regions = this.plans.plans();
    const activePlanId = this.plans.activePlanId();
    const tableTypes = this.plans.tableTypes();
    const reported = this.reportedPlans;
    if (
      regions === reported.regions &&
      activePlanId === reported.activePlanId &&
      tableTypes === reported.tableTypes
    ) {
      return;
    }
    this.reportedPlans = { regions, activePlanId, tableTypes };
    this.session.plansEdited(this.reportedPlans);
  }

  private async mapParts(): Promise<void> {
    this.mappingRequested = true;
    try {
      this.facts.mapWith(await this.loader.loadCrosswalk(EDITOR_LOD));
      this.queueFactFlush();
    } catch (error) {
      this.mappingRequested = false;
      this.update({ catalogError: `part mappings can't be read: ${errorText(error)}` });
    }
  }

  private showGuides(): void {
    const tables = this.state.mode === "table" ? this.tables : null;
    const guides = [...(this.measure?.guides() ?? []), ...(tables?.guides() ?? [])];
    this.fillTool?.guides(guides);
    this.backend.setGuides(guides);
    this.update({
      rulers: this.measure?.count ?? 0,
      rulerDraft: this.measure?.drafting ?? false,
      hoveredTable: tables?.hoveredTable ?? null,
      armedTable: this.armedTableView(),
      labels: this.labelsOf(this.state),
    });
  }

  setShowJoins(show: boolean): void {
    this.update({ showJoins: show });
    this.showMarkers();
  }

  setRoadErase(erase: boolean): void {
    this.roads.setErase(erase, this.roadNeighbourhood);
    this.update(this.roads.view());
  }

  setSnapRoads(snap: boolean): void {
    this.update({ snapRoads: snap, snap: null });
    this.rehover();
  }

  setPlacementMode(mode: PlacementMode): void {
    const before = this.placementMode();
    this.update({ placementMode: mode });
    if (this.placementMode() !== before) this.queueClick(null);
    this.rehover();
  }

  setPlacementModeOverride(held: boolean): void {
    const before = this.placementMode();
    this.update({ placementModeOverride: held });
    if (this.placementMode() !== before) this.queueClick(null);
    this.rehover();
  }

  private placementMode(): PlacementMode {
    return effectivePlacementMode(this.state.placementMode, this.state.placementModeOverride);
  }

  private rehover(): void {
    if (!this.active || !this.hovering) return;
    this.resettleAtCursor();
  }

  private resettleAtCursor(): void {
    this.keptRoadSnap = null;
    this.hoverX = nearestStud(this.hitX);
    this.hoverZ = nearestStud(this.hitZ);
    const snap = this.settleGhostHere();
    this.update({ hover: this.hoverView(), snap, ghostRot: this.placeRot });
  }

  planSheetShapes(): PlanSheetShapes {
    const models = new Map(this.placed.models().map((model) => [model.id, model]));
    const track = this.trackWorld.drawing();
    const ramps = this.trackWorld.crossingOutlines();
    const modelOf = (id: number): PlacedModel => {
      const model = models.get(id);
      if (!model) throw new Error(`no placed model has id ${id}`);
      return model;
    };
    const trackOf = (): TrackDrawing => {
      if (!track) throw new Error("no track has been laid");
      return track;
    };
    return {
      partsOf: (segment, source) => {
        const tally = new PartTally();
        switch (segment) {
          case "model":
            this.addPlaceableParts(tally, modelOf(source).placeable);
            break;
          case "track":
            trackOf().countPiece(tally, source);
            break;
          default: {
            const unhandled: never = segment;
            throw new Error(`unhandled plan segment ${String(unhandled)}`);
          }
        }
        return tally.total;
      },
      roadwayOf: (id) => {
        const model = modelOf(id);
        const surface = model.placeable.road;
        return surface ? roadwayCells(roadPlacementOf(id, model, surface)) : [];
      },
      trackOutlineOf: (piece) => trackOf().laidOutline(piece).lduRings(),
      crossingRamps: ramps.map((outline) => outline.lduRings()),
    };
  }

  private addPlaceableParts(target: PartSink, placeable: Placeable): void {
    const colors = this.catalog.colors();
    const { parts } = placeable;
    for (let i = 0; i < parts.count; i++) {
      target.add(parts.partIndex[i] ?? 0, colors.codeAt(parts.colorIndex[i] ?? 0), 1);
    }
  }

  bomInput(scope: BomScope): BomInput {
    const colors = this.bundleColors;
    if (!colors) throw new Error("the editor has not loaded");
    const placeables = this.catalog.placeables();
    const track = this.trackWorld.drawing();
    const counter = new BomCounter(
      this.catalog.parts().map((part) => part.id),
      colors.map((color) => color.code),
    );
    const placedCounts = new Map<number, number>();
    const pieceCounts = new Map<number, number>();
    const contents: BomContents = {
      addTo: (target, refId) => {
        const placeable = placeables[refId];
        if (!placeable) throw new Error(`world holds unknown placeable ${refId}`);
        placedCounts.set(refId, (placedCounts.get(refId) ?? 0) + 1);
        this.addPlaceableParts(target, placeable);
      },
      addPiece: (placement) => {
        if (!track) throw new Error(`track piece ${placement} is counted with no track laid`);
        const { piece } = track.laidPiece(placement);
        pieceCounts.set(piece, (pieceCounts.get(piece) ?? 0) + 1);
        track.countPiece(counter, placement);
      },
    };
    const { name, placements } = this.scopedBom(scope, counter, contents);
    return {
      name,
      lod: "standard",
      placements,
      counter,
      uncounted: [...placedCounts].flatMap(([refId, count]) => {
        const placeable = placeables[refId];
        if (!placeable) return [];
        return notDrawnItems(placeable.id, this.catalog.notDrawn(placeable), count);
      }),
      shopping: this.shoppingList(colors, placedCounts, pieceCounts),
    };
  }

  private scopedBom(scope: BomScope, counter: BomCounter, contents: BomContents): ScopedBom {
    switch (scope.kind) {
      case "world":
        return this.sceneBom(null, counter, contents);
      case "region":
        return this.sceneBom(scope.region, counter, contents);
      case "selection":
        return this.selectionBom(counter, contents);
      case "plan":
        return this.planBom(scope.planId, counter, contents);
      default: {
        const unhandled: never = scope;
        throw new Error(`unhandled scope ${String(unhandled)}`);
      }
    }
  }

  private shoppingList(
    colors: ReadonlyArray<BundleColor>,
    placed: ReadonlyMap<number, number>,
    pieces: ReadonlyMap<number, number>,
  ): ShoppingList {
    const shopping = new ShoppingListBuilder(
      this.catalog.parts(),
      this.catalog.colors(),
      colors,
      this.catalogItems,
    );
    for (const [refId, count] of placed) shopping.addPlaced(this.placeableAt(refId), count);
    const track = this.trackWorld.drawing();
    for (const [piece, count] of pieces) {
      if (!track) throw new Error(`track piece ${piece} is listed with no track laid`);
      const { partIndex, color } = track.pieceByIndex(piece);
      shopping.addTrack(partIndex, color, track.pieceSet.element(piece), count);
    }
    return shopping.list();
  }

  private sceneBom(
    region: PlacementRegion | null,
    counter: BomCounter,
    contents: BomContents,
  ): ScopedBom {
    let placements = countPlacements(this.world, contents, counter, region);
    for (const piece of this.trackWorld.drawing()?.piecesIn(region) ?? []) {
      contents.addPiece(piece);
      placements++;
    }
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
    return { name: EDITOR_WORLD_NAME, placements };
  }

  private planBom(planId: string, counter: BomCounter, contents: BomContents): ScopedBom {
    const plan = this.plans.plans().find((region) => region.id === planId);
    if (!plan) throw new Error(`no plan ${planId}`);
    const unchecked = this.plans.issues(planId).find((issue) => issue.rule === "unchecked");
    if (unchecked) throw new Error(unchecked.message);
    const byId = new Map(this.placed.models().map((model) => [model.id, model]));
    const rows = this.plans.placements();
    let placements = 0;
    for (let row = rows.first(); row !== NO_ROW; row = rows.next(row)) {
      if (!this.plans.contains(planId, row)) continue;
      const source = rows.sourceOf(row);
      const segment = rows.segmentOf(row);
      switch (segment) {
        case "model": {
          const model = byId.get(source);
          if (!model) throw new Error(`plan row ${row} names model ${source}, which isn't placed`);
          contents.addTo(counter, model.handle.refId, model.handle.colorId);
          break;
        }
        case "track":
          contents.addPiece(source);
          break;
        default: {
          const unhandled: never = segment;
          throw new Error(`unhandled plan row segment ${String(unhandled)}`);
        }
      }
      placements++;
    }
    return { name: `plan-${plan.name.replace(FILE_NAME_UNSAFE, "_")}`, placements };
  }

  private selectionBom(counter: BomCounter, contents: BomContents): ScopedBom {
    const track = this.trackWorld.drawing();
    const models = this.selection.models.filter((model) => model.handle.live);
    const trains = this.selection.trains.filter((train) => train.live);
    const placements = track ? this.selection.pieces : [];
    for (const model of models) contents.addTo(counter, model.handle.refId, model.handle.colorId);
    for (const train of trains) contents.addTo(counter, train.pose.refId, train.pose.colorId);
    for (const placement of placements) contents.addPiece(placement);
    const items = [
      ...models.map((model) => model.placeable.id),
      ...trains.map((train) => this.placeableAt(train.pose.refId).id),
      ...placements.map((placement) => track?.laidPieceView(placement).piece ?? ""),
    ];
    const [only, second] = items;
    if (only === undefined) throw new Error("nothing is selected");
    return {
      name:
        second === undefined
          ? `selection-${only.replace(FILE_NAME_UNSAFE, "_")}`
          : `selection-${items.length}-items`,
      placements: items.length,
    };
  }

  private select(chosen: ReadonlyArray<SelectionMember>, pivot: LatticePoint | null = null): void {
    const shown = chosen.filter(
      (member) => member.kind !== "train" || this.trainView(member.train) !== null,
    );
    this.selection.replace(shown, pivot);
    this.showSelection();
  }

  private showSelection(): void {
    const selection = this.selection.view(this.views);
    this.backend.setSelectionBoxes(selection?.members.map((member) => member.box) ?? []);
    this.update({ selection, selectionRefusal: null });
  }

  private pieceView(placement: number): TrackSelectionView {
    const track = this.trackWorld.drawing();
    if (!track) throw new Error(`track piece ${placement} is selected with no track drawing`);
    const piece = track.laidPieceView(placement);
    return {
      kind: "track",
      item: `${TRACK_PIECE_PREFIX}${piece.piece}`,
      centreX: piece.xLdu,
      centreZ: piece.zLdu,
      yPlates: piece.yPlates,
      heading: piece.heading,
      box: piece.box,
    };
  }

  private trainView(handle: ConsistHandle): TrainSelectionView | null {
    const box = this.railYard.box(handle);
    const train = this.railYard.trains().find((candidate) => candidate.handle === handle);
    if (!box || !train) return null;
    return {
      kind: "train",
      item: this.placeableAt(handle.pose.refId).id,
      vehicles: train.consist.vehicles.length,
      lengthLdu: train.consist.vehicles.reduce((sum, vehicle) => sum + vehicle.spec.lengthLdu, 0),
      box,
    };
  }

  rotate(eventTimeMs: number, direction: TurnDirection = 1): void {
    if (this.state.mode === "table") {
      if (!this.state.readOnly && this.tables?.turn()) this.showGuides();
      return;
    }
    if (this.state.mode === "text") {
      this.notes.turnSelected(direction);
      return;
    }
    if (this.state.mode === "road") {
      this.ghostRot = quarterTurned(this.ghostRot, direction);
      this.placeRot = this.ghostRot;
      this.roads.turn(this.ghostRot, this.roadNeighbourhood);
      this.update({ ghostRot: this.ghostRot, ...this.roads.view() });
      return;
    }
    if (this.tracks.holding()) {
      this.tracks.turnHeld(direction);
      this.showHeldPiece();
      return;
    }
    if (this.active) {
      this.turnDirection = direction;
      const fill = this.fillTool;
      const drafting = fill?.drafting === true && !fill.cancelled;
      const turnedFrom = drafting ? this.ghostRot : this.placeRot;
      const snapTurn = drafting || direction !== 1 || !this.hovering ? null : this.assist.snapTurn;
      this.ghostRot = snapTurn ?? quarterTurned(turnedFrom, direction);
      if (this.hovering) {
        this.hoverX = nearestStud(this.hitX);
        this.hoverZ = nearestStud(this.hitZ);
      }
      this.keptRoadSnap = null;
      this.pendingTurns = ANY_TURN;
      this.pendingTurnsAtX = nearestStud(this.hitX);
      this.pendingTurnsAtZ = nearestStud(this.hitZ);
      const snap = this.settleGhostHere();
      this.update({
        ghostRot: this.placeRot,
        snap,
        hover: this.hoverView(),
      });
      this.reframeFill();
      return;
    }
    const gesture = this.gesture;
    if (gesture && gesture.kind !== "box") {
      this.turnHeld(gesture, direction);
      return;
    }
    const pivot = this.selection.turnPivot(this.views);
    if (!pivot || this.state.readOnly) return;
    this.turnSelection(pivot, direction, eventTimeMs);
  }

  private turnSelection(pivot: LatticePoint, turns: number, eventTimeMs: number): void {
    const edit = this.groupEdit(this.selection.members, "turn");
    const placement = this.placeGroup(
      edit,
      {
        modelPoses: edit.models.map((member) => turnedAbout(member.pose, pivot, turns)),
        piecePoses: edit.pieces.map((piece) => pieceTurnedAbout(piece.pose, pivot, turns)),
      },
      false,
    );
    const refused = this.turnRefused(edit, turns);
    this.commitGroup("rotate", edit, placement, eventTimeMs, refused, pivot);
  }

  private turnRefused(edit: GroupEdit, turns: number): string {
    const [only, second] = edit.models;
    const pieces = edit.pieces.length;
    if (only && !second && pieces === 0) {
      return `Can't turn to ${quarterTurned(only.pose.rot, turns) * DEGREES_PER_QUARTER_TURN}°.`;
    }
    return !only && pieces === 1 ? PIECE_TURN_REFUSED : GROUP_TURN_REFUSED;
  }

  turnSelectedModelTo(rot: number, eventTimeMs: number): void {
    const [only, second] = this.selection.members;
    const pivot = this.selection.turnPivot(this.views);
    if (only?.kind !== "model" || second || !pivot || this.state.readOnly || this.gesture) return;
    const turns = quarterTurned(rot, -only.model.handle.rot);
    if (turns !== 0) this.turnSelection(pivot, turns, eventTimeMs);
  }

  removeTrain(index: number, eventTimeMs: number): void {
    if (this.state.readOnly) return;
    const handle = this.consists.consists()[index];
    const ref = handle ? this.consistRefs.get(handle) : undefined;
    if (!handle || !ref) return;
    if (this.selection.trains.includes(handle)) this.select([]);
    this.show(this.history.removeConsist(ref), eventTimeMs);
  }

  deleteSelection(eventTimeMs: number): void {
    if (noteToolOf(this.state.mode) !== null) {
      this.notes.deleteSelected();
      return;
    }
    const measure = this.measure;
    if (this.state.mode === "measure" && measure) {
      if (measure.drafting) measure.cancel();
      else measure.removeLast();
      this.showGuides();
      return;
    }
    if (this.state.mode === "table") {
      this.tables?.removeHovered();
      this.showGuides();
      return;
    }
    if (this.state.readOnly || this.gesture) return;
    const [train] = this.selection.trains;
    const trainRef = train ? this.consistRefs.get(train) : undefined;
    if (trainRef) {
      this.show(this.history.removeConsist(trainRef), eventTimeMs);
      this.select([]);
      return;
    }
    const chosen = this.selection.members;
    if (chosen.length === 0) return;
    const { models } = this.selection;
    const lifted = this.pieceMembers(this.selection.pieces);
    const block = this.groupBlock(models, lifted, "delete");
    if (block) {
      this.refuse(block, `${DELETE_REFUSED} ${block.reason}`);
      return;
    }
    const requests = models.map((model) => ({ placement: model.placement, to: null }));
    this.show(this.history.commit("remove", requests, this.trackChange(lifted, null)), eventTimeMs);
    this.select([]);
  }

  moveSelectionBy(dx: number, dz: number, eventTimeMs: number): void {
    const pivot = this.selection.turnPivot(this.views);
    if (!pivot || this.state.readOnly || this.gesture) return;
    const edit = this.groupEdit(this.selection.members, "move");
    const placement = this.placeGroup(
      edit,
      {
        modelPoses: edit.models.map((member) => translated(member.pose, dx, dz)),
        piecePoses: edit.pieces.map((piece) => pieceTranslated(piece.pose, dx, dz)),
      },
      false,
    );
    const moved = { x: pivot.x + dx, z: pivot.z + dz };
    this.commitGroup("move", edit, placement, eventTimeMs, moveRefused(edit), moved);
  }

  moveSelectionTo(xStuds: number, zStuds: number, eventTimeMs: number): void {
    const pivot = this.selection.turnPivot(this.views);
    if (!pivot || !Number.isSafeInteger(xStuds) || !Number.isSafeInteger(zStuds)) return;
    const dx = nearestStud(xStuds * STUD_LDU - pivot.x);
    const dz = nearestStud(zStuds * STUD_LDU - pivot.z);
    const box = unionBox(this.selection.boxes(this.views));
    const inWorld =
      isLatticePose(Math.floor(box.minX) + dx, Math.floor(box.minZ) + dz, 0) &&
      isLatticePose(Math.ceil(box.maxX) + dx, Math.ceil(box.maxZ) + dz, 0);
    if (inWorld && (dx !== 0 || dz !== 0)) this.moveSelectionBy(dx, dz, eventTimeMs);
  }

  copySelection(): void {
    if (!this.selection.movable) return;
    this.copied = {
      models: this.modelMembers(this.selection.models).map((member) => ({
        ...member,
        model: null,
      })),
      pieces: this.pieceMembers(this.selection.pieces).map((piece) => ({ ...piece, index: null })),
      pivot: latticeCentre(unionBox(this.selection.boxes(this.views))),
    };
    this.update({ clipboard: this.selection.members.length });
  }

  pasteClipboard(): void {
    const copied = this.copied;
    if (!copied || this.state.readOnly || this.state.mode !== "select" || this.gesture) return;
    this.holdGroup({
      kind: "paste",
      ...this.pasteEdit(copied.models, copied.pieces),
      frameModel: copied.models.length > 0 ? 0 : null,
      frame: copied.models[0]?.pose ?? WORLD_FRAME,
      grabX: copied.pivot.x,
      grabZ: copied.pivot.z,
      placement: null,
    });
  }

  selectDragStart(ndcX: number, ndcY: number, additive: boolean): SelectDragKind | null {
    if (this.state.mode !== "select" || this.state.pendingItem !== null || this.gesture) {
      return null;
    }
    const grabbed = this.pickAt(ndcX, ndcY);
    if (
      grabbed &&
      grabbed.kind !== "train" &&
      this.selection.has(grabbed) &&
      !this.state.readOnly &&
      this.groundHit(ndcX, ndcY)
    ) {
      const edit = this.groupEdit(this.selection.members, "move");
      const grabbedModel = grabbed.kind === "model" ? grabbed.model : null;
      const grabbedIndex = edit.models.findIndex((member) => member.model === grabbedModel);
      const frameModel = grabbedIndex >= 0 ? grabbedIndex : edit.models.length > 0 ? 0 : null;
      this.holdGroup({
        ...edit,
        kind: "move",
        frameModel,
        frame: frameModel === null ? WORLD_FRAME : (edit.models[frameModel]?.pose ?? WORLD_FRAME),
        grabX: this.hitX,
        grabZ: this.hitZ,
        placement: null,
      });
      return "move";
    }
    this.gesture = { kind: "box", startNdcX: ndcX, startNdcY: ndcY, additive };
    this.update({ gesture: { kind: "box", ...tallyOf([]) }, selectionRefusal: null });
    return "box";
  }

  selectDragMove(ndcX: number, ndcY: number): void {
    const gesture = this.gesture;
    if (!gesture) return;
    if (gesture.kind === "box") {
      const inside = this.membersInBox(gesture, ndcX, ndcY);
      const chosen = this.boxSelection(gesture, inside);
      this.backend.setSelectionBoxes(boxesOf(chosen, this.views));
      this.update({ gesture: { kind: "box", ...tallyOf(inside) } });
      return;
    }
    if (gesture.kind === "move" && this.groundHit(ndcX, ndcY)) this.aimHeld(gesture);
  }

  selectDragEnd(ndcX: number, ndcY: number, eventTimeMs: number): void {
    const gesture = this.gesture;
    if (!gesture || gesture.kind === "paste") return;
    if (gesture.kind === "box") {
      const inside = this.membersInBox(gesture, ndcX, ndcY);
      this.endGesture();
      this.select(this.boxSelection(gesture, inside));
      return;
    }
    const placement = this.groundHit(ndcX, ndcY) ? this.aimHeld(gesture) : gesture.placement;
    this.endGesture();
    if (!placement || this.state.readOnly || !this.moves(gesture, placement)) return;
    const pivot = this.selection.turnPivot(this.views);
    const { dx, dz } = this.heldShift(gesture, placement, this.cursorShift(gesture));
    const moved = pivot && { x: pivot.x + dx, z: pivot.z + dz };
    this.commitGroup("move", gesture, placement, eventTimeMs, moveRefused(gesture), moved);
  }

  cancelGesture(): void {
    if (this.state.mode === "table" && this.tables?.armedTable) this.armTableType(null);
    if (noteToolOf(this.state.mode) !== null) this.notes.cancel();
    if (this.gesture) this.endGesture();
    this.cancelFill();
    this.queueClick(null);
  }

  private endGesture(): void {
    const held = this.gesture?.kind !== "box";
    this.gesture = null;
    if (held) this.backend.setGhost(null);
    this.update({ gesture: null });
    this.showSelection();
  }

  private holdGroup(held: HeldGroup): void {
    this.gesture = held;
    this.backend.setGhost(this.heldGhost(held));
    this.update({ gesture: this.heldGroupView(held, null, NO_OFFSET), selectionRefusal: null });
    if (this.hovering) this.aimHeld(held);
  }

  private heldGhost(held: HeldGroup): ChunkInstances {
    const ghosts: GhostMember[] = held.models.map(({ placeable, pose }) => ({ placeable, pose }));
    const track = this.trackWorld.drawing();
    if (track && held.pieces.length > 0) {
      const pieces = track.piecesGhost(held.pieces, held.frame);
      ghosts.push({ placeable: { parts: pieces, studs: pieces.studs }, pose: held.frame });
    }
    return groupGhost(ghosts, held.frame);
  }

  private turnHeld(held: HeldGroup, direction: TurnDirection): void {
    const pivot = { x: nearestStud(held.grabX), z: nearestStud(held.grabZ) };
    const models = held.models.map((member) => ({
      ...member,
      pose: turnedAbout(member.pose, pivot, direction),
    }));
    const frameModel = held.frameModel === null ? undefined : models[held.frameModel];
    this.holdGroup({
      ...held,
      models,
      pieces: held.pieces.map((piece) => ({
        ...piece,
        pose: pieceTurnedAbout(piece.pose, pivot, direction),
      })),
      frame: frameModel?.pose ?? turnedAbout(held.frame, pivot, direction),
      grabX: pivot.x,
      grabZ: pivot.z,
      placement: null,
    });
  }

  private cursorShift(held: HeldGroup): { readonly dx: number; readonly dz: number } {
    return { dx: nearestStud(this.hitX - held.grabX), dz: nearestStud(this.hitZ - held.grabZ) };
  }

  private aimHeld(held: HeldGroup): GroupPlacement {
    const { dx, dz } = this.cursorShift(held);
    const placement = this.placeGroup(
      held,
      {
        modelPoses: held.models.map((member) => translated(member.pose, dx, dz)),
        piecePoses: held.pieces.map((piece) => pieceTranslated(piece.pose, dx, dz)),
      },
      this.state.snapRoads && this.placementMode() === "assist",
    );
    this.gesture = { ...held, placement };
    const target =
      held.frameModel === null
        ? translated(held.frame, dx, dz)
        : placement.modelPoses[held.frameModel];
    if (target) {
      const y = target.yPlates * PLATE_LDU;
      this.backend.placeGhost(target.x, y, target.z, target.rot);
    }
    this.backend.setSelectionBoxes(this.placedBoxes(held, placement));
    this.update({ gesture: this.heldGroupView(held, placement, { dx, dz }) });
    return placement;
  }

  private placedBoxes(held: HeldGroup, placement: GroupTargets): ReadonlyArray<WorldBox> {
    const track = this.trackWorld.drawing();
    const boxes = placement.modelPoses.map((pose) =>
      posedBox(
        this.placeableAt(pose.refId).box,
        pose.x,
        pose.z,
        pose.yPlates * PLATE_LDU,
        pose.rot,
      ),
    );
    if (!track) return boxes;
    held.pieces.forEach(({ piece }, index) => {
      const pose = placement.piecePoses[index];
      if (pose) boxes.push(track.pieceBox(piece, pose));
    });
    return boxes;
  }

  private heldShift(
    held: HeldGroup,
    placement: GroupPlacement | null,
    cursor: { readonly dx: number; readonly dz: number },
  ): { readonly dx: number; readonly dz: number } {
    const source = held.frameModel === null ? null : held.models[held.frameModel]?.model;
    const target = held.frameModel === null ? null : placement?.modelPoses[held.frameModel];
    if (source && target) return { dx: target.x - source.handle.x, dz: target.z - source.handle.z };
    return held.kind === "move" ? cursor : NO_OFFSET;
  }

  private heldGroupView(
    held: HeldGroup,
    placement: GroupPlacement | null,
    cursor: { readonly dx: number; readonly dz: number },
  ): GestureView {
    return {
      kind: held.kind,
      models: held.models.length,
      pieces: held.pieces.length,
      trains: 0,
      ...this.heldShift(held, placement, cursor),
      refusal: placement?.refusal?.reason ?? null,
    };
  }

  private moves(held: HeldGroup, placement: GroupPlacement): boolean {
    const track = this.trackWorld.drawing();
    const modelMoves = placement.modelPoses.some((pose, index) => {
      const model = held.models[index]?.model;
      return model !== null && model !== undefined && !samePose(pose, poseOf(model));
    });
    const pieceMoves = placement.piecePoses.some((pose, index) => {
      const at = held.pieces[index]?.index;
      return (
        at !== null &&
        at !== undefined &&
        track !== null &&
        !pose16Equals(pose, track.laidPiece(at).pose)
      );
    });
    return modelMoves || pieceMoves;
  }

  private membersInBox(drag: BoxDrag, ndcX: number, ndcY: number): ReadonlyArray<SelectionMember> {
    const quad = this.boxQuad;
    const corners = [
      drag.startNdcX,
      drag.startNdcY,
      ndcX,
      drag.startNdcY,
      ndcX,
      ndcY,
      drag.startNdcX,
      ndcY,
    ];
    for (let corner = 0; corner < corners.length; corner += 2) {
      if (!this.groundPoint(corners[corner] ?? 0, corners[corner + 1] ?? 0, quad, corner)) {
        return [];
      }
    }
    const inside: SelectionMember[] = [];
    for (const model of this.placed.models()) {
      if (footprintInside(quad, model.box)) inside.push({ kind: "model", model });
    }
    const placements = this.boxedPlacements;
    this.trackWorld.drawing()?.placementsWithin((box) => footprintInside(quad, box), placements);
    for (const placement of placements) inside.push({ kind: "track", placement });
    return inside;
  }

  private boxSelection(
    drag: BoxDrag,
    inside: ReadonlyArray<SelectionMember>,
  ): ReadonlyArray<SelectionMember> {
    return drag.additive ? [...this.selection.members, ...inside] : inside;
  }

  private groupEdit(chosen: ReadonlyArray<SelectionMember>, action: GroupAction): GroupEdit {
    const models = chosen.flatMap((member) => (member.kind === "model" ? [member.model] : []));
    const indices = chosen.flatMap((member) => (member.kind === "track" ? [member.placement] : []));
    const exempt = new Set(models);
    const pieces = this.pieceMembers(indices);
    return {
      action,
      models: this.modelMembers(models),
      pieces,
      exempt,
      placedRoads: this.roadsWithout(exempt),
      block: this.groupBlock(models, pieces, action),
      trackSkip: this.trackSkip(pieces, exempt),
    };
  }

  private modelMembers(chosen: ReadonlyArray<PlacedModel>): ReadonlyArray<ModelMember> {
    const components = this.joinedComponents(chosen);
    return chosen.map((model, index) => ({
      model,
      placeable: model.placeable,
      pose: poseOf(model),
      component: components[index] ?? index,
    }));
  }

  private joinedComponents(chosen: ReadonlyArray<PlacedModel>): ReadonlyArray<number> {
    const parent = chosen.map((_, index) => index);
    const root = (index: number): number => {
      let at = index;
      while (parent[at] !== at) at = parent[at] ?? at;
      return at;
    };
    const mates = chosen.map((model) =>
      this.searchIds.has(model.id) ? this.mateCountOf(model) : 0,
    );
    chosen.forEach((carrier, j) => {
      const id = this.searchIds.get(carrier.id);
      if (id === undefined) return;
      const touching = chosen.flatMap((model, i) =>
        i !== j && (mates[i] ?? 0) > 0 && boxesTouch(model.box, carrier.box) ? [i] : [],
      );
      if (touching.length === 0) return;
      this.search.withdrawn(new Set([id]), () => {
        for (const i of touching) {
          const model = chosen[i];
          if (model && this.mateCountOf(model) < (mates[i] ?? 0)) parent[root(i)] = root(j);
        }
      });
    });
    return parent.map((_, index) => root(index));
  }

  private mateCountOf(model: PlacedModel): number {
    this.search.evaluate(this.connectedOf(model.placeable).model, poseOf(model), this.memberMates);
    return this.memberMates.count;
  }

  private pieceMembers(indices: ReadonlyArray<number>): ReadonlyArray<PieceMember> {
    const track = this.trackWorld.drawing();
    if (!track) return NO_PIECES;
    return indices.map((index) => {
      const { piece, pose, yPlates, rise } = track.laidPiece(index);
      return { index, piece, pose, yPlates, rise };
    });
  }

  private trackChange(
    pieces: ReadonlyArray<PieceMember>,
    targets: ReadonlyArray<Pose16> | null,
  ): TrackChange {
    const track = this.trackWorld.drawing();
    if (!track || pieces.length === 0) return NO_TRACK_CHANGE;
    const lift: TrackPieceAt[] = [];
    const lay: TrackPieceAt[] = [];
    let appended = track.pieceCount;
    pieces.forEach(({ index, piece, yPlates, rise }, member) => {
      if (index !== null) lift.push(track.laidPiece(index));
      const pose = targets?.[member];
      if (pose) lay.push({ index: index ?? appended++, piece, pose, yPlates, rise });
    });
    return { lift: lift.toSorted(byIndex), lay: lay.toSorted(byIndex) };
  }

  private roadsWithout(exempt: ReadonlySet<PlacedModel>): PlacedRoads {
    if (exempt.size === 0) return this.placedRoads;
    return this.liveRoads.excluding(exempt);
  }

  private pasteEdit(
    models: ReadonlyArray<ModelMember>,
    pieces: ReadonlyArray<PieceMember>,
  ): GroupEdit {
    return {
      action: "move",
      models,
      pieces,
      exempt: NO_MODELS,
      placedRoads: this.roadsWithout(NO_MODELS),
      block: this.seatsBlock(pieces, NO_MODELS),
      trackSkip: this.trackSkip(pieces, NO_MODELS),
    };
  }

  private placeGroup(edit: GroupEdit, targets: GroupTargets, snap: boolean): GroupPlacement {
    const refusal = this.groupRefusal(edit, targets);
    if (!snap || refusal !== null) return { ...targets, refusal };
    const offset = this.roadSnapOffset(edit.models, targets.modelPoses, edit.placedRoads);
    if (offset === NO_OFFSET) return { ...targets, refusal };
    const snapped: GroupTargets = {
      modelPoses: targets.modelPoses.map((pose) => translated(pose, offset.dx, offset.dz)),
      piecePoses: targets.piecePoses.map((pose) => pieceTranslated(pose, offset.dx, offset.dz)),
    };
    if (this.groupRefusal(edit, snapped) !== null || !this.keepsJoints(edit, targets, snapped)) {
      return { ...targets, refusal };
    }
    return { ...snapped, refusal: null };
  }

  private keepsJoints(edit: GroupEdit, targets: GroupTargets, snapped: GroupTargets): boolean {
    return this.search.withdrawn(this.searchIdsOf(edit.exempt), () => {
      for (let index = 0; index < edit.models.length; index++) {
        const member = edit.models[index];
        const target = targets.modelPoses[index];
        const moved = snapped.modelPoses[index];
        if (!member || !target || !moved) continue;
        const { model } = this.connectedOf(member.placeable);
        this.search.evaluate(model, target, this.snapMates);
        const held = this.snapMates.jointCount;
        this.search.evaluate(model, moved, this.snapMates);
        if (this.snapMates.jointCount < held) return false;
      }
      return true;
    });
  }

  private groupRefusal(edit: GroupEdit, placed: GroupTargets): RefusedClick | null {
    return this.search.withdrawn(
      this.searchIdsOf(edit.exempt),
      () =>
        edit.block ??
        this.unreadConnectors(edit.models) ??
        this.modelRefusal(edit, placed.modelPoses) ??
        this.pieceRefusal(edit, placed.piecePoses),
    );
  }

  private searchIdsOf(models: ReadonlySet<PlacedModel>): ReadonlySet<number> {
    const ids = new Set<number>();
    for (const model of models) {
      const id = this.searchIds.get(model.id) ?? this.awaitingIds.get(model.id);
      if (id !== undefined) ids.add(id);
    }
    return ids;
  }

  private unreadConnectors(models: ReadonlyArray<ModelMember>): RefusedClick | null {
    for (const { placeable, pose } of models) {
      if (this.connectorTables.loaded(placeable)) continue;
      return refusedAt(
        placeable.id,
        pose,
        `${placeable.label}: its connectors are still being read, so it can't be checked there yet.`,
      );
    }
    return null;
  }

  private roadSnapOffset(
    members: ReadonlyArray<ModelMember>,
    targets: ReadonlyArray<PlacementPose>,
    placedRoads: PlacedRoads,
  ): { readonly dx: number; readonly dz: number } {
    let best: { readonly dx: number; readonly dz: number; readonly distance: number } | null = null;
    for (let index = 0; index < members.length; index++) {
      const surface = members[index]?.placeable.road;
      const pose = targets[index];
      if (!surface || !pose) continue;
      this.groupHeight.yLdu = pose.yPlates * PLATE_LDU;
      const snapped = snapToRoadEdge(
        placedRoads,
        surface,
        pose.rot,
        1,
        this.groupHeight,
        pose.x,
        pose.z,
        HELD_TURN,
      );
      if (!snapped) continue;
      const dx = snapped.x - pose.x;
      const dz = snapped.z - pose.z;
      const distance = planeHypot(dx, dz);
      if (!best || distance < best.distance) best = { dx, dz, distance };
    }
    if (!best || !this.roadCleanShifted(members, targets, placedRoads, best.dx, best.dz))
      return NO_OFFSET;
    return best;
  }

  private roadCleanShifted(
    members: ReadonlyArray<ModelMember>,
    targets: ReadonlyArray<PlacementPose>,
    placedRoads: PlacedRoads,
    dx: number,
    dz: number,
  ): boolean {
    for (let index = 0; index < members.length; index++) {
      const surface = members[index]?.placeable.road;
      const pose = targets[index];
      if (!surface || !pose) continue;
      const shifted = { ...pose, x: pose.x + dx, z: pose.z + dz };
      if (overlapsPlacedRoad(placedRoads, this.reusedRoadProbe(surface, shifted))) return false;
    }
    return true;
  }

  private modelRefusal(
    check: ModelCheck,
    poses: ReadonlyArray<PlacementPose>,
  ): RefusedClick | null {
    const { models: members, exempt, placedRoads, trackSkip: skip } = check;
    const supported = new Set<number>();
    const lowest = new Map<number, number>();
    for (let index = 0; index < poses.length; index++) {
      const pose = poses[index];
      const member = members[index];
      if (!pose || !member) continue;
      const { placeable, component } = member;
      const { yPlates } = pose;
      const connected = this.connectedOf(placeable);
      const choice = this.groupChoice;
      const { model, volumes, boxes, technic } = connected;
      this.search.check(model, volumes, boxes, technic, pose, RESTS_ON_TABLE_Y_PLATES, choice);
      if (choice.waitingOn !== NOT_WAITING) {
        const neighbour = this.searchModels.get(choice.waitingOn)?.placeable.label ?? "";
        const reason = choice.waitFailed
          ? failedLoadText(placeable.label, neighbour, "there")
          : waitingText(placeable.label, neighbour, "it there");
        return refusedAt(placeable.id, pose, reason);
      }
      const hit = choice.accepted ? null : this.refusalHit(choice.overlap);
      if (hit) return refusedAt(placeable.id, pose, refusalText(placeable.label, hit));
      if (choice.accepted) supported.add(component);
      const low = lowest.get(component);
      if (low === undefined || yPlates < (poses[low]?.yPlates ?? yPlates)) {
        lowest.set(component, index);
      }
      const track = this.trackPlacementRefusal(placeable, pose, exempt, skip);
      if (track !== null) return refusedAt(placeable.id, pose, track);
      const road = this.roadOverlap(placeable, placedRoads, pose);
      if (road) return refusedAt(placeable.id, pose, road.reason, road.counts);
      const cut = this.standingTrainCut(placeable, pose);
      if (cut !== null) return refusedAt(placeable.id, pose, cut);
    }
    for (const [component, index] of lowest) {
      const base = members[index]?.placeable;
      const basePose = poses[index];
      if (supported.has(component) || !base || !basePose) continue;
      return refusedAt(base.id, basePose, refusalText(base.label, null));
    }
    return null;
  }

  private pieceRefusal(edit: GroupEdit, poses: ReadonlyArray<Pose16>): RefusedClick | null {
    const track = this.trackWorld.drawing();
    if (!track || edit.pieces.length === 0) return null;
    this.trackWorld.ensureObstacles();
    const { moving, owners } = edit.trackSkip;
    for (let index = 0; index < edit.pieces.length; index++) {
      const member = edit.pieces[index];
      const pose = poses[index];
      if (!member || !pose) continue;
      const { piece, yPlates, rise } = member;
      const blocked = track.pieceBlock(piece, pose, yPlates, rise, moving, owners);
      if (!blocked) continue;
      const label = this.pieceLabel(member);
      const at = { ...latticeCentre(track.pieceBox(member.piece, pose)), rot: 0 };
      return refusedAt(this.pieceItem(member.piece), at, blockRefusalText(label, blocked));
    }
    return null;
  }

  private pieceLabel(member: PieceMember): string {
    const track = this.trackWorld.drawing();
    if (!track) return "";
    return member.index === null
      ? track.pieceByIndex(member.piece).piece.title
      : track.footprintAt(member.index).label;
  }

  private pieceItem(piece: number): string {
    return `${TRACK_PIECE_PREFIX}${this.trackWorld.drawing()?.pieceByIndex(piece).piece.id ?? ""}`;
  }

  private laidPieceRefusal(placement: number, reason: string): RefusedClick {
    const view = this.pieceView(placement);
    return refusedAt(view.item, { ...latticeCentre(view.box), rot: 0 }, reason);
  }

  private groupBlock(
    models: ReadonlyArray<PlacedModel>,
    pieces: ReadonlyArray<PieceMember>,
    action: GroupAction,
  ): RefusedClick | null {
    return (
      this.supportBlock(models, action) ??
      this.trainBlock(models, pieces, action) ??
      (action === "delete" ? null : this.seatsBlock(pieces, new Set(models)))
    );
  }

  private supportBlock(
    chosen: ReadonlyArray<PlacedModel>,
    action: GroupAction,
  ): RefusedClick | null {
    const [only, second] = chosen;
    if (!only) return null;
    const stranding = this.strandedBy(new Set(chosen));
    const verb = ACTION_VERBS[action];
    if (stranding.kind === "none") return null;
    if (stranding.kind === "waiting") {
      const waiting = stranding.model;
      const own = chosen.includes(waiting);
      const neighbour = own ? "its" : `${waiting.placeable.label}'s`;
      const reason = stranding.failed
        ? `${only.placeable.label}: ${neighbour} connector data didn't load, so ${verb} it can't be checked.`
        : own
          ? `${waiting.placeable.label}: its connectors are still being read, so ${verb} it can't be checked yet.`
          : waitingText(only.placeable.label, waiting.placeable.label, `${verb} it`);
      return refusedAt(waiting.placeable.id, waiting.handle, reason);
    }
    const stranded = stranding.model;
    const left = stranded.placeable.label;
    const base = this.carrierAmong(stranded, chosen);
    if (base) {
      const ending = action === "turn" ? "floating or cut into it" : "floating";
      const reason = `${base.placeable.label}: ${left} rests on it, so ${verb} it would leave ${left} ${ending}. ${remedy(action, left)}`;
      return refusedAt(base.placeable.id, base.handle, reason);
    }
    const reason = second
      ? `${left} connects only through the selected models, so ${verb} them would leave ${left} unconnected. ${remedy(action, left)}`
      : `${only.placeable.label}: ${left} connects only through it, so ${verb} it would leave ${left} unconnected. ${remedy(action, left)}`;
    return refusedAt(only.placeable.id, only.handle, reason);
  }

  private trainBlock(
    models: ReadonlyArray<PlacedModel>,
    pieces: ReadonlyArray<PieceMember>,
    action: GroupAction,
  ): RefusedClick | null {
    const verb = ACTION_VERBS[action];
    for (const model of models) {
      const passenger = this.trainOnTrackOf(model);
      if (!passenger) continue;
      const reason = `${model.placeable.label}: ${passenger} stands on its track, so ${verb} it would leave the train off the rails. Delete ${passenger} first.`;
      return refusedAt(model.placeable.id, model.handle, reason);
    }
    for (const { index } of pieces) {
      const standing = index === null ? null : this.railYard.standingOn(index);
      if (index === null || !standing) continue;
      const train = this.placeableAt(standing.pose.refId).label;
      const reason = `${train} stands on this track piece, so ${verb} it would leave the train off the rails. Delete ${train} first.`;
      return this.laidPieceRefusal(index, reason);
    }
    return null;
  }

  private seatsBlock(
    pieces: ReadonlyArray<PieceMember>,
    exempt: ReadonlySet<PlacedModel>,
  ): RefusedClick | null {
    const track = this.trackWorld.drawing();
    const [first] = pieces;
    if (!track || !first) return null;
    const staying = this.placed.models().filter((model) => !exempt.has(model));
    if (!seatsPending(staying, track.verticalRange())) return null;
    const at = { ...latticeCentre(track.pieceBox(first.piece, first.pose)), rot: 0 };
    return refusedAt(
      this.pieceItem(first.piece),
      at,
      `${this.pieceLabel(first)}: ${SEATS_PENDING}.`,
    );
  }

  private carriersOf(model: PlacedModel): ReadonlyArray<number> {
    const id = this.searchIds.get(model.id);
    if (id === undefined || !this.connectorTables.loaded(model.placeable)) return [];
    return this.search.restingOn(this.connectedOf(model.placeable).volumes, poseOf(model), id);
  }

  private carrierAmong(rider: PlacedModel, chosen: ReadonlyArray<PlacedModel>): PlacedModel | null {
    const carriers = this.carriersOf(rider);
    return (
      chosen.find((model) => {
        const id = this.searchIds.get(model.id);
        return id !== undefined && carriers.includes(id);
      }) ?? null
    );
  }

  private commitGroup(
    kind: EditKind,
    edit: GroupEdit,
    placement: GroupPlacement,
    eventTimeMs: number,
    refused: string,
    pivot: LatticePoint | null,
  ): void {
    if (placement.refusal) {
      this.showSelection();
      this.refuse(placement.refusal, `${refused} ${placement.refusal.reason}`);
      return;
    }
    const requests: PlacementRequest[] = edit.models.map((member, index) => {
      const to = placement.modelPoses[index];
      if (!to) throw new Error(`the placement has no pose for member ${index}`);
      return { placement: member.model?.placement ?? null, to };
    });
    const change = this.trackChange(edit.pieces, placement.piecePoses);
    const view = this.show(this.history.commit(kind, requests, change), eventTimeMs);
    this.select(restoredMembers(view.added, change), pivot);
  }

  undo(eventTimeMs: number): void {
    const next = this.history.nextUndo();
    if (this.state.readOnly || this.throwRefused(next)) return;
    this.replay(this.history.undo(), eventTimeMs);
  }

  redo(eventTimeMs: number): void {
    const next = this.history.nextRedo();
    if (this.state.readOnly || this.throwRefused(next)) return;
    this.replay(this.history.redo(), eventTimeMs);
  }

  private replay(edit: AppliedEdit | null, eventTimeMs: number): void {
    if (!edit) return;
    this.cancelGesture();
    const pivot = edit.kind === "rotate" ? this.selection.rememberedPivot : null;
    const { added } = this.show(edit, eventTimeMs);
    if (this.tracks.holding()) this.showHeldPiece();
    if (this.active || !GROUP_EDITS.has(edit.kind)) return;
    const restoredTrain = edit.consists.at(-1)?.added;
    const restored = restoredMembers(added, edit.track);
    if (restoredTrain) this.select([{ kind: "train", train: restoredTrain }]);
    else if (restored.length > 0) this.select(restored, pivot);
    else this.followSelection(edit.track);
  }

  private followSelection(track: TrackChange): void {
    const dropped = this.selection.dropRemoved();
    if (this.selection.followTrackChange(track) || dropped) this.showSelection();
  }

  goTo(x: number, z: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    this.camera.lookAt(x, z, false);
  }

  planContents(planId: string): Decoded<PlanContents> {
    const region = this.plans.plans().find((plan) => plan.id === planId);
    if (!region) return { ok: false, issues: [{ path: "plan", message: "is no longer open" }] };
    const unchecked = this.plans.issues(planId).find((issue) => issue.rule === "unchecked");
    if (unchecked)
      return { ok: false, issues: [{ path: region.name, message: unchecked.message }] };
    const { models, pieces } = this.planMembers(planId);
    const unheld = this.unheldInPlan(region.name, models);
    if (unheld) return { ok: false, issues: [unheld] };
    const refs = this.catalog.refs();
    const placements = models.map(({ handle }) => {
      const ref = refs[handle.refId];
      if (ref === undefined) throw new Error(`placement refId ${handle.refId} has no catalog id`);
      const { colorId, x, z, yPlates, rot } = handle;
      return { ref, color: colorId, x, z, yPlates, rot };
    });
    const laid = this.trackWorld.records();
    const track = pieces.map((piece, index) => {
      const record = laid[piece];
      if (!record) throw new Error(`plan row for track piece ${piece} has no laid piece`);
      return { ...record, index };
    });
    const placeables = new Map(models.map(({ placeable }) => [placeable.id, placeable]));
    const imported: PlanImport[] = [];
    const issues: Issue[] = [];
    for (const placeable of placeables.values()) {
      const sha256 = importedSha256(placeable.id);
      if (sha256 === null) continue;
      const customParts = this.catalog.customParts(placeable);
      if (customParts === null || placeable.credit === null) {
        const message = this.studChecks.has(placeable)
          ? "is still being checked; save the plan once its import finishes"
          : "has no import report, so its custom parts can't be credited; import it again";
        issues.push({ path: placeable.label, message });
        continue;
      }
      imported.push({ sha256, credit: placeable.credit, customParts });
    }
    if (issues.length > 0) return { ok: false, issues };
    const placed = [...placeables.values()].flatMap(({ credit }) => (credit ? [credit] : []));
    return { ok: true, value: { region, placements, track, placed, imported } };
  }

  private unheldInPlan(planName: string, members: ReadonlyArray<PlacedModel>): Issue | null {
    const reading = members.find((model) => !this.connectorTables.loaded(model.placeable));
    if (reading) {
      return {
        path: reading.placeable.label,
        message: "is still reading its connectors; save the plan once it has",
      };
    }
    const around = boxAround(members.map((model) => model.box));
    if (around === null) return null;
    const inside = new Set(members);
    const near = new Set(
      this.placed.models().filter((model) => !inside.has(model) && boxesTouch(model.box, around)),
    );
    const mated = members.filter((model) => !standsOnTable(model) && this.mateCountOf(model) > 0);
    const leaning = this.search.withdrawn(this.searchIdsOf(near), () =>
      mated.find((model) => this.mateCountOf(model) === 0),
    );
    if (leaning) {
      return {
        path: leaning.placeable.label,
        message:
          "rests only on models outside the plan, so it wouldn't be held where the plan opens. Widen the plan to take in what it rests on, or move it",
      };
    }
    if (!members.some(standsOnTable)) {
      return {
        path: planName,
        message:
          "has no model standing on the table, so nothing would hold it up where it opens. Widen the plan to take in what holds its models up",
      };
    }
    return null;
  }

  private planMembers(planId: string): {
    readonly models: ReadonlyArray<PlacedModel>;
    readonly pieces: ReadonlyArray<number>;
  } {
    const byId = new Map(this.placed.models().map((model) => [model.id, model]));
    const view = this.plans.placements();
    const models: PlacedModel[] = [];
    const pieces: number[] = [];
    for (let row = view.first(); row !== NO_ROW; row = view.next(row)) {
      if (!this.plans.contains(planId, row)) continue;
      const segment = view.segmentOf(row);
      switch (segment) {
        case "model": {
          const model = byId.get(view.sourceOf(row));
          if (!model) throw new Error(`plan row for model ${view.sourceOf(row)} has no placement`);
          models.push(model);
          break;
        }
        case "track":
          pieces.push(view.sourceOf(row));
          break;
        default: {
          const unhandled: never = segment;
          throw new Error(`unhandled plan segment ${String(unhandled)}`);
        }
      }
    }
    return { models, pieces };
  }

  async addPlan({ plan, shards }: StoredPlan): Promise<ReadonlyArray<Issue>> {
    await this.ensureStoredPlaceables({ shards, consists: [] });
    const poses = shardPoses(shards, (ref, color) => this.catalog.resolveRef(ref, color));
    if (!poses.ok) return poses.issues;
    const records = worldTrack(shards);
    const track = this.trackWorld.drawing();
    if (records.length > 0 && !track) {
      return [{ path: "track", message: "can't be laid: this app's bundle has no track pieces" }];
    }
    const laid = track?.laidPieces(records) ?? { ok: true, value: [] };
    if (!laid.ok) return laid.issues;
    const models = poses.value.map((pose) => ({
      model: null,
      placeable: this.placeableAt(pose.refId),
      pose,
      component: WHOLE_GROUP_COMPONENT,
    }));
    const pieces = laid.value.map(({ piece, pose, yPlates, rise }) => ({
      index: null,
      piece,
      pose,
      yPlates,
      rise,
    }));
    const targets = { modelPoses: poses.value, piecePoses: pieces.map((piece) => piece.pose) };
    const refusal = this.groupRefusal(this.pasteEdit(models, pieces), targets);
    if (refusal) return [{ path: plan.name, message: refusal.reason }];
    const change = this.plans.addition(plan);
    const requests = poses.value.map((to) => ({ placement: null, to }));
    const opened = this.history.commit(
      "open-plan",
      requests,
      this.trackChange(pieces, targets.piecePoses),
      change,
    );
    this.show(opened, performance.now());
    if (change.after.activePlanId !== null) this.camera.viewPlan(change.after.activePlanId);
    return [];
  }

  contents(): WorldContents {
    return {
      world: this.world,
      refs: this.catalog.refs(),
      track: this.trackWorld.records(),
      consists: this.consistRecords(),
      notes: this.annotations.records(),
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
      ...(pose.coupled.length > 0
        ? {
            coupled: pose.coupled.map((vehicle) => ({
              ref: this.catalog.refs()[vehicle.refId] ?? "",
              color: vehicle.colorId,
              reversed: vehicle.reversed,
            })),
          }
        : {}),
    }));
  }

  private pieceRecord(track: TrackPieceRef): ConsistPieceV1 {
    switch (track.kind) {
      case "laid":
        return laidPieceRecord(this.trackWorld.pieceCatalog(), track);
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
        return laidPieceRef(this.trackWorld.pieceCatalog(), record);
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

  private noteStudShapes(placeable: Placeable, model: ModelConnectors): void {
    const { seats } = placeable.studLattice;
    for (let c = 0; c < model.shape.length; c++) {
      if (model.gender[c] !== GENDER_MALE) continue;
      const at = c * ORIGIN_INTS;
      const cellX = ((model.origin[at] ?? 0) / SIXTEENTHS_PER_LDU - HALF_STUD_LDU) / STUD_LDU;
      const cellZ = ((model.origin[at + 2] ?? 0) / SIXTEENTHS_PER_LDU - HALF_STUD_LDU) / STUD_LDU;
      const baseLdu = (model.origin[at + 1] ?? 0) / SIXTEENTHS_PER_LDU;
      if (!Number.isInteger(cellX) || !Number.isInteger(cellZ)) continue;
      if (seats.has(cellX, cellZ, baseLdu)) this.markStudShape(model.shape[c] ?? NO_SHAPE);
    }
  }

  private markStudShape(shape: number): void {
    if (shape < 0) return;
    if (shape >= this.studShapeFlags.length) {
      const grown = new Uint8Array(Math.max(shape + 1, this.studShapeFlags.length * 2));
      grown.set(this.studShapeFlags);
      this.studShapeFlags = grown;
    }
    this.studShapeFlags[shape] = 1;
  }

  private connectedOf(placeable: Placeable): Connected {
    let connected = this.connected.get(placeable.id);
    if (!connected) {
      const tables = this.connectorTables.loaded(placeable);
      if (!tables) throw new Error(`${placeable.id} has no connector tables loaded yet`);
      const parts = this.catalog.parts();
      const boxes = partBoxes(placeable.partBoxes);
      connected = {
        model: this.search.model(
          tables.tables,
          placeable.partTransforms,
          this.trackWorld.modelTrack(placeable)?.openEnds ?? [],
        ),
        volumes: this.volumesOf(placeable),
        boxes,
        technic: FrozenTechnic.ofParts(
          parts.map((part) => part.technic),
          placeable.partTransforms,
          boxes.boxes,
        ),
      };
      this.connected.set(placeable.id, connected);
      this.noteStudShapes(placeable, connected.model);
    }
    return connected;
  }

  private volumesOf(placeable: Placeable): FrozenVolumes {
    let volumes = this.frozenVolumes.get(placeable.id);
    if (!volumes) {
      volumes = FrozenVolumes.ofPlaceable(placeable);
      this.frozenVolumes.set(placeable.id, volumes);
    }
    return volumes;
  }

  private searchable(model: PlacedModel): void {
    if (this.searchIds.has(model.id)) return;
    const { x, z, yPlates, rot } = model.handle;
    if (!this.connectorTables.loaded(model.placeable)) {
      if (this.awaitingIds.has(model.id)) return;
      const awaiting = this.nextSearchId++;
      this.search.awaitTables(awaiting, this.volumesOf(model.placeable), { x, z, yPlates, rot });
      this.awaitingIds.set(model.id, awaiting);
      this.searchModels.set(awaiting, model);
      this.connectorTables.load(model.placeable).then(
        () => {
          if (!this.awaitingIds.has(model.id)) return;
          for (const waiting of this.waitingFor(model.placeable)) {
            this.searchable(waiting);
            this.facts.noteSearchable(waiting);
          }
          this.queueFactFlush();
          this.tablesArrived();
        },
        (error: unknown) => {
          if (!this.awaitingIds.has(model.id)) return;
          for (const [, id] of this.awaitingIds) {
            if (this.searchModels.get(id)?.placeable.id === model.placeable.id) {
              this.search.tablesFailed(id);
            }
          }
          this.update({
            catalogError: `${model.placeable.label}'s connector records can't be read: ${errorText(error)}`,
          });
          this.tablesArrived();
        },
      );
      return;
    }
    const id = this.awaitingIds.get(model.id) ?? this.nextSearchId++;
    this.awaitingIds.delete(model.id);
    const { model: connectors, volumes, boxes, technic } = this.connectedOf(model.placeable);
    this.search.add(id, connectors, volumes, boxes, technic, { x, z, yPlates, rot });
    this.searchIds.set(model.id, id);
    this.searchModels.set(id, model);
  }

  private waitingFor(placeable: Placeable): ReadonlyArray<PlacedModel> {
    const waiting: PlacedModel[] = [];
    for (const id of this.awaitingIds.values()) {
      const model = this.searchModels.get(id);
      if (model?.placeable.id === placeable.id) waiting.push(model);
    }
    return waiting;
  }

  private unsearchable(model: PlacedModel): void {
    const id = this.searchIds.get(model.id) ?? this.awaitingIds.get(model.id);
    if (id === undefined) return;
    this.search.remove(id);
    this.searchIds.delete(model.id);
    this.awaitingIds.delete(model.id);
    this.searchModels.delete(id);
  }

  private tablesArrived(): void {
    this.rehover();
    const queued = this.queuedClick;
    if (queued && this.active && queued.item === this.active.id) this.replayQueued(queued);
    const waiting = this.waitingFill;
    const fill = this.fillTool;
    if (!waiting || !fill || this.active !== waiting.placeable || fill.drafting) return;
    this.waitingFill = null;
    if (this.ghostRot !== waiting.rot) return;
    if (fill.laid > 0) this.commitFill(fill, waiting.placeable, waiting.eventTimeMs);
    this.rehover();
  }

  private solidsArrived(): void {
    if (!this.solidsAwaited) return;
    this.solidsAwaited = false;
    this.rehover();
    const queued = this.queuedClick;
    if (queued && this.active && queued.item === this.active.id) this.replayQueued(queued);
  }

  private strandedBy(removed: ReadonlySet<PlacedModel>): ModelStranding {
    const ids = this.searchIdsOf(removed);
    if (ids.size === 0) return NOT_STRANDED;
    const stranding = this.search.strandedByRemoval(
      ids,
      (other) =>
        (this.searchModels.get(other)?.handle.yPlates ?? RESTS_ON_TABLE_Y_PLATES) <=
        RESTS_ON_TABLE_Y_PLATES,
    );
    switch (stranding.kind) {
      case "none":
        return NOT_STRANDED;
      case "stranded":
        return { kind: "stranded", model: this.searchModel(stranding.placement) };
      case "waiting":
        return {
          kind: "waiting",
          model: this.searchModel(stranding.placement),
          failed: stranding.failed,
        };
      default: {
        const unhandled: never = stranding;
        throw new Error(`unhandled stranding ${String(unhandled)}`);
      }
    }
  }

  private searchModel(placement: number): PlacedModel {
    const model = this.searchModels.get(placement);
    if (!model) throw new Error(`search placement ${placement} has no model`);
    return model;
  }

  private syncModelTrack(): boolean {
    if (!this.trackWorld.syncModelTrack()) return false;
    this.tracks.clearEnds();
    this.railsChanged();
    this.update(this.tracks.view());
    return true;
  }

  private trainOnTrackOf(model: PlacedModel): string | null {
    const range = this.trackWorld.carriedRange(model);
    const laid = this.trackWorld.pieceCount;
    if (!range) return null;
    for (let p = laid + range[0]; p < laid + range[1]; p++) {
      const standing = this.railYard.standingOn(p);
      if (standing) return this.placeableAt(standing.pose.refId).label;
    }
    return null;
  }

  private railsChanged(): void {
    const rails = this.trackWorld.playRails();
    this.railYard.setTrack(rails.track, rails.carriers);
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
    const noteIssues = this.annotations.load({
      notes: stored.notes,
      document: stored.document,
      world: this.world,
    });
    if (noteIssues.length > 0) return noteIssues;
    this.reportedPlans = stored.plans;
    this.plans.restore(stored.plans);
    for (const placeable of new Set(this.placed.models().map((model) => model.placeable))) {
      this.requestMeshes(placeable);
      this.requestFarModel(placeable);
    }
    if (this.trackWorld.pieceCount > 0) this.trackWorld.requestPieceMeshes();
    this.refreshRoads();
    this.syncModelTrack();
    this.railsChanged();
    for (const consist of restored.value.consists) {
      const handle = this.consists.add(consist);
      this.consistRefs.set(handle, this.history.adoptConsist(handle));
      this.parkConsist(handle);
    }
    this.refreshTrains();
    this.facts.flush(this.factUpdates);
    const fullRebuild = new PlanDelta();
    writeFullRebuild(fullRebuild, this.placed.models(), this.trackWorld);
    this.plans.apply(fullRebuild);
    this.trackWorld.invalidateObstacles();
    this.layoutChanged();
    this.update(this.tracks.view());
    return [];
  }

  private restore({ shards, consists, notes, document }: StoredContents): Decoded<RestoredWorld> {
    const world = new World();
    const handles = addShards(world, shards, (ref, color) => this.catalog.resolveRef(ref, color));
    if (!handles.ok) return handles;
    const noteIssues = this.annotations.check({ notes, document, world });
    if (noteIssues.length > 0) return { ok: false, issues: noteIssues };
    const trackIssues = this.trackWorld.restore(worldTrack(shards));
    if (trackIssues.length > 0) return { ok: false, issues: trackIssues };
    const issues: Issue[] = [];
    const poses: ConsistPose[] = [];
    consists.forEach((record, index) => {
      const path = `consist ${index}`;
      const target = this.trainVehicle(record, path, issues);
      const coupled = (record.coupled ?? []).flatMap((vehicle, v) => {
        const resolved = this.trainVehicle(vehicle, `${path} coupled vehicle ${v}`, issues);
        return resolved ? [{ ...resolved, reversed: vehicle.reversed }] : [];
      });
      const piece = this.pieceRef(record.track);
      if (!piece) {
        issues.push({ path, message: `"${record.track.ref}" isn't a track piece or a model` });
      }
      if (!target || !piece || coupled.length !== (record.coupled ?? []).length) return;
      const pose: ConsistPose = {
        refId: target.refId,
        colorId: target.colorId,
        anchor: {
          track: piece,
          route: record.route,
          reversed: record.reversed,
          offsetLdu: record.offsetLdu,
        },
        coupled,
      };
      const problem = consistPoseProblem(pose);
      if (problem) issues.push({ path, message: problem });
      else poses.push(pose);
    });
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: { world, handles: handles.value, consists: poses } };
  }

  private trainVehicle(
    { ref, color }: { readonly ref: string; readonly color: number },
    path: string,
    issues: Issue[],
  ): { readonly refId: number; readonly colorId: number } | null {
    const target = this.catalog.resolveRef(ref, color);
    if (!target) {
      issues.push({ path, message: `"${ref}" isn't in the catalog` });
      return null;
    }
    const placeable = this.catalog.placeables()[target.refId];
    if (placeable && !this.catalog.playModel(placeable)) {
      issues.push({ path, message: `${placeable.label} has no running gear to stand on rails` });
    }
    return target;
  }

  private replaceWorld({ world, handles }: RestoredWorld): void {
    this.tracks.setPiering(false);
    this.cancelGesture();
    this.select([]);
    this.cancelFill();
    this.clearRulers();
    this.placed.clear();
    this.railYard.clear();
    this.consistRefs.clear();
    this.trackWorld.adoptRestored();
    this.trackWorld.drawing()?.setTallestTrain(this.tallestTrains.current());
    this.search.clear();
    this.searchIds.clear();
    this.awaitingIds.clear();
    this.searchModels.clear();
    this.tracks.clearEnds();
    this.world = world;
    this.consists = new ConsistLayout();
    this.history = new EditHistory(world, this.consists, this.annotations);
    this.placed.addAll(
      handles.flatMap((handle) => {
        const placeable = this.catalog.placeables()[handle.refId];
        return placeable ? [{ placement: this.history.adopt(handle), handle, placeable }] : [];
      }),
    );
    for (const model of this.placed.models()) this.searchable(model);
    this.facts.noteWorld(this.placed.models());
    if (this.trackWorld.drawing() !== null && this.state.mode === "track") {
      this.trackWorld.setObstacles();
    }
    this.trackWorld.setRoads([]);
    this.forgetLayout();
    this.update({
      placements: world.size,
      history: this.historyView(),
      ...this.tracks.view(),
      studs: this.placed.studTotals(),
      catalogError: null,
      lastFill: null,
    });
    this.repaintTrackPreview();
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

  exportPlan(planId: string): Promise<ExportedWorld | null> {
    return this.session.exportPlan(planId);
  }

  openPlan(bytes: Uint8Array): Promise<boolean> {
    return this.session.openPlan(bytes);
  }

  trackRoutes(): ReadonlyArray<TrackRouteView> {
    return this.trackWorld.routes();
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
      laidTrack: this.trackWorld.records(),
      trackEnds: this.trackWorld.openEnds(),
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
                cells: cellsView(cells),
              },
            ]
          : [];
      }),
      placements: dumpPlacements(this.world),
      roadPlacements: this.liveRoads.models.map((model, id) => ({
        id,
        item: model.placeable.id,
        x: model.handle.x,
        z: model.handle.z,
        yPlates: model.handle.yPlates,
        rot: model.handle.rot,
      })),
      roads: this.liveRoads.reportByRank(),
      crossings: this.trackWorld.crossings().map(({ crossing, trackPlacements, ramps }) => ({
        tracks: trackPlacements,
        roads: crossing.roads.map((id) => this.liveRoads.rankOf(id)),
        roadwayCells: crossing.roadwayCells,
        ramps: ramps.map(({ part, x, y, z, rot, studMates }) => ({
          part,
          x,
          y,
          z,
          rot,
          studMates,
        })),
      })),
      studs: this.placed.studTotals(),
      studChecks: this.studChecks.size,
    };
  }
}

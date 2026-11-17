export {
  NO_STUD,
  RoadNetwork,
  placedCells,
  type RoadCellStatus,
  type RoadEdgeSegment,
  type RoadFit,
  type RoadJoinReport,
  type RoadPlacement,
  type RoadSide,
  type RoadSurface,
} from "./road-joins.ts";
export { SLOT_LIVE, World, type ChunkView, type PlacementHandle } from "./world.ts";
export {
  EditHistory,
  NO_TRACK_CHANGE,
  type AppliedChange,
  type AppliedEdit,
  type EditKind,
  type HistoryStep,
  type PlacementPose,
  type PlacementRef,
  type PlacementRequest,
  type TrackPieceAt,
  type TrackRequest,
} from "./edit-history.ts";
export { runningGearSpanProblem, type RunningGearSpan } from "./running-gear-span.ts";
export {
  TrackLayout,
  type TrackEndRef,
  type TrackPieceSpec,
  type TrackRoute,
} from "./track/track-layout.ts";
export {
  NO_EDGE,
  NO_END,
  NO_SWITCH,
  TrackGraph,
  type CoincidentEndsIssue,
  type TrackGraphIssue,
} from "./track/track-graph.ts";
export {
  mmRectInWorld,
  rectContains,
  rectsOverlap,
  regionOriginX,
  regionOriginZ,
  roomRect,
  studsInside,
  subtractRect,
  uncoveredBy,
  type LduRect,
  type MmRect,
  type PlanFootprint,
  type PlanObstacle,
  type PlanRegion,
  type PlanTable,
  type StudRect,
} from "./plan/plan-region.ts";
export {
  checkPlan,
  nearestTableLdu,
  overhangLdu,
  placementInRegion,
  regionOf,
  uncheckedPlan,
  type IssueSeverity,
  type PlacementKey,
  type PlanCheck,
  type PlanIssue,
  type PlanPlacement,
  type PlanRuleId,
  type TableTop,
} from "./plan/plan-rules.ts";
export {
  drawingKit,
  MAX_TURN_CURVES,
  type DrawingKit,
  type DrawingKitResult,
  type TurnSign,
} from "./track/drawing-kit.ts";
export {
  advance,
  connectorPose,
  layMoves,
  trackMove,
  type PlacedPiece,
  type TrackMove,
  type TrackPieceDef,
} from "./track/track-pose.ts";
export {
  runMoves,
  solveDrag,
  type DragPlan,
  type TrackRun,
  type TrackSegment,
} from "./track/track-solver.ts";
export {
  solveClosure,
  UNLIMITED_BUDGET,
  type ClosureResult,
  type SearchBudget,
} from "./track/closure.ts";
export {
  NO_TOP,
  VolumeIndex,
  cellChunkKey,
  firstOverlap,
  type CellVolumes,
  type Overlap,
  type OwnerFilter,
  type VolumeHit,
} from "./volume-index.ts";
export {
  SupportGrid,
  isSupported,
  trackSupport,
  upperSupport,
  type BaseCells,
  type TrackSupport,
  type UpperSupport,
} from "./support.ts";
export {
  HALF_PLANE_FLOATS,
  PLAN_TRIANGLE_FLOATS,
  packedCellKey,
  placedPlanCells,
  planTriangleCells,
  type PlaneTransform,
} from "./cell-raster.ts";
export { planTrianglesOverlap, type PlanBox } from "./plan-overlap.ts";

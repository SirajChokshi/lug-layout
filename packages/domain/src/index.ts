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
  classifyModuleEdge,
  edgesJoin,
  MODULE_SIDES,
  ModuleGrid,
  NO_TOP,
  type GridModule,
  type ModuleEdge,
  type ModuleEdgeKind,
  type ModuleEdgeReport,
  type ModuleEdgeStatus,
  type ModuleFit,
  type ModuleJoinCounts,
  type ModuleJoinReport,
  type ModuleSide,
} from "./module/module-edges.ts";
export {
  EditHistory,
  type AppliedChange,
  type AppliedEdit,
  type EditKind,
  type HistoryStep,
  type PlacementPose,
  type PlacementRef,
  type PendingChange,
  type PlacementRequest,
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
export { NEAR_MISS_RADIUS_LDU, endGaps, type EndGap, type TrackEnd } from "./track/end-gaps.ts";
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
  crossing,
  PLATES_PER_BRICK,
  rampRises,
  riserCourses,
  type CrossingVerdict,
  type RiserCourses,
  type TrackSpan,
} from "./track/elevation.ts";
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
  NO_VOLUME_TOP,
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
export { engagedStuds, pickSurface, type SurfaceHit } from "./stud-connection.ts";
export {
  AXIS_NEG_X,
  AXIS_NEG_Y,
  AXIS_NEG_Z,
  AXIS_POS_X,
  AXIS_POS_Y,
  AXIS_POS_Z,
  TechnicJoins,
  SEAM_HOLDS_X,
  SEAM_HOLDS_Z,
  alignmentSpan,
  oppositeAxis,
  seamLock,
  strongerShift,
  placedHoleEnds,
  type HoleEnds,
  type LatticePlacement,
  type ScoredShifts,
  type StrongerShift,
} from "./technic-joins.ts";

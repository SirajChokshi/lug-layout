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
export {
  ARM_BITS,
  armToward,
  extendRoadPath,
  planRoadErase,
  planRoadTiles,
  roadKits,
  roadPieceChoices,
  roadShape,
  rotateArms,
  type ExistingRoadTile,
  type PlannedRoadTile,
  type RoadEdgeRun,
  type RoadKit,
  type RoadKitCandidate,
  type RoadKitPiece,
  type RoadPieceChoice,
  type RoadShape,
  type RoadTile,
  type RoadTileRefusal,
} from "./road-tiles.ts";
export { SLOT_LIVE, World, type ChunkView, type PlacementHandle } from "./world.ts";
export {
  classifyModuleEdge,
  edgesJoin,
  MODULE_SIDES,
  ModuleGrid,
  NO_TOP,
  railEdgesMate,
  type GridModule,
  type GridPlacement,
  type RailEdgeClash,
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
  FOOTPRINT_FLOATS,
  HEADING_FOOTPRINT_FLOATS,
  headingFootprints,
  verticalRange,
} from "./track/heading-footprints.ts";
export { OccupancyGrid, cellChunkKey } from "./occupancy.ts";
export {
  DirtyShards,
  addShards,
  worldPlacements,
  type PlacementTarget,
  type ShardChange,
} from "./world-shards.ts";
export { BomCounter, byPartThenColor, type BomLine } from "./bom/bom-counter.ts";
export {
  countPlacements,
  type PlacementContents,
  type PlacementRegion,
} from "./bom/count-placements.ts";
export {
  INHERITED_COLOR,
  resolveLines,
  toCatalog,
  totalQuantity,
  type CatalogBom,
  type CatalogLine,
  type CatalogSystem,
  type ColorCrosswalkEntry,
  type Crosswalk,
  type MissingMapping,
  type PartComponent,
  type PartCrosswalkEntry,
  type ResolvedLine,
  type UnmappedLine,
} from "./bom/catalog-ids.ts";
export {
  brickLinkWantedListXml,
  plainBomCsv,
  rebrickableCsv,
  type UncountedItem,
} from "./bom/export-formats.ts";
export {
  AXIS_FREE,
  AXIS_NEG_X,
  AXIS_NEG_Y,
  AXIS_NEG_Z,
  AXIS_POS_X,
  AXIS_POS_Y,
  AXIS_POS_Z,
  ConnectorTable,
  GENDER_FEMALE,
  GENDER_MALE,
  SOURCE_INFERRED,
  SOURCE_PRIMITIVE,
  SOURCE_SHADOW,
} from "./connect/connector-table.ts";
export {
  CAP_FAR,
  CAP_ROOT,
  SECTION_AXLE,
  SECTION_ROUND,
  SECTION_SQUARE,
  SnapShapes,
} from "./connect/snap-shapes.ts";
export { SnapMating } from "./connect/mating.ts";
export { ModelConnectors, type PartInstances } from "./connect/model-connectors.ts";
export { CandidatePoses, type LatticePose, type SnapWindow } from "./connect/candidate-poses.ts";
export { MateReport } from "./connect/mate-report.ts";
export type { MateFinder } from "./connect/mate-finder.ts";
export { LatticeStudFinder } from "./connect/lattice-stud-finder.ts";
export { SparseConnectorFinder } from "./connect/sparse-connector-finder.ts";
export { TrackEndFinder } from "./connect/track-end-finder.ts";
export { ConnectionSolver } from "./connect/connection-solver.ts";

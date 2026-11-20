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
  EditHistory,
  type AppliedChange,
  type AppliedConsistChange,
  type AppliedEdit,
  type ConsistRef,
  type EditKind,
  type HistoryStep,
  type PlacementPose,
  type PlacementRef,
  type PlacementRequest,
} from "./edit-history.ts";
export {
  ConsistHandle,
  ConsistLayout,
  consistPoseProblem,
  type ConsistAnchor,
  type ConsistPose,
  type TrackPieceKey,
} from "./rail/consist-layout.ts";
export {
  RAIL_SPOT_FLOATS,
  RailNetwork,
  RailRun,
  SPOT_DISTANCE,
  SPOT_EDGE,
  SPOT_OFFSET,
} from "./rail/rail-network.ts";
export { runningGearSpanProblem, type RunningGearSpan } from "./running-gear-span.ts";
export {
  pointOnSegment,
  placeSegments,
  reversedSegments,
  segmentsEnd,
  wrapAngle,
  type PlacedSegment,
  type PlanPose,
  type SimPathSegment,
} from "./rail/route-geometry.ts";
export {
  backwardEdge,
  buildSimTrack,
  forwardEdge,
  trackPoint,
  type BuiltSimTrack,
  type SimRoute,
  type SimTrack,
  type SimTrackInput,
} from "./rail/sim-track.ts";
export { simTrackFromGraph, type TrackGraphTopology } from "./rail/graph-track.ts";
export {
  GEOMETRY_FIELDS,
  PIVOT_POINT_FLOATS,
  RunningGearPoser,
  VEHICLE_POSE_FLOATS,
  packGeometry,
  packSpecOnlyGeometry,
  type CouplerGeometry,
  type CouplerMount,
  type GuideGeometry,
  type PathSampler,
  type VehicleGeometry,
} from "./rail/running-gear.ts";
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
  NEAR_MISS_RADIUS_LDU,
  WORLD_TRACK_FRAME,
  endGaps,
  trackEndsJoin,
  type EndGap,
  type TrackEnd,
  type TrackFrame,
} from "./track/end-gaps.ts";
export {
  mmRectInWorld,
  rectContains,
  rectsOverlap,
  regionOriginX,
  regionOriginZ,
  roomRect,
  studsInside,
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
  freePlacement,
  layMoves,
  seatsOnStuds,
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
  type ClosureSite,
  type SearchBudget,
} from "./track/closure.ts";
export {
  NO_OBSTACLE,
  TrackClearance,
  footprintOutline,
  type PlacementFrame,
  type TrackOutlineSource,
} from "./track/track-clearance.ts";
export {
  FOOTPRINT_FLOATS,
  HEADING_FOOTPRINT_FLOATS,
  headingFootprints,
  planHull,
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
  SOURCE_PATCH,
  SOURCE_PRIMITIVE,
  SOURCE_SHADOW,
  axisDimension,
  axisSign,
  oppositeAxis,
  STATUS_UNVERIFIED,
  STATUS_VERIFIED,
} from "./connect/connector-table.ts";
export {
  CAP_FAR,
  CAP_ROOT,
  SECTION_AXLE,
  SECTION_ROUND,
  SECTION_SQUARE,
  SECTION_FLARE_JOINS_NEXT,
  SECTION_FLARE_JOINS_PREVIOUS,
  NO_GROUP,
  SnapShapes,
} from "./connect/snap-shapes.ts";
export { SnapMating, type MateFreedom } from "./connect/mating.ts";
export { ModelConnectors, NO_INSTANCE } from "./connect/model-connectors.ts";
export { rotatedAxis } from "./connect/lattice-frame.ts";
export {
  MATE_PASS_MODEL,
  MATE_PASS_PART,
  MATE_PASS_SUBMODEL,
  MatePairs,
  type MatePass,
} from "./connect/mate-pairs.ts";
export {
  ALL_COORDINATES,
  IDENTIFICATION_RESIDUAL_LDU,
  IdentifiedPoint,
  MODEL_ROOT,
  NO_FRAME,
  SubmodelFrames,
  TRANSFORM_FLOATS,
  coordinatesAcross,
  identifyDirection,
  identifyPoint,
  type PartInstances,
  type SubmodelInstances,
} from "./connect/submodel-frames.ts";
export { CandidatePoses, type LatticePose, type SnapWindow } from "./connect/candidate-poses.ts";
export {
  ENGAGED_AXIS,
  ENGAGED_FROM,
  ENGAGED_RADIUS,
  ENGAGED_TO,
  ENGAGED_U,
  ENGAGED_V,
  ENGAGEMENT_FLOATS,
  MateReport,
  NOT_ENGAGED,
  NO_PARTNER,
} from "./connect/mate-report.ts";
export type { MateFinder } from "./connect/mate-finder.ts";
export { LatticeStudFinder } from "./connect/lattice-stud-finder.ts";
export { SparseConnectorFinder } from "./connect/sparse-connector-finder.ts";
export { TrackEndFinder } from "./connect/track-end-finder.ts";
export { ConnectionSolver } from "./connect/connection-solver.ts";
export {
  NO_TECHNIC_ITEM,
  TECHNIC_BOX_FLOATS,
  TECHNIC_WAIVER_INTS,
  firstOtherAxis,
  modelTechnic,
  placeTechnicInto,
  secondOtherAxis,
  technicItemsOverlap,
  technicScratch,
  PosedTechnicBuffer,
  type PosedTechnic,
  type TechnicColumns,
  type TechnicSet,
} from "./technic-fit.ts";
export {
  VolumeIndex,
  FootprintGrid,
  firstOverlap,
  type CellVolumes,
  type OverlapHit,
  type OwnerFilter,
  type VolumeHit,
} from "./volume-index.ts";

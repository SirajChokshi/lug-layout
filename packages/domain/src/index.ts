export {
  NO_STUD,
  NO_TOP,
  PLACEMENT_CELL_INTS,
  PLACEMENT_JOINED,
  PLACEMENT_MISMATCHED,
  RoadNetwork,
  closesRoadEdge,
  placedCells,
  roadwayCells,
  type RoadCellStatus,
  type RoadEdgeSegment,
  type RoadFitSource,
  type RoadJoinReport,
  type RoadPlacementJoin,
  type RoadPlacement,
  type RoadSide,
  type RoadSurface,
} from "./road-joins.ts";
export { RoadFit } from "./road-fit.ts";
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
  NO_TRACK_CHANGE,
  type AppliedChange,
  type AppliedConsistChange,
  type AppliedEdit,
  type ConsistRef,
  type EditKind,
  type EditSummary,
  type EventChange,
  type HistoryStep,
  type PlanChange,
  type PlacementFollower,
  type PlacementPose,
  type PlacementRef,
  type PlacementRequest,
  type PoseChange,
  type TrackChange,
  type TrackPieceAt,
} from "./edit-history.ts";
export {
  attachedEnds,
  followPlacements,
  modelEnd,
  namesPlacement,
  noteAt,
  rulerEndPoint,
  rulerSpan,
  withNote,
  withReplacedNote,
  withoutNote,
  type NoteBody,
  type NoteChange,
  type NoteEntry,
  type NotePoint,
  type NoteSpan,
  type NoteState,
  type PlacementMove,
} from "./notes/note-state.ts";
export { SavedNoteShards, type NoteShardChange } from "./notes/saved-note-shards.ts";
export {
  ConsistHandle,
  ConsistLayout,
  consistPoseProblem,
  sameCarrier,
  type CarriedPieceRef,
  type CarrierPose,
  type ConsistAnchor,
  type ConsistPose,
  type LaidPieceRef,
  type TrackPieceRef,
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
  LEVEL_TRACK,
  trackLift,
  trackPoint,
  type BuiltSimTrack,
  type SimRoute,
  type SimTrack,
  type SimTrackInput,
  type TrackLift,
} from "./rail/sim-track.ts";
export { placementLift, rampShear, type RampShear } from "./track/ramp-lift.ts";
export { simTrackFromGraph, type TrackGraphTopology } from "./rail/graph-track.ts";
export {
  GEOMETRY_FIELDS,
  PIVOT_POINT_FLOATS,
  RunningGearPoser,
  VEHICLE_LIFT_START,
  VEHICLE_POSE_FLOATS,
  packGeometry,
  packSpecOnlyGeometry,
  rigidLift,
  rigidPitch,
  writeRigidFrame,
  type CouplerGeometry,
  type CouplerMount,
  type GuideGeometry,
  type PathSampler,
  type VehicleGeometry,
} from "./rail/running-gear.ts";
export { pierCourses, type PierCourses } from "./track/pier-courses.ts";
export { rampRises, reachablePlates, runHeights, type RunHeights } from "./track/ramp-heights.ts";
export {
  INT8_MAX,
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
export { TrackPaths } from "./track/track-paths.ts";
export { trackInsertions, type TrackInsertion } from "./track/track-insertion.ts";
export {
  arranged,
  pieceArrangement,
  type ArrangedPiece,
  type TrackArrangement,
} from "./track/track-arrangement.ts";
export {
  ovalBlueprint,
  passingSidingBlueprint,
  reversingLoopBlueprint,
  turnoutOf,
  type Turnout,
} from "./track/track-blueprints.ts";
export {
  NO_REVERSING_SECTIONS,
  ReversingSectionFinder,
  ReversingSections,
  type ReversingTopology,
} from "./track/reversing-sections.ts";
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
  floorRects,
  isMarker,
  mmRectFromWorld,
  mmRectInWorld,
  rectContains,
  rectsOverlap,
  regionAround,
  regionAroundEach,
  regionOriginX,
  regionOriginZ,
  roomRect,
  studsInside,
  type LduRect,
  type MmRect,
  type PlanAisle,
  type PlanArea,
  type PlanFootprint,
  type PlanObstacle,
  type PlanRegion,
  type PlanState,
  type PlanTable,
  type PlanVenue,
  type StudRect,
  type TableType,
  type VenueItems,
  type VenueList,
} from "./plan/plan-region.ts";
export {
  lowestFreeTableNumber,
  placedTableCounts,
  retypedRegion,
  tableName,
  tableTypeRect,
  tableTypeSize,
  turnedTable,
  withTypeKept,
  type TableTurn,
} from "./plan/table-library.ts";
export {
  BOX_MAX_X,
  BOX_MAX_Y,
  BOX_MAX_Z,
  BOX_MIN_X,
  BOX_MIN_Y,
  BOX_MIN_Z,
  BOX_STRIDE,
  bomMappingIssues,
  checkPlan,
  CoverageScratch,
  coverageContext,
  placementInRegion,
  placementInside,
  placementIssueCount,
  placementIssues,
  placementKeyText,
  regionContext,
  regionOf,
  uncheckedPlan,
  uncoveredPieces,
  UNDECIDED,
  type CoverageContext,
  type IssueSeverity,
  type PlacementKey,
  type PlanCheck,
  type PlanIssue,
  type PlanPlacement,
  type CarriedTrack,
  type PlateClearance,
  type PlanRegionContext,
  type PlanRuleId,
  type TableTop,
} from "./plan/plan-rules.ts";
export {
  BOX_PLAN_UNREADABLE,
  BOX_READ,
  BOX_Y_UNREADABLE,
  LABEL_AT,
  LABEL_NUMBERED,
  MODEL_SEGMENT,
  NO_ROW,
  PlanRows,
  RowList,
  TRACK_SEGMENT,
} from "./plan/plan-rows.ts";
export { PlanDelta, WRITE_ADD, WRITE_UPDATE } from "./plan/plan-delta.ts";
export { PlanEvaluation, type PlateHeights } from "./plan/plan-evaluation.ts";
export { RECT_FLOATS, type PlanShape } from "./plan/plan-shape.ts";
export {
  FACT_CUSTOM_PARTS,
  FACT_FLAGS,
  FACT_OVERLAP_SEGMENT,
  FACT_OVERLAP_SOURCE,
  FACT_ROAD_JOINED,
  FACT_ROAD_MISMATCHED,
  FACT_STRIDE,
  FACT_UNMAPPED_BRICKLINK,
  FACT_UNMAPPED_REBRICKABLE,
  FLAG_UNMEASURED,
  NO_OVERLAP_PARTNER,
  clearFacts,
  emptyFacts,
  type PlacementFacts,
} from "./plan/plan-facts.ts";
export { disksCover } from "./plan/plan-reach.ts";
export {
  TRACK_OPEN_END,
  TRACK_UNIDENTIFIED,
  TRACK_LAID_UNVERIFIED,
  TRACK_REVERSING,
  TRACK_UNJOINED_ENDS,
  TRACK_UNVERIFIED,
  TrackIssueRows,
} from "./plan/track-issue-rows.ts";
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
  continuingExit,
  continuingMove,
  freePlacement,
  layMoves,
  seatsOnStuds,
  trackMove,
  type PlacedPiece,
  type TrackMove,
  type TrackPieceDef,
} from "./track/track-pose.ts";
export { runMoves, type TrackRun, type TrackSegment } from "./track/track-solver.ts";
export {
  CLOSURE_BUDGET,
  solveClosure,
  UNLIMITED_BUDGET,
  type ClosureResult,
  type SearchBudget,
} from "./track/closure.ts";
export type { ClosureSite, SupportSite } from "./track/clear-closure.ts";
export { KitOutlines, type MoveFrame } from "./track/kit-outlines.ts";
export { StrokePath } from "./track/stroke-path.ts";
export {
  StrokeRouter,
  type FollowedRun,
  type StrokeGoal,
  type StrokeJoin,
  type StrokeSite,
  type StudlessScan,
} from "./track/stroke-router.ts";
export {
  NO_OBSTACLE,
  OUTLINE_BOX_FLOATS,
  RUN_CROSSING,
  TrackClearance,
  footprintOutline,
  boxesOverlap,
  outlineBox,
  outlineContains,
  outlinesOverlap,
  placedOutline,
  placedOutlineInto,
  rotateOutline,
  studlessTopBlocker,
  studlessTopOf,
  type PlacementFrame,
  type TrackOutlineSource,
} from "./track/track-clearance.ts";
export {
  FOOTPRINT_FLOATS,
  HEADING_FOOTPRINT_FLOATS,
  convexHull,
  headingFootprints,
  planHull,
  verticalRange,
} from "./track/heading-footprints.ts";
export { cellChunkKey } from "./cell-chunk-key.ts";
export {
  DirtyShards,
  addShards,
  shardPoses,
  worldPlacements,
  type PlacementTarget,
  type ShardChange,
} from "./world-shards.ts";
export {
  BomCounter,
  byPartThenColor,
  PartTally,
  type BomLine,
  type PartSink,
} from "./bom/bom-counter.ts";
export {
  countPlacements,
  regionHolds,
  type PlacementContents,
  type PlacementRegion,
} from "./bom/count-placements.ts";
export {
  INHERITED_COLOR,
  catalogOf,
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
  ownVsBuy,
  readOwnedPartsCsv,
  type OwnBuyLine,
  type OwnedPart,
  type OwnedParts,
  type OwnedPartsRead,
  type OwnVsBuy,
  type RejectedRow,
  type UnknownOwnedPart,
} from "./bom/owned-parts.ts";
export {
  AXIS_FREE,
  AXIS_NEG_X,
  AXIS_NEG_Y,
  AXIS_NEG_Z,
  AXIS_POS_X,
  AXIS_POS_Y,
  AXIS_POS_Z,
  ConnectorTable,
  connectorOriginLdu,
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
export type { ConnectorColumns } from "./connect/connector-columns.ts";
export {
  CAP_FAR,
  CAP_ROOT,
  SECTION_AXLE,
  SECTION_ROUND,
  SECTION_SQUARE,
  SECTION_FLARE_JOINS_NEXT,
  SECTION_FLARE_JOINS_PREVIOUS,
  SECTION_MALE_FINGER,
  SECTION_FEMALE_FINGER,
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
  NO_SHAPE,
} from "./connect/mate-report.ts";
export type { MateFinder } from "./connect/mate-finder.ts";
export { NO_PROPOSAL_SLOT, ProposalProgress } from "./connect/proposal-progress.ts";
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
  CELL_BOX_INTS,
  HEIGHT_BOX_INTS,
  NO_OVERLAP,
  NO_PART_INSTANCE,
  firstOverlap,
  firstOverlapFrom,
  type CellParts,
  type CellVolumes,
  type OverlapHit,
  type OwnerFilter,
  type PairExcuse,
  type VolumeHit,
} from "./volume-index.ts";
export {
  SOLID_BOX_FLOATS,
  SOLID_MATRIX_FLOATS,
  SOLID_TRIANGLE_FLOATS,
  boxesCross,
  composeAffine,
  invertAffine,
  posedBoxBounds,
  solidsCross,
  type PartSolid,
  type StudSolid,
} from "./solid-contact.ts";
export {
  PlacedOutline,
  type AxisEdge,
  type OutlinePoint,
  type OutlineRing,
} from "./plan/placed-outline.ts";
export { OutlineEdges, TrackOutline } from "./plan/track-outline.ts";
export {
  LevelCrossings,
  RoadSurfaceCells,
  levelCrossings,
  type CrossingTrack,
  type LevelCrossing,
  type RampCandidate,
  type RampPart,
} from "./level-crossings.ts";

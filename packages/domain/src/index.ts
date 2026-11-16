export { SLOT_LIVE, World, type ChunkView, type PlacementHandle } from "./world.ts";
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
  DEFAULT_CLOSURE_TURNS,
  runMoves,
  solveClosure,
  solveDrag,
  type DragPlan,
  type TrackRun,
  type TrackSegment,
} from "./track/track-solver.ts";
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
  type IssueSeverity,
  type PlacementKey,
  type PlanCheck,
  type PlanIssue,
  type PlanPlacement,
  type PlanRuleId,
  type TableTop,
} from "./plan/plan-rules.ts";
export {
  modelSpec,
  plateSpec,
  roadwaysOf,
  type PartCount,
  type EdgeFeature,
  type InstanceBoxes,
  type ItemSpec,
  type MilsRecipe,
  type ModuleProfile,
  type ModuleProfileId,
  type ModuleStandards,
} from "./plan/item-spec.ts";
export {
  checkBuildable,
  DEFAULT_MAX_REACH_MM,
  placementId,
  type BuildableCatalog,
  type BuildablePlacement,
  type CatalogIds,
  type BuildableReport,
  type BuildableSettings,
  type BuildableVerdict,
  type PlacementBom,
  type PlanBom,
  type PlanBomEntry,
} from "./plan/buildable.ts";
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
export { brickLinkWantedListXml, plainBomCsv, rebrickableCsv } from "./bom/export-formats.ts";
export {
  trackFootprints,
  type TrackFootprint,
  type TrackInput,
  type TrackPieceInfo,
  type TrackPoseStatus,
} from "./plan/track-checks.ts";

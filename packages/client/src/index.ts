export type {
  BackendInfo,
  BufferMemory,
  FrameStats,
  GraphicsApi,
  LookFeature,
  LookSettings,
  RebaseEvent,
  SceneBackendConfig,
} from "@brr/render";
export { DEFAULT_LOOK_FEATURES, LOOK_FEATURES } from "@brr/render";
export { mainThreadModules, type MainThreadConfig } from "./client.module.ts";
export type {
  IViewerScene,
  ModelCredit,
  SceneSummary,
  TrackSummary,
} from "./scene/viewer-scene.ts";
export type { ITrackScene } from "./scene/track-scene.ts";
export type { CityCamera, CityRequest, ICityScene } from "./scene/city-scene.ts";
export type { PlacementDump } from "./scene/placements.ts";
export type { IModelScene, ModelView } from "./scene/model-scene.ts";
export type { ICredits } from "./credits/credits-service.ts";
export {
  licenseText,
  setTitle,
  sourceText,
  type AuthorCredit,
  type BundleBuild,
  type CreditCounts,
  type CreditedFile,
  type CreditsView,
  type DataSourceCredit,
  type GeneratedModelCredit,
  type LicenseGroup,
  type SetCredit,
} from "./credits/credits-view.ts";
export type {
  CatalogColorView,
  CatalogItemView,
  CatalogPartView,
  EditAction,
  EditorCredits,
  EditorDump,
  EditorMode,
  EditorOptions,
  EditorSnapshot,
  EditorStats,
  EditorStatus,
  HistoryView,
  IEditor,
  LatencySample,
  RoadIssueView,
  RoadJoinView,
  RoadPlacementDump,
  RefusedClick,
  RoadSnapState,
  RoadSnapView,
  SelectionView,
  SkippedCatalogModel,
  TrackBomLine,
  TrackCommitResult,
  TrackSolveStats,
  TrackView,
} from "./edit/editor.ts";
export type { IModelImporter, ImportWorkerFactory } from "./import/worker-model-importer.ts";
export type { IImportScene, ImportedModule, ModulePlacement } from "./scene/import-scene.ts";
export type { ImportReport, ImportResult, PartResolution, PartResolutionKind } from "@brr/import";
export type {
  IRunScene,
  RunRequest,
  RunStatus,
  RunVehicleStatus,
  TrainRequest,
} from "./scene/run-scene.ts";
export type { ConsistEntry } from "./sim/consist.ts";
export type {
  GearBox,
  GearCoupler,
  GearModelView,
  GearSnapshot,
  GearView,
  IRunningGear,
  RunningGearSource,
} from "./running-gear/running-gear-editor.ts";
export { exactLduText } from "./running-gear/running-gear-editor.ts";
export type { ISimClient, SimTickCost } from "./sim/sim-client.ts";
export type { RpcPort } from "@brr/rpc";
export type { SimBenchResult } from "@brr/sim";
export { MM_PER_STUD } from "@brr/math";
export {
  DEFAULT_MAX_OVERHANG_MM,
  PLAN_GRID_MM,
  type IPlanService,
  type NewPlan,
  type ObstacleInput,
  type PlacedForPlan,
  type PlanPatch,
  type PlanSnapshot,
  type TableInput,
} from "./plan/plan-service.ts";
export type {
  IssueSeverity,
  LduRect,
  MmRect,
  PlacementKey,
  PlanCheck,
  PlanIssue,
  PlanObstacle,
  PlanPlacement,
  PlanRegion,
  PlanRuleId,
  PlanTable,
  TableTop,
} from "@brr/domain";
export {
  RUNNING_GEAR,
  CITY_SCENE,
  CREDITS,
  EDITOR,
  IMPORT_SCENE,
  MODEL_IMPORTER,
  MODEL_SCENE,
  PART_DISPLAY_SCENE,
  RUN_SCENE,
  SIM_CLIENT,
  TRACK_SCENE,
  PLAN_SERVICE,
} from "./tokens.ts";
export { TRACK_ITEM_ID } from "./edit/editor.ts";
export type { ClosureState, TrackDragView } from "./edit/track-drawing.ts";

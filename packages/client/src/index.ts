export type { BundleLod, ModelSection } from "@brr/catalog";
export type {
  BackendInfo,
  BufferMemory,
  FrameStats,
  GraphicsApi,
  RebaseEvent,
  SceneBackendConfig,
} from "@brr/render";
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
export type { IModelScene } from "./scene/model-scene.ts";
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
  CatalogItemView,
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
} from "./edit/editor.ts";
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
export type {
  BogieOverride,
  CouplerOverride,
  RunningGearOverride,
  VehicleOverride,
} from "./running-gear/override.ts";
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
  MODEL_SCENE,
  PART_DISPLAY_SCENE,
  RUN_SCENE,
  SIM_CLIENT,
  TRACK_SCENE,
  PLAN_SERVICE,
} from "./tokens.ts";

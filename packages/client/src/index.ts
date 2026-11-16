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
} from "./edit/editor.ts";
export type { IRunScene, RunRequest, RunStatus, TrainRequest } from "./scene/run-scene.ts";
export type { ISimClient, SimTickCost } from "./sim/sim-client.ts";
export type { RpcPort } from "@brr/rpc";
export type { SimBenchResult } from "@brr/sim";
export {
  CITY_SCENE,
  CREDITS,
  EDITOR,
  MODEL_SCENE,
  PART_DISPLAY_SCENE,
  RUN_SCENE,
  SIM_CLIENT,
  TRACK_SCENE,
} from "./tokens.ts";

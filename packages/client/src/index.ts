export { clientModule, mainThreadModules, type MainThreadConfig } from "./client.module.ts";
export type {
  CameraPath,
  CitySceneOptions,
  CitySceneSummary,
  ICitySceneService,
  PartUsage,
} from "./scene/city-scene-service.ts";
export { CITY_SCENE } from "./tokens.ts";
export type {
  BackendInfo,
  FrameStats,
  GraphicsApi,
  InstancingStrategy,
  SceneBackendConfig,
} from "@brr/render";
export type { BundleLod } from "@brr/catalog";

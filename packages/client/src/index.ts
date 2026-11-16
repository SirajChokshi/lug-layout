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
export type { IViewerScene, ModelCredit, SceneSummary } from "./scene/viewer-scene.ts";
export type { CityCamera, CityRequest, ICityScene, PlacementDump } from "./scene/city-scene.ts";
export type { IModelScene } from "./scene/model-scene.ts";
export type { IModelImporter, ImportWorkerFactory } from "./import/worker-model-importer.ts";
export type { IImportScene, ImportedModule, ModulePlacement } from "./scene/import-scene.ts";
export type { ImportReport, ImportResult, PartResolution, PartResolutionKind } from "@brr/import";
export {
  BOM_SERVICE,
  CITY_SCENE,
  IMPORT_SCENE,
  MODEL_IMPORTER,
  MODEL_SCENE,
  PART_DISPLAY_SCENE,
} from "./tokens.ts";
export type {
  BillOfMaterials,
  BomFiles,
  BomInput,
  BomScope,
  IBomService,
  IBomSource,
} from "./bom/bom-service.ts";
export type { CatalogBom, CatalogLine, PlacementRegion, UnmappedLine } from "@brr/domain";

import { BUNDLE_BASE_URL, catalogModule } from "@brr/catalog";
import { renderModule } from "@brr/render";
import { ContainerModule } from "inversify";
import { WorkerModelImporter, type ImportWorkerFactory } from "./import/worker-model-importer.ts";
import { CityScene } from "./scene/city-scene.ts";
import { ImportScene } from "./scene/import-scene.ts";
import { ModelScene } from "./scene/model-scene.ts";
import { PartDisplayScene } from "./scene/part-display-scene.ts";
import {
  CITY_SCENE,
  IMPORT_SCENE,
  IMPORT_WORKER_FACTORY,
  MODEL_IMPORTER,
  MODEL_SCENE,
  PART_DISPLAY_SCENE,
} from "./tokens.ts";

const clientModule = new ContainerModule(({ bind }) => {
  bind(PART_DISPLAY_SCENE).to(PartDisplayScene).inSingletonScope();
  bind(MODEL_SCENE).to(ModelScene).inSingletonScope();
  bind(CITY_SCENE).to(CityScene).inSingletonScope();
  bind(MODEL_IMPORTER).to(WorkerModelImporter).inSingletonScope();
  bind(IMPORT_SCENE).to(ImportScene).inSingletonScope();
});

export interface MainThreadConfig {
  readonly bundleBaseUrl: string;
  readonly createImportWorker: ImportWorkerFactory;
}

export function mainThreadModules(config: MainThreadConfig): ContainerModule[] {
  const configModule = new ContainerModule(({ bind }) => {
    bind(BUNDLE_BASE_URL).toConstantValue(config.bundleBaseUrl);
    bind(IMPORT_WORKER_FACTORY).toConstantValue(config.createImportWorker);
  });
  return [configModule, catalogModule, renderModule, clientModule];
}

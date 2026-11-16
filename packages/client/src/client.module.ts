import { BUNDLE_BASE_URL, catalogModule } from "@brr/catalog";
import { renderModule } from "@brr/render";
import { ContainerModule } from "inversify";
import { WorkerModelImporter, type ImportWorkerFactory } from "./import/worker-model-importer.ts";
import { BomService } from "./bom/bom-service.ts";
import { CreditsService } from "./credits/credits-service.ts";
import { Editor } from "./edit/editor.ts";
import { BuildableService } from "./plan/buildable-service.ts";
import { PlanService } from "./plan/plan-service.ts";
import { CityScene } from "./scene/city-scene.ts";
import { ImportScene } from "./scene/import-scene.ts";
import { ModelScene } from "./scene/model-scene.ts";
import { PartDisplayScene } from "./scene/part-display-scene.ts";
import {
  BOM_SERVICE,
  BUILDABLE_SERVICE,
  CITY_SCENE,
  CREDITS,
  EDITOR,
  MODEL_SCENE,
  PART_DISPLAY_SCENE,
  PLAN_SERVICE,
  IMPORT_SCENE,
  IMPORT_WORKER_FACTORY,
  MODEL_IMPORTER,
} from "./tokens.ts";

const clientModule = new ContainerModule(({ bind }) => {
  bind(PART_DISPLAY_SCENE).to(PartDisplayScene).inSingletonScope();
  bind(MODEL_SCENE).to(ModelScene).inSingletonScope();
  bind(CITY_SCENE).to(CityScene).inSingletonScope();
  bind(EDITOR).to(Editor).inSingletonScope();
  bind(CREDITS).to(CreditsService).inSingletonScope();
  bind(PLAN_SERVICE).to(PlanService).inSingletonScope();
  bind(BUILDABLE_SERVICE).to(BuildableService).inSingletonScope();
  bind(MODEL_IMPORTER).to(WorkerModelImporter).inSingletonScope();
  bind(IMPORT_SCENE).to(ImportScene).inSingletonScope();
  bind(BOM_SERVICE).to(BomService).inSingletonScope();
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

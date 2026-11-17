import { BUNDLE_BASE_URL, catalogModule } from "@brr/catalog";
import { renderModule } from "@brr/render";
import type { RpcPort } from "@brr/rpc";
import { ContainerModule } from "inversify";
import { CreditsService } from "./credits/credits-service.ts";
import { Editor } from "./edit/editor.ts";
import { PlanService } from "./plan/plan-service.ts";
import { WorkerModelImporter, type ImportWorkerFactory } from "./import/worker-model-importer.ts";
import { BomService } from "./bom/bom-service.ts";
import { CityScene } from "./scene/city-scene.ts";
import { ImportScene } from "./scene/import-scene.ts";
import { ModelScene } from "./scene/model-scene.ts";
import { PartDisplayScene } from "./scene/part-display-scene.ts";
import { RunScene } from "./scene/run-scene.ts";
import { TrackScene } from "./scene/track-scene.ts";
import { SimWorkerProxy } from "./sim/sim-client.ts";
import {
  BOM_SERVICE,
  CITY_SCENE,
  CREDITS,
  EDITOR,
  IMPORT_SCENE,
  IMPORT_WORKER_FACTORY,
  MODEL_IMPORTER,
  MODEL_SCENE,
  PART_DISPLAY_SCENE,
  PLAN_SERVICE,
  RUN_SCENE,
  SIM_CLIENT,
  SIM_WORKER_PORT,
  TRACK_SCENE,
} from "./tokens.ts";

const clientModule = new ContainerModule(({ bind }) => {
  bind(PART_DISPLAY_SCENE).to(PartDisplayScene).inSingletonScope();
  bind(MODEL_SCENE).to(ModelScene).inSingletonScope();
  bind(CITY_SCENE).to(CityScene).inSingletonScope();
  bind(EDITOR).to(Editor).inSingletonScope();
  bind(MODEL_IMPORTER).to(WorkerModelImporter).inSingletonScope();
  bind(IMPORT_SCENE).to(ImportScene).inSingletonScope();
  bind(CREDITS).to(CreditsService).inSingletonScope();
  bind(TRACK_SCENE).to(TrackScene).inSingletonScope();
  bind(RUN_SCENE).to(RunScene).inSingletonScope();
  bind(SIM_CLIENT).to(SimWorkerProxy).inSingletonScope();
  bind(PLAN_SERVICE).to(PlanService).inSingletonScope();
  bind(BOM_SERVICE).to(BomService).inSingletonScope();
});

export interface MainThreadConfig {
  readonly bundleBaseUrl: string;
  readonly startSimWorker?: () => RpcPort;
  readonly createImportWorker?: ImportWorkerFactory;
}

export function mainThreadModules(config: MainThreadConfig): ContainerModule[] {
  const configModule = new ContainerModule(({ bind }) => {
    bind(BUNDLE_BASE_URL).toConstantValue(config.bundleBaseUrl);
    bind(SIM_WORKER_PORT)
      .toDynamicValue(() => {
        if (!config.startSimWorker) throw new Error("this composition root starts no sim worker");
        return config.startSimWorker();
      })
      .inSingletonScope();
    bind(IMPORT_WORKER_FACTORY).toConstantValue(() => {
      if (!config.createImportWorker)
        throw new Error("this composition root starts no import worker");
      return config.createImportWorker();
    });
  });
  return [configModule, catalogModule, renderModule, clientModule];
}

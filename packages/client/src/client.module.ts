import {
  BUNDLE_BASE_URL,
  BUNDLE_MANIFEST_FILE,
  catalogModule,
  DEFAULT_BUNDLE_MANIFEST_FILE,
} from "@brr/catalog";
import { renderModule } from "@brr/render";
import type { RpcPort } from "@brr/rpc";
import { storageModule } from "@brr/storage";
import { ContainerModule } from "inversify";
import { EditorCamera } from "./camera/editor-camera.ts";
import { CreditsService } from "./credits/credits-service.ts";
import { Editor } from "./edit/editor.ts";
import { WorkerModelImporter, type ImportWorkerFactory } from "./import/worker-model-importer.ts";
import { PlanService } from "./plan/plan-service.ts";
import { BomService } from "./bom/bom-service.ts";
import { CityScene } from "./scene/city-scene.ts";
import { ImportScene } from "./scene/import-scene.ts";
import { LayoutScene } from "./scene/layout-scene.ts";
import { ModelScene } from "./scene/model-scene.ts";
import { PartDisplayScene } from "./scene/part-display-scene.ts";
import { IndexedDbRunningGearOverrideStore } from "./running-gear/override-store.ts";
import { RunningGearEditor } from "./running-gear/running-gear-editor.ts";
import { RunScene } from "./scene/run-scene.ts";
import { TrackScene } from "./scene/track-scene.ts";
import { SimWorkerProxy } from "./sim/sim-client.ts";
import {
  BOM_SERVICE,
  CITY_SCENE,
  CREDITS,
  EDITOR,
  EDITOR_CAMERA,
  IMPORT_SCENE,
  IMPORT_WORKER_FACTORY,
  LAYOUT_SCENE,
  LDRAW_LIBRARY_BASE_URL,
  MODEL_IMPORTER,
  MODEL_SCENE,
  PART_DISPLAY_SCENE,
  RUN_SCENE,
  RUNNING_GEAR,
  RUNNING_GEAR_OVERRIDES,
  SIM_CLIENT,
  SIM_WORKER_PORT,
  TRACK_SCENE,
  PLAN_SERVICE,
  TRADEMARK_DISCLAIMER,
} from "./tokens.ts";

const clientModule = new ContainerModule(({ bind }) => {
  bind(PART_DISPLAY_SCENE).to(PartDisplayScene).inSingletonScope();
  bind(MODEL_SCENE).to(ModelScene).inSingletonScope();
  bind(CITY_SCENE).to(CityScene).inSingletonScope();
  bind(LAYOUT_SCENE).to(LayoutScene).inSingletonScope();
  bind(EDITOR).to(Editor).inSingletonScope();
  bind(EDITOR_CAMERA).to(EditorCamera).inSingletonScope();
  bind(MODEL_IMPORTER).to(WorkerModelImporter).inSingletonScope();
  bind(IMPORT_SCENE).to(ImportScene).inSingletonScope();
  bind(CREDITS).to(CreditsService).inSingletonScope();
  bind(TRACK_SCENE).to(TrackScene).inSingletonScope();
  bind(RUN_SCENE).to(RunScene).inSingletonScope();
  bind(SIM_CLIENT).to(SimWorkerProxy).inSingletonScope();
  bind(PLAN_SERVICE).to(PlanService).inSingletonScope();
  bind(RUNNING_GEAR_OVERRIDES).to(IndexedDbRunningGearOverrideStore).inSingletonScope();
  bind(RUNNING_GEAR).to(RunningGearEditor).inSingletonScope();
  bind(BOM_SERVICE).to(BomService).inSingletonScope();
});

export interface MainThreadConfig {
  readonly bundleBaseUrl: string;
  readonly createImportWorker?: ImportWorkerFactory;
  readonly bundleManifestFile?: string;
  readonly ldrawLibraryBaseUrl?: string;
  readonly startSimWorker?: () => RpcPort;
  readonly disclaimer: string;
}

export function mainThreadModules(config: MainThreadConfig): ContainerModule[] {
  const configModule = new ContainerModule(({ bind }) => {
    bind(BUNDLE_BASE_URL).toConstantValue(config.bundleBaseUrl);
    bind(IMPORT_WORKER_FACTORY).toConstantValue(() => {
      if (!config.createImportWorker) {
        throw new Error("this composition root starts no import worker");
      }
      return config.createImportWorker();
    });
    bind(BUNDLE_MANIFEST_FILE).toConstantValue(
      config.bundleManifestFile ?? DEFAULT_BUNDLE_MANIFEST_FILE,
    );
    bind(LDRAW_LIBRARY_BASE_URL).toConstantValue(config.ldrawLibraryBaseUrl ?? null);
    bind(SIM_WORKER_PORT)
      .toDynamicValue(() => {
        if (!config.startSimWorker) throw new Error("this composition root starts no sim worker");
        return config.startSimWorker();
      })
      .inSingletonScope();
    bind(TRADEMARK_DISCLAIMER).toConstantValue(config.disclaimer);
  });
  return [configModule, catalogModule, renderModule, storageModule, clientModule];
}

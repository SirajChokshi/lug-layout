import type { RpcPort } from "@brr/rpc";
import type { ServiceIdentifier } from "inversify";
import type { ICredits } from "./credits/credits-service.ts";
import type { IEditor } from "./edit/editor.ts";
import type { IModelImporter, ImportWorkerFactory } from "./import/worker-model-importer.ts";
import type { IPlanService } from "./plan/plan-service.ts";
import type { IBomService } from "./bom/bom-service.ts";
import type { ICityScene } from "./scene/city-scene.ts";
import type { IRunningGearOverrideStore } from "./running-gear/override-store.ts";
import type { IRunningGear } from "./running-gear/running-gear-editor.ts";
import type { IImportScene } from "./scene/import-scene.ts";
import type { IModelScene } from "./scene/model-scene.ts";
import type { IRunScene } from "./scene/run-scene.ts";
import type { ITrackScene } from "./scene/track-scene.ts";
import type { IViewerScene } from "./scene/viewer-scene.ts";
import type { ISimClient } from "./sim/sim-client.ts";

export const PART_DISPLAY_SCENE: ServiceIdentifier<IViewerScene> = Symbol.for(
  "brr.client.PartDisplayScene",
);
export const MODEL_SCENE: ServiceIdentifier<IModelScene> = Symbol.for("brr.client.ModelScene");
export const TRACK_SCENE: ServiceIdentifier<ITrackScene> = Symbol.for("brr.client.TrackScene");
export const CITY_SCENE: ServiceIdentifier<ICityScene> = Symbol.for("brr.client.CityScene");
export const EDITOR: ServiceIdentifier<IEditor> = Symbol.for("brr.client.Editor");
export const CREDITS: ServiceIdentifier<ICredits> = Symbol.for("brr.client.Credits");
export const IMPORT_WORKER_FACTORY: ServiceIdentifier<ImportWorkerFactory> = Symbol.for(
  "brr.client.ImportWorkerFactory",
);
export const MODEL_IMPORTER: ServiceIdentifier<IModelImporter> = Symbol.for(
  "brr.client.ModelImporter",
);
export const IMPORT_SCENE: ServiceIdentifier<IImportScene> = Symbol.for("brr.client.ImportScene");
export const RUN_SCENE: ServiceIdentifier<IRunScene> = Symbol.for("brr.client.RunScene");
export const SIM_CLIENT: ServiceIdentifier<ISimClient> = Symbol.for("brr.client.SimClient");
export const SIM_WORKER_PORT: ServiceIdentifier<RpcPort> = Symbol.for("brr.client.SimWorkerPort");
export const PLAN_SERVICE: ServiceIdentifier<IPlanService> = Symbol.for("brr.client.PlanService");
export const RUNNING_GEAR_OVERRIDES: ServiceIdentifier<IRunningGearOverrideStore> = Symbol.for(
  "brr.client.RunningGearOverrides",
);
export const RUNNING_GEAR: ServiceIdentifier<IRunningGear> = Symbol.for("brr.client.RunningGear");
export const BOM_SERVICE: ServiceIdentifier<IBomService> = Symbol.for("brr.client.BomService");

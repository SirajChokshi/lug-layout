import type { ServiceIdentifier } from "inversify";
import type { ICredits } from "./credits/credits-service.ts";
import type { IEditor } from "./edit/editor.ts";
import type { IModelImporter, ImportWorkerFactory } from "./import/worker-model-importer.ts";
import type { ICityScene } from "./scene/city-scene.ts";
import type { IImportScene } from "./scene/import-scene.ts";
import type { IModelScene } from "./scene/model-scene.ts";
import type { IViewerScene } from "./scene/viewer-scene.ts";

export const PART_DISPLAY_SCENE: ServiceIdentifier<IViewerScene> = Symbol.for(
  "brr.client.PartDisplayScene",
);
export const MODEL_SCENE: ServiceIdentifier<IModelScene> = Symbol.for("brr.client.ModelScene");
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

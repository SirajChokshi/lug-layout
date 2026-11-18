import type { RpcPort } from "@brr/rpc";
import type { ServiceIdentifier } from "inversify";
import type { IEditorCamera } from "./camera/editor-camera.ts";
import type { ICatalogSearch } from "./catalog/catalog-search.ts";
import type { IPaletteDrag } from "./catalog/palette-drag.ts";
import type { IPaletteMemory, IPaletteMemoryStore } from "./catalog/palette-memory.ts";
import type { IPalettePrefetch } from "./catalog/palette-prefetch.ts";
import type { IPaletteSearch } from "./catalog/palette-search.ts";
import type { IPaletteThumbnails } from "./catalog/palette-thumbnails.ts";
import type { ICredits } from "./credits/credits-service.ts";
import type { IEditor } from "./edit/editor.ts";
import type { IWorldSession } from "./edit/world-session.ts";
import type { IImportWorkerPool, ImportWorkerFactory } from "./import/import-worker-pool.ts";
import type { IModelImporter } from "./import/worker-model-importer.ts";
import type { IPlanService } from "./plan/plan-service.ts";
import type { IBomService } from "./bom/bom-service.ts";
import type { IRunningGearOverrideStore } from "./running-gear/override-store.ts";
import type { IRunningGear } from "./running-gear/running-gear-editor.ts";
import type { IImportScene } from "./scene/import-scene.ts";
import type { IModelScene } from "./scene/model-scene.ts";
import type { ITrackScene } from "./scene/track-scene.ts";
import type { ISimClient } from "./sim/sim-client.ts";
import type { ITrainPlay } from "./play/train-play.ts";

export const MODEL_SCENE: ServiceIdentifier<IModelScene> = Symbol.for("brr.client.ModelScene");
export const TRACK_SCENE: ServiceIdentifier<ITrackScene> = Symbol.for("brr.client.TrackScene");
export const EDITOR: ServiceIdentifier<IEditor> = Symbol.for("brr.client.Editor");
export const WORLD_SESSION: ServiceIdentifier<IWorldSession> =
  Symbol.for("brr.client.WorldSession");
export const EDITOR_CAMERA: ServiceIdentifier<IEditorCamera> =
  Symbol.for("brr.client.EditorCamera");
export const CREDITS: ServiceIdentifier<ICredits> = Symbol.for("brr.client.Credits");
export const CATALOG_SEARCH: ServiceIdentifier<ICatalogSearch> = Symbol.for(
  "brr.client.CatalogSearch",
);
export const PALETTE_SEARCH: ServiceIdentifier<IPaletteSearch> = Symbol.for(
  "brr.client.PaletteSearch",
);
export const PALETTE_DRAG: ServiceIdentifier<IPaletteDrag> = Symbol.for("brr.client.PaletteDrag");
export const PALETTE_PREFETCH: ServiceIdentifier<IPalettePrefetch> = Symbol.for(
  "brr.client.PalettePrefetch",
);
export const IMPORT_WORKER_FACTORY: ServiceIdentifier<ImportWorkerFactory> = Symbol.for(
  "brr.client.ImportWorkerFactory",
);
export const LDRAW_LIBRARY_BASE_URL: ServiceIdentifier<string | null> = Symbol.for(
  "brr.client.LdrawLibraryBaseUrl",
);
export const IMPORT_BAKE_HELPERS: ServiceIdentifier<number> = Symbol.for(
  "brr.client.ImportBakeHelpers",
);
export const IMPORT_WORKER_POOL: ServiceIdentifier<IImportWorkerPool> = Symbol.for(
  "brr.client.ImportWorkerPool",
);
export const MODEL_IMPORTER: ServiceIdentifier<IModelImporter> = Symbol.for(
  "brr.client.ModelImporter",
);
export const IMPORT_SCENE: ServiceIdentifier<IImportScene> = Symbol.for("brr.client.ImportScene");
export const SIM_CLIENT: ServiceIdentifier<ISimClient> = Symbol.for("brr.client.SimClient");
export const SIM_WORKER_PORT: ServiceIdentifier<RpcPort> = Symbol.for("brr.client.SimWorkerPort");
export const PLAN_SERVICE: ServiceIdentifier<IPlanService> = Symbol.for("brr.client.PlanService");
export const RUNNING_GEAR_OVERRIDES: ServiceIdentifier<IRunningGearOverrideStore> = Symbol.for(
  "brr.client.RunningGearOverrides",
);
export const RUNNING_GEAR: ServiceIdentifier<IRunningGear> = Symbol.for("brr.client.RunningGear");
export const TRADEMARK_DISCLAIMER: ServiceIdentifier<string> = Symbol.for(
  "brr.client.TrademarkDisclaimer",
);
export const BOM_SERVICE: ServiceIdentifier<IBomService> = Symbol.for("brr.client.BomService");
export const TRAIN_PLAY: ServiceIdentifier<ITrainPlay> = Symbol.for("brr.client.TrainPlay");
export const PALETTE_MEMORY_STORE: ServiceIdentifier<IPaletteMemoryStore> = Symbol.for(
  "brr.client.PaletteMemoryStore",
);
export const PALETTE_MEMORY: ServiceIdentifier<IPaletteMemory> = Symbol.for(
  "brr.client.PaletteMemory",
);
export const PALETTE_THUMBNAILS: ServiceIdentifier<IPaletteThumbnails> = Symbol.for(
  "brr.client.PaletteThumbnails",
);

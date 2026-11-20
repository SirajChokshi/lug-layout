import type { FetchFunction, IByteCache } from "@brr/import";
import type { RpcPort } from "@brr/rpc";
import type { ServiceIdentifier } from "inversify";
import type { IBakeHelperRegistry } from "./bake-helper-registry.ts";
import type { ICompilerLoader } from "./compiler-loader.ts";
import type { ImportWorkerHost } from "./import-worker-host.ts";
import type {
  IImportWorkerService,
  LdrawMirrorFactory,
  ModelImportEngineFactory,
} from "./import-worker-service.ts";

export const IMPORT_PORT: ServiceIdentifier<RpcPort> = Symbol.for("brr.importWorker.Port");
export const IMPORT_FETCH: ServiceIdentifier<FetchFunction> = Symbol.for("brr.importWorker.Fetch");
export const IMPORT_CLOCK: ServiceIdentifier<() => number> = Symbol.for("brr.importWorker.Clock");
export const IMPORT_WORKER_SERVICE: ServiceIdentifier<IImportWorkerService> = Symbol.for(
  "brr.importWorker.ImportWorkerService",
);
export const COMPILER_LOADER: ServiceIdentifier<ICompilerLoader> = Symbol.for(
  "brr.importWorker.CompilerLoader",
);
export const LDRAW_MIRROR_FACTORY: ServiceIdentifier<LdrawMirrorFactory> = Symbol.for(
  "brr.importWorker.LdrawMirrorFactory",
);
export const MODEL_IMPORT_ENGINE_FACTORY: ServiceIdentifier<ModelImportEngineFactory> = Symbol.for(
  "brr.importWorker.ModelImportEngineFactory",
);
export const BAKE_HELPER_REGISTRY: ServiceIdentifier<IBakeHelperRegistry> = Symbol.for(
  "brr.importWorker.BakeHelperRegistry",
);
export const IMPORT_WORKER_HOST: ServiceIdentifier<ImportWorkerHost> =
  Symbol.for("brr.importWorker.Host");
export const RECORD_CACHE: ServiceIdentifier<IByteCache> = Symbol.for(
  "brr.importWorker.RecordCache",
);
export const CONNECTOR_RECORD_CACHE: ServiceIdentifier<IByteCache> = Symbol.for(
  "brr.importWorker.ConnectorRecordCache",
);

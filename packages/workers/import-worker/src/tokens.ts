import type { RpcPort } from "@brr/rpc";
import type { ServiceIdentifier } from "inversify";
import type { IBakeHelperRegistry } from "./bake-helper-registry.ts";
import type { ICompilerLoader } from "./compiler-loader.ts";
import type { ImportWorkerHost } from "./import-worker-host.ts";
import type { IImportWorkerService } from "./import-worker-service.ts";

export const IMPORT_PORT: ServiceIdentifier<RpcPort> = Symbol.for("brr.importWorker.Port");
export const IMPORT_WORKER_SERVICE: ServiceIdentifier<IImportWorkerService> = Symbol.for(
  "brr.importWorker.ImportWorkerService",
);
export const COMPILER_LOADER: ServiceIdentifier<ICompilerLoader> = Symbol.for(
  "brr.importWorker.CompilerLoader",
);
export const BAKE_HELPER_REGISTRY: ServiceIdentifier<IBakeHelperRegistry> = Symbol.for(
  "brr.importWorker.BakeHelperRegistry",
);
export const IMPORT_WORKER_HOST: ServiceIdentifier<ImportWorkerHost> =
  Symbol.for("brr.importWorker.Host");

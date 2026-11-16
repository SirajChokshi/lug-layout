import type { ServiceIdentifier } from "inversify";
import type { IImportWorkerService } from "./import-worker-service.ts";

export const IMPORT_WORKER_SERVICE: ServiceIdentifier<IImportWorkerService> = Symbol.for(
  "brr.importWorker.ImportWorkerService",
);

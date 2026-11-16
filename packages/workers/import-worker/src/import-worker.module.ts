import { ContainerModule } from "inversify";
import { ImportWorkerService } from "./import-worker-service.ts";
import { IMPORT_WORKER_SERVICE } from "./tokens.ts";

export const importWorkerModule = new ContainerModule(({ bind }) => {
  bind(IMPORT_WORKER_SERVICE).to(ImportWorkerService).inSingletonScope();
});

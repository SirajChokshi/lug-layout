import type { RpcPort } from "@brr/rpc";
import { ContainerModule } from "inversify";
import { BakeHelperRegistry } from "./bake-helper-registry.ts";
import { CompilerLoader } from "./compiler-loader.ts";
import { ImportWorkerHost } from "./import-worker-host.ts";
import { ImportWorkerService } from "./import-worker-service.ts";
import {
  BAKE_HELPER_REGISTRY,
  COMPILER_LOADER,
  IMPORT_PORT,
  IMPORT_WORKER_HOST,
  IMPORT_WORKER_SERVICE,
} from "./tokens.ts";

export function importWorkerModule(port: RpcPort): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(IMPORT_PORT).toConstantValue(port);
    bind(COMPILER_LOADER).to(CompilerLoader).inSingletonScope();
    bind(BAKE_HELPER_REGISTRY).to(BakeHelperRegistry).inSingletonScope();
    bind(IMPORT_WORKER_SERVICE).to(ImportWorkerService).inSingletonScope();
    bind(IMPORT_WORKER_HOST).to(ImportWorkerHost).inSingletonScope();
  });
}

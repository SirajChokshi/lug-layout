import { LdrawMirror, ModelImportEngine } from "@brr/import";
import type { RpcPort } from "@brr/rpc";
import { ContainerModule } from "inversify";
import { BakeHelperRegistry } from "./bake-helper-registry.ts";
import { CompilerLoader } from "./compiler-loader.ts";
import { ImportWorkerHost } from "./import-worker-host.ts";
import { ImportWorkerService } from "./import-worker-service.ts";
import {
  BAKE_HELPER_REGISTRY,
  COMPILER_LOADER,
  IMPORT_CLOCK,
  IMPORT_FETCH,
  IMPORT_PORT,
  IMPORT_WORKER_HOST,
  IMPORT_WORKER_SERVICE,
  LDRAW_MIRROR_FACTORY,
  MODEL_IMPORT_ENGINE_FACTORY,
} from "./tokens.ts";

export function importWorkerModule(port: RpcPort): ContainerModule {
  return new ContainerModule(({ bind }) => {
    bind(IMPORT_PORT).toConstantValue(port);
    bind(IMPORT_FETCH).toConstantValue((url) => fetch(url));
    bind(IMPORT_CLOCK).toConstantValue(() => performance.now());
    bind(COMPILER_LOADER).to(CompilerLoader).inSingletonScope();
    bind(LDRAW_MIRROR_FACTORY)
      .toDynamicValue((context) => {
        const fetchUrl = context.get(IMPORT_FETCH);
        return (source, baseUrl) => new LdrawMirror(source, fetchUrl, baseUrl);
      })
      .inSingletonScope();
    bind(MODEL_IMPORT_ENGINE_FACTORY)
      .toDynamicValue((context) => {
        const now = context.get(IMPORT_CLOCK);
        return (compiler, mirror, helpers) => new ModelImportEngine(compiler, mirror, now, helpers);
      })
      .inSingletonScope();
    bind(BAKE_HELPER_REGISTRY).to(BakeHelperRegistry).inSingletonScope();
    bind(IMPORT_WORKER_SERVICE).to(ImportWorkerService).inSingletonScope();
    bind(IMPORT_WORKER_HOST).to(ImportWorkerHost).inSingletonScope();
  });
}

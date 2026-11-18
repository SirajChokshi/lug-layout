import {
  importStudioFile,
  LdrawMirror,
  ModelImportEngine,
  type ImportWorkerRequest,
  type ImportResult,
} from "@brr/import";
import { inject, injectable } from "inversify";
import type { IBakeHelperRegistry } from "./bake-helper-registry.ts";
import type { ICompilerLoader } from "./compiler-loader.ts";
import { BAKE_HELPER_REGISTRY, COMPILER_LOADER } from "./tokens.ts";

export interface IImportWorkerService {
  run(request: ImportWorkerRequest): Promise<ImportResult>;
}

@injectable()
export class ImportWorkerService implements IImportWorkerService {
  constructor(
    @inject(COMPILER_LOADER) private readonly compilers: ICompilerLoader,
    @inject(BAKE_HELPER_REGISTRY) private readonly bakeHelpers: IBakeHelperRegistry,
  ) {}

  async run(request: ImportWorkerRequest): Promise<ImportResult> {
    const compiler = await this.compilers.load(request.compilerUrl);
    const helpers = this.bakeHelpers.helpers(request.compilerUrl);
    const { input } = request;
    const mirror = new LdrawMirror(input.job.source, (url) => fetch(url), request.ldrawLibraryUrl);
    switch (input.kind) {
      case "ldraw": {
        const engine = new ModelImportEngine(compiler, mirror, () => performance.now(), helpers);
        return engine.importText(input.job);
      }
      case "studio":
        return importStudioFile(compiler, mirror, () => performance.now(), helpers, input);
      default: {
        const unhandled: never = input;
        throw new Error(`unhandled import input ${JSON.stringify(unhandled)}`);
      }
    }
  }
}

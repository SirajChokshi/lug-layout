import {
  importStudioFile,
  type BrickCompiler,
  type IBakeHelper,
  type ImportResult,
  type ImportWorkerRequest,
  type LdrawMirror,
  type MirrorSource,
  type ModelImportEngine,
} from "@brr/import";
import { inject, injectable } from "inversify";
import type { IBakeHelperRegistry } from "./bake-helper-registry.ts";
import type { ICompilerLoader } from "./compiler-loader.ts";
import {
  BAKE_HELPER_REGISTRY,
  COMPILER_LOADER,
  LDRAW_MIRROR_FACTORY,
  MODEL_IMPORT_ENGINE_FACTORY,
} from "./tokens.ts";

export interface IImportWorkerService {
  run(request: ImportWorkerRequest): Promise<ImportResult>;
}

export type LdrawMirrorFactory = (source: MirrorSource, baseUrl: string | undefined) => LdrawMirror;

export type ModelImportEngineFactory = (
  compiler: BrickCompiler,
  mirror: LdrawMirror,
  helpers: ReadonlyArray<IBakeHelper>,
) => ModelImportEngine;

@injectable()
export class ImportWorkerService implements IImportWorkerService {
  constructor(
    @inject(COMPILER_LOADER) private readonly compilers: ICompilerLoader,
    @inject(BAKE_HELPER_REGISTRY) private readonly bakeHelpers: IBakeHelperRegistry,
    @inject(LDRAW_MIRROR_FACTORY) private readonly createMirror: LdrawMirrorFactory,
    @inject(MODEL_IMPORT_ENGINE_FACTORY) private readonly createEngine: ModelImportEngineFactory,
  ) {}

  async run(request: ImportWorkerRequest): Promise<ImportResult> {
    const compiler = await this.compilers.load(request.compilerUrl);
    const helpers = this.bakeHelpers.helpers(request.compilerUrl);
    const { input } = request;
    const mirror = this.createMirror(input.job.source, request.ldrawLibraryUrl);
    const engine = this.createEngine(compiler, mirror, helpers);
    switch (input.kind) {
      case "ldraw":
        return engine.importText(input.job);
      case "studio":
        return importStudioFile(engine, compiler, mirror, input);
      default: {
        const unhandled: never = input;
        throw new Error(`unhandled import input ${JSON.stringify(unhandled)}`);
      }
    }
  }
}

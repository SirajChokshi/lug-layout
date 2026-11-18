import { ConnectorRecords } from "@brr/catalog/connector-records";
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
  private readonly records = new Map<string, ConnectorRecords>();

  constructor(
    @inject(COMPILER_LOADER) private readonly compilers: ICompilerLoader,
    @inject(BAKE_HELPER_REGISTRY) private readonly bakeHelpers: IBakeHelperRegistry,
  ) {}

  private connectorRecords(request: ImportWorkerRequest): ConnectorRecords {
    const base = new URL(request.bundleBaseUrl.replace(/\/?$/u, "/"));
    const key = JSON.stringify([base.href, request.connectorIndexes, request.connectorVocabulary]);
    let records = this.records.get(key);
    if (records === undefined) {
      records = new ConnectorRecords(
        async (path) => {
          const url = new URL(path, base);
          const response = await fetch(url);
          if (!response.ok) throw new Error(`GET ${url.href} failed with ${response.status}`);
          return response.json();
        },
        request.connectorIndexes,
        request.connectorVocabulary,
      );
      this.records.set(key, records);
    }
    return records;
  }

  async run(request: ImportWorkerRequest): Promise<ImportResult> {
    const compiler = await this.compilers.load(request.compilerUrl);
    const helpers = this.bakeHelpers.helpers(request.compilerUrl);
    const connectors = this.connectorRecords(request);
    const { input } = request;
    const mirror = new LdrawMirror(input.job.source, (url) => fetch(url), request.ldrawLibraryUrl);
    switch (input.kind) {
      case "ldraw": {
        const engine = new ModelImportEngine(
          compiler,
          mirror,
          connectors,
          () => performance.now(),
          helpers,
        );
        return engine.importText(input.job);
      }
      case "studio":
        return importStudioFile(
          compiler,
          mirror,
          connectors,
          () => performance.now(),
          helpers,
          input,
        );
      default: {
        const unhandled: never = input;
        throw new Error(`unhandled import input ${JSON.stringify(unhandled)}`);
      }
    }
  }
}

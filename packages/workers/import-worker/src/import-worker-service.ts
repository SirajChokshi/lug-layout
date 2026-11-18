import { ConnectorRecords } from "@brr/catalog/connector-records";
import {
  BrickCompiler,
  importStudioFile,
  LdrawMirror,
  ModelImportEngine,
  type ImportWorkerRequest,
  type ImportResult,
} from "@brr/import";
import { injectable } from "inversify";

export interface IImportWorkerService {
  run(request: ImportWorkerRequest): Promise<ImportResult>;
}

@injectable()
export class ImportWorkerService implements IImportWorkerService {
  private readonly compilers = new Map<string, Promise<BrickCompiler>>();
  private readonly records = new Map<string, ConnectorRecords>();

  private compiler(url: string): Promise<BrickCompiler> {
    const cached = this.compilers.get(url);
    if (cached) return cached;
    const loading = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
      return new BrickCompiler(await WebAssembly.compile(await response.arrayBuffer()));
    });
    this.compilers.set(url, loading);
    loading.catch(() => {
      if (this.compilers.get(url) === loading) this.compilers.delete(url);
    });
    return loading;
  }

  private connectorRecords(request: ImportWorkerRequest): ConnectorRecords {
    const base = new URL(request.bundleBaseUrl.replace(/\/?$/u, "/"));
    const key = JSON.stringify([base.href, request.connectorIndexes]);
    let records = this.records.get(key);
    if (records === undefined) {
      records = new ConnectorRecords(async (path) => {
        const url = new URL(path, base);
        const response = await fetch(url);
        if (!response.ok) throw new Error(`GET ${url.href} failed with ${response.status}`);
        return response.json();
      }, request.connectorIndexes);
      this.records.set(key, records);
    }
    return records;
  }

  async run(request: ImportWorkerRequest): Promise<ImportResult> {
    const compiler = await this.compiler(request.compilerUrl);
    const connectors = this.connectorRecords(request);
    const { input } = request;
    switch (input.kind) {
      case "ldraw": {
        const mirror = new LdrawMirror(
          input.job.source,
          (url) => fetch(url),
          request.ldrawLibraryUrl,
        );
        const engine = new ModelImportEngine(compiler, mirror, connectors, () => performance.now());
        return engine.importText(input.job);
      }
      case "studio": {
        const mirror = new LdrawMirror(
          input.job.source,
          (url) => fetch(url),
          request.ldrawLibraryUrl,
        );
        return importStudioFile(compiler, mirror, connectors, () => performance.now(), input);
      }
      default: {
        const unhandled: never = input;
        throw new Error(`unhandled import input ${JSON.stringify(unhandled)}`);
      }
    }
  }
}

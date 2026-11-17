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
  private readonly modules = new Map<string, Promise<WebAssembly.Module>>();

  private compilerModule(url: string): Promise<WebAssembly.Module> {
    const cached = this.modules.get(url);
    if (cached) return cached;
    const loading = fetch(url).then(async (response) => {
      if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
      return WebAssembly.compile(await response.arrayBuffer());
    });
    this.modules.set(url, loading);
    return loading;
  }

  async run(request: ImportWorkerRequest): Promise<ImportResult> {
    const compiler = new BrickCompiler(await this.compilerModule(request.compilerUrl));
    const { input } = request;
    switch (input.kind) {
      case "ldraw": {
        const mirror = new LdrawMirror(input.job.source, (url) => fetch(url));
        const engine = new ModelImportEngine(compiler, mirror, () => performance.now());
        return engine.importText(input.job);
      }
      case "studio": {
        const mirror = new LdrawMirror(input.job.source, (url) => fetch(url));
        return importStudioFile(compiler, mirror, () => performance.now(), input);
      }
      default: {
        const unhandled: never = input;
        throw new Error(`unhandled import input ${JSON.stringify(unhandled)}`);
      }
    }
  }
}

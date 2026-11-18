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

  async run(request: ImportWorkerRequest): Promise<ImportResult> {
    const compiler = await this.compiler(request.compilerUrl);
    const { input } = request;
    switch (input.kind) {
      case "ldraw": {
        const mirror = new LdrawMirror(
          input.job.source,
          (url) => fetch(url),
          request.ldrawLibraryUrl,
        );
        const engine = new ModelImportEngine(compiler, mirror, () => performance.now());
        return engine.importText(input.job);
      }
      case "studio": {
        const mirror = new LdrawMirror(
          input.job.source,
          (url) => fetch(url),
          request.ldrawLibraryUrl,
        );
        return importStudioFile(compiler, mirror, () => performance.now(), input);
      }
      default: {
        const unhandled: never = input;
        throw new Error(`unhandled import input ${JSON.stringify(unhandled)}`);
      }
    }
  }
}

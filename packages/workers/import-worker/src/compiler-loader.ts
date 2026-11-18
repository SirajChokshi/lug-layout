import { BrickCompiler } from "@brr/import";
import { injectable } from "inversify";

export interface ICompilerLoader {
  load(url: string): Promise<BrickCompiler>;
}

@injectable()
export class CompilerLoader implements ICompilerLoader {
  private readonly compilers = new Map<string, Promise<BrickCompiler>>();

  load(url: string): Promise<BrickCompiler> {
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
}

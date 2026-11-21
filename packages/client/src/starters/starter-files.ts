import { inject, injectable } from "inversify";
import { STARTER_FILE_URLS } from "../tokens.ts";

export interface IStarterFiles {
  paths(): ReadonlyArray<string>;
  read(path: string): Promise<Uint8Array>;
}

@injectable()
export class FetchedStarterFiles implements IStarterFiles {
  constructor(@inject(STARTER_FILE_URLS) private readonly urls: ReadonlyMap<string, string>) {}

  paths(): ReadonlyArray<string> {
    return [...this.urls.keys()];
  }

  async read(path: string): Promise<Uint8Array> {
    const url = this.urls.get(path);
    if (url === undefined) throw new Error(`the app ships no starter file ${path}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${path} can't be fetched: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
  }
}

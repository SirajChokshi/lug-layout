import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { normalizeReference, parseLdraw, type LdrawFile } from "./parse.ts";

const SEARCH_FOLDERS = ["parts", "p"] as const;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export class LdrawLibrary {
  private readonly index = new Map<string, string>();
  private readonly cache = new Map<string, LdrawFile>();

  constructor(roots: ReadonlyArray<string>) {
    for (const root of roots) {
      for (const folder of SEARCH_FOLDERS) {
        const base = join(root, folder);
        if (!isDirectory(base)) continue;
        for (const entry of readdirSync(base, { recursive: true, withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".dat")) continue;
          const path = join(entry.parentPath, entry.name);
          const key = `${folder}/${normalizeReference(relative(base, path))}`;
          if (!this.index.has(key)) this.index.set(key, path);
        }
      }
    }
  }

  resolve(reference: string): string | undefined {
    const name = normalizeReference(reference);
    return [...SEARCH_FOLDERS.map((folder) => `${folder}/${name}`), name].find((key) =>
      this.index.has(key),
    );
  }

  load(reference: string): LdrawFile | undefined {
    const key = this.resolve(reference);
    const path = key === undefined ? undefined : this.index.get(key);
    if (path === undefined) return undefined;
    const cached = this.cache.get(path);
    if (cached !== undefined) return cached;
    const parsed = parseLdraw(readFileSync(path, "utf8"));
    this.cache.set(path, parsed);
    return parsed;
  }
}

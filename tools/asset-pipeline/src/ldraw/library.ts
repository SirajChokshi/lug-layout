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

  load(reference: string): LdrawFile | undefined {
    const name = normalizeReference(reference);
    for (const folder of SEARCH_FOLDERS) {
      const path = this.index.get(`${folder}/${name}`);
      if (path === undefined) continue;
      const cached = this.cache.get(path);
      if (cached !== undefined) return cached;
      const parsed = parseLdraw(readFileSync(path, "utf8"));
      this.cache.set(path, parsed);
      return parsed;
    }
    return undefined;
  }
}

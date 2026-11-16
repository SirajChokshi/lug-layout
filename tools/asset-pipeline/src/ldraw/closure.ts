import type { LdrawLibrary } from "./library.ts";

export interface WalkResult {
  readonly visitedFiles: ReadonlySet<string>;
  readonly missingFiles: ReadonlySet<string>;
}

export function dependencyClosure(library: LdrawLibrary, fileName: string): WalkResult {
  const visitedFiles = new Set<string>();
  const missingFiles = new Set<string>();
  const pending = [fileName.toLowerCase()];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (visitedFiles.has(name) || missingFiles.has(name)) continue;
    const file = library.load(name);
    if (file === undefined) {
      missingFiles.add(name);
      continue;
    }
    visitedFiles.add(name);
    for (const line of file.lines) if (line.kind === "subfile") pending.push(line.reference);
  }
  return { visitedFiles, missingFiles };
}

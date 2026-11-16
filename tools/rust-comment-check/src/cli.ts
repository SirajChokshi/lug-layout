import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { findRustComments } from "./scan.ts";

const IGNORED_DIRECTORIES = new Set(["target", "node_modules"]);

async function rustFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !IGNORED_DIRECTORIES.has(entry.name)) {
      files.push(...(await rustFiles(path)));
    } else if (entry.isFile() && entry.name.endsWith(".rs")) {
      files.push(path);
    }
  }
  return files;
}

const roots = process.argv.slice(2);
let reported = 0;
for (const root of roots) {
  for (const file of await rustFiles(root)) {
    for (const { line, column } of findRustComments(await readFile(file, "utf8"))) {
      process.stderr.write(`${file}:${line}:${column} code comments are not allowed\n`);
      reported++;
    }
  }
}
if (reported > 0) process.exitCode = 1;

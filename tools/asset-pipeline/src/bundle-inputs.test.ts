import { spawnSync } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bundleInputFiles } from "./bundle-key.ts";

const pipelineSource = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(pipelineSource, "..", "..", "..");
const cli = join(pipelineSource, "cli.ts");

const RECORD_LOADED_FILES = `
import { registerHooks } from "node:module";
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith("file:")) process.stdout.write(url + "\\n");
    return nextLoad(url, context);
  },
});
`;

interface LoadedFiles {
  readonly files: ReadonlyArray<string>;
  readonly stderr: string;
}

function repoPath(url: string): string {
  return relative(repoRoot, fileURLToPath(url)).split(sep).join("/");
}

function filesLoadedBy(entry: string): LoadedFiles {
  const run = spawnSync(
    process.execPath,
    ["--import", `data:text/javascript,${encodeURIComponent(RECORD_LOADED_FILES)}`, entry],
    { encoding: "utf8" },
  );
  const files = run.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map(repoPath)
    .filter((path) => !path.split("/").includes("node_modules"));
  return { files, stderr: run.stderr };
}

describe("bundle inputs", () => {
  it("hash every repository file the pipeline CLI loads", () => {
    const { files, stderr } = filesLoadedBy(cli);
    expect(stderr, "the CLI loaded all its modules and ran").toContain("usage: cli.ts");
    expect(files).toContain("tools/asset-pipeline/src/cli.ts");
    const inputs = new Set(bundleInputFiles(repoRoot));
    expect(files.filter((file) => !inputs.has(file))).toEqual([]);
  });
});

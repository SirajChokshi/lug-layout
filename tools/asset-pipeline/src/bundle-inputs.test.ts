import { spawnSync } from "node:child_process";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUNDLE_DATA_FILES, FIXTURES_DIRECTORY } from "./bundle-data.ts";
import { bundleInputFiles } from "./bundle-key.ts";
import { readPalette } from "./palette.ts";

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

function repoPath(path: string): string {
  return relative(repoRoot, path).split(sep).join("/");
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
    .map((url) => repoPath(fileURLToPath(url)))
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

  it("hash every data file the bundle command reads and every generated model it compiles", async () => {
    const palette = await readPalette(join(repoRoot, BUNDLE_DATA_FILES.palette));
    const generatedModels = palette.models
      .filter((model) => model.origin === "generated")
      .map((model) => repoPath(join(repoRoot, FIXTURES_DIRECTORY, model.file)));
    expect(generatedModels.length).toBeGreaterThan(0);
    const inputs = new Set(bundleInputFiles(repoRoot));
    const read = [...Object.values(BUNDLE_DATA_FILES), ...generatedModels];
    expect(read.filter((file) => !inputs.has(file))).toEqual([]);
  });
});

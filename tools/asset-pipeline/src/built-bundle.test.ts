import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleBuildKey, isBundleBuiltFrom, recordBundleBuild } from "./built-bundle.ts";

const LODS = ["standard", "low"] as const;
const BUNDLE_DIRECTORY = "tools/asset-pipeline/dist/bundle";

const turbo = {
  tasks: {
    "@brr/asset-pipeline#build": { inputs: ["src/**", "$TURBO_ROOT$/crates/**"] },
  },
};

const files: Record<string, string> = {
  "turbo.json": JSON.stringify(turbo),
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "tools/asset-pipeline/src/cli.ts": "cli",
  "crates/brick-compile/src/lib.rs": "lib",
};

let repo = "";

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), contents);
}

function git(...args: ReadonlyArray<string>): void {
  execFileSync("git", args, { cwd: repo });
}

async function isBuilt(): Promise<boolean> {
  const outputs = LODS.map((lod) => join(repo, BUNDLE_DIRECTORY, lod));
  return isBundleBuiltFrom(repo, join(repo, BUNDLE_DIRECTORY), outputs, await bundleBuildKey(repo));
}

async function recordBuild(): Promise<void> {
  await recordBundleBuild(join(repo, BUNDLE_DIRECTORY), await bundleBuildKey(repo));
}

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("isBundleBuiltFrom", () => {
  it("reuses a built bundle only while its inputs, the lockfile and every LOD manifest are unchanged", async () => {
    repo = await mkdtemp(join(tmpdir(), "built-bundle-"));
    for (const [path, contents] of Object.entries(files)) await write(path, contents);
    git("init", "-q");
    git("add", ".");
    for (const lod of LODS) await write(`${BUNDLE_DIRECTORY}/${lod}/manifest.json`, "{}");
    expect(await isBuilt()).toBe(false);

    await recordBuild();
    expect(await isBuilt()).toBe(true);

    await write("crates/brick-compile/src/new.rs", "new");
    expect(await isBuilt()).toBe(false);
    git("add", "crates/brick-compile/src/new.rs");
    expect(await isBuilt()).toBe(false);
    await recordBuild();
    expect(await isBuilt()).toBe(true);

    await write("pnpm-lock.yaml", "lockfileVersion: '9.1'\n");
    expect(await isBuilt()).toBe(false);
    await recordBuild();
    expect(await isBuilt()).toBe(true);

    await rm(join(repo, BUNDLE_DIRECTORY, "low", "manifest.json"));
    expect(await isBuilt()).toBe(false);
  });
});

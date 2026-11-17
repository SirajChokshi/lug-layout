import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleInputKey } from "./bundle-key.ts";

const turbo = {
  tasks: {
    "@brr/asset-pipeline#build": {
      inputs: ["src/**", "!src/**/*.test.ts", "palette.json", "$TURBO_ROOT$/crates/**"],
    },
  },
};

const files: Record<string, string> = {
  "turbo.json": JSON.stringify(turbo),
  "tools/asset-pipeline/src/cli.ts": "cli",
  "tools/asset-pipeline/src/cli.test.ts": "test",
  "tools/asset-pipeline/palette.json": "{}",
  "crates/brick-compile/src/lib.rs": "lib",
  "README.md": "readme",
};

let repo = "";

async function write(path: string, contents: string): Promise<void> {
  await mkdir(dirname(join(repo, path)), { recursive: true });
  await writeFile(join(repo, path), contents);
}

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("bundleInputKey", () => {
  it("changes with the bundle inputs and only with them", async () => {
    repo = await mkdtemp(join(tmpdir(), "part-bundle-key-"));
    for (const [path, contents] of Object.entries(files)) await write(path, contents);
    execFileSync("git", ["init", "-q"], { cwd: repo });
    execFileSync("git", ["add", "."], { cwd: repo });
    const original = bundleInputKey(repo);

    await write("README.md", "edited");
    await write("tools/asset-pipeline/src/cli.test.ts", "edited");
    expect(bundleInputKey(repo)).toBe(original);

    await write("crates/brick-compile/src/lib.rs", "edited");
    const afterCrate = bundleInputKey(repo);
    expect(afterCrate).not.toBe(original);

    await write("tools/asset-pipeline/palette.json", '{"parts":[]}');
    expect(bundleInputKey(repo)).not.toBe(afterCrate);
  });
});

import { createHash } from "node:crypto";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { bundleInputKey, untrackedBundleInputs } from "./bundle-key.ts";
import { MANIFEST_FILE } from "./publish.ts";

const BUILD_KEY_FILE = "build-key.json";
const LOCKFILE = "pnpm-lock.yaml";

export interface BundleBuildKey {
  readonly inputKey: string;
  readonly lockfileSha256: string;
}

export async function bundleBuildKey(repoRoot: string): Promise<BundleBuildKey> {
  const lockfile = await readFile(join(repoRoot, LOCKFILE));
  return {
    inputKey: bundleInputKey(repoRoot),
    lockfileSha256: createHash("sha256").update(lockfile).digest("hex"),
  };
}

function buildKeyText(key: BundleBuildKey): string {
  return `${JSON.stringify({ inputKey: key.inputKey, lockfileSha256: key.lockfileSha256 })}\n`;
}

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

export async function isBundleBuiltFrom(
  repoRoot: string,
  bundleRoot: string,
  lods: ReadonlyArray<string>,
  key: BundleBuildKey,
): Promise<boolean> {
  if (untrackedBundleInputs(repoRoot).length > 0) return false;
  const recorded = await readFile(join(bundleRoot, BUILD_KEY_FILE), "utf8").catch(() => null);
  if (recorded !== buildKeyText(key)) return false;
  const manifests = await Promise.all(
    lods.map((lod) => exists(join(bundleRoot, lod, MANIFEST_FILE))),
  );
  return manifests.every(Boolean);
}

export async function forgetBundleBuild(bundleRoot: string): Promise<void> {
  await rm(join(bundleRoot, BUILD_KEY_FILE), { force: true });
}

export async function recordBundleBuild(bundleRoot: string, key: BundleBuildKey): Promise<void> {
  await writeFile(join(bundleRoot, BUILD_KEY_FILE), buildKeyText(key));
}

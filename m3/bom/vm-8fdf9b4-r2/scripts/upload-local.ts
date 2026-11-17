import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bundleInputKey, remoteManifestFile } from "/agent/repos/lug-layout/tools/asset-pipeline/src/bundle-key.ts";
import { uploadPartBundle } from "/agent/repos/lug-layout/tools/asset-pipeline/src/remote-bundle.ts";
import type { ObjectStore } from "/agent/repos/lug-layout/tools/asset-pipeline/src/r2.ts";

const bucket = process.argv[2] ?? "/tmp/r2sim/bucket";
const repoRoot = "/agent/repos/lug-layout";
const headers: Record<string, Readonly<Record<string, string>>> = {};
const store: ObjectStore = {
  async has() {
    return false;
  },
  async put(key, body, objectHeaders) {
    const path = join(bucket, key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body);
    headers[key] = objectHeaders;
  },
};
const manifestFile = remoteManifestFile(bundleInputKey(repoRoot));
const result = await uploadPartBundle(store, join(repoRoot, "tools/asset-pipeline/dist/bundle"), ["standard", "low", "far"], manifestFile);
await writeFile(join(bucket, "headers.json"), JSON.stringify(headers, null, 1));
console.log(JSON.stringify({ manifestFile, ...result, crosswalkObjects: Object.entries(headers).filter(([k]) => k.includes("crosswalk")) }));

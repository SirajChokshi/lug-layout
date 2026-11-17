import { readFile, readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { CONTENT_HASH_HEX_DIGITS, MANIFEST_FILE } from "./publish.ts";
import { sha256Hex, type ObjectStore } from "./r2.ts";

const IMMUTABLE = "public, max-age=31536000, immutable";
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".glb": "model/gltf-binary",
  ".json": "application/json",
  ".wasm": "application/wasm",
};
const UPLOAD_CONCURRENCY = 16;

export interface UploadResult {
  readonly uploaded: number;
  readonly present: number;
}

interface BundleObject {
  readonly key: string;
  readonly path: string;
}

function contentType(name: string): string {
  const type = CONTENT_TYPES[extname(name)];
  if (type === undefined) throw new Error(`no content type for ${name}`);
  return type;
}

function isContentAddressed(name: string, bytes: Uint8Array): boolean {
  const digest = sha256Hex(bytes).slice(0, CONTENT_HASH_HEX_DIGITS);
  return name.endsWith(`.${digest}${extname(name)}`);
}

async function contentAddressedObjects(
  bundleRoot: string,
  lods: ReadonlyArray<string>,
): Promise<BundleObject[]> {
  const objects: BundleObject[] = [];
  for (const lod of lods) {
    for (const name of (await readdir(join(bundleRoot, lod))).toSorted()) {
      if (name !== MANIFEST_FILE)
        objects.push({ key: `${lod}/${name}`, path: join(bundleRoot, lod, name) });
    }
  }
  return objects;
}

async function putIfAbsent(store: ObjectStore, object: BundleObject): Promise<boolean> {
  if (await store.has(object.key)) return false;
  await store.put(object.key, await readFile(object.path), {
    "Content-Type": contentType(object.key),
    "Cache-Control": IMMUTABLE,
  });
  return true;
}

export async function uploadPartBundle(
  store: ObjectStore,
  bundleRoot: string,
  lods: ReadonlyArray<string>,
  manifestFile: string,
): Promise<UploadResult> {
  const objects = await contentAddressedObjects(bundleRoot, lods);
  for (const object of objects) {
    if (!isContentAddressed(object.key, await readFile(object.path))) {
      throw new Error(`${object.path} is not named by its content hash`);
    }
  }
  const manifests = lods.map((lod) => ({
    key: `${lod}/${manifestFile}`,
    path: join(bundleRoot, lod, MANIFEST_FILE),
  }));
  let uploaded = 0;
  let present = 0;
  const pending = [...objects];
  const worker = async (): Promise<void> => {
    for (let object = pending.shift(); object !== undefined; object = pending.shift()) {
      if (await putIfAbsent(store, object)) uploaded += 1;
      else present += 1;
    }
  };
  await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
  for (const manifest of manifests) {
    if (await putIfAbsent(store, manifest)) uploaded += 1;
    else present += 1;
  }
  return { uploaded, present };
}

export async function isPartBundlePublished(
  store: ObjectStore,
  lods: ReadonlyArray<string>,
  manifestFile: string,
): Promise<boolean> {
  const published = await Promise.all(lods.map((lod) => store.has(`${lod}/${manifestFile}`)));
  return published.every(Boolean);
}

export interface PublishWait {
  readonly timeoutMs: number;
  readonly intervalMs: number;
  readonly onWait: (missing: ReadonlyArray<string>) => void;
}

async function isServed(url: string): Promise<boolean> {
  try {
    return (await fetch(url, { method: "HEAD" })).ok;
  } catch {
    return false;
  }
}

export async function unservedManifests(
  baseUrl: string,
  lods: ReadonlyArray<string>,
  manifestFile: string,
): Promise<string[]> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const urls = lods.map((lod) => new URL(`${lod}/${manifestFile}`, base).href);
  const served = await Promise.all(urls.map(isServed));
  return urls.filter((_, index) => !served[index]);
}

export async function waitUntilServed(
  baseUrl: string,
  lods: ReadonlyArray<string>,
  manifestFile: string,
  wait: PublishWait,
): Promise<void> {
  const deadline = Date.now() + wait.timeoutMs;
  for (;;) {
    const missing = await unservedManifests(baseUrl, lods, manifestFile);
    if (missing.length === 0) return;
    if (Date.now() >= deadline) {
      throw new Error(`part bundle manifests are not served: ${missing.join(", ")}`);
    }
    wait.onWait(missing);
    await sleep(wait.intervalMs);
  }
}

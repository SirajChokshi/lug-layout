import { BundleLod } from "@brr/schema/bundle";
import {
  BUNDLE_POINTER_CACHE_CONTROL,
  BUNDLE_POINTER_FILE,
  BundleManifestFile,
  BundlePointer,
} from "@brr/schema/bundle-pointer";
import { readFile } from "node:fs/promises";
import * as v from "valibot";
import type { ObjectReader } from "../library/ldraw-library.ts";
import {
  decodeJsonFile,
  type ManifestReferences,
  type PointerAdapter,
  type ReferencedFile,
} from "../publication/pinned-publication.ts";
import { CONTENT_HASH_HEX_DIGITS } from "../publish.ts";
import { isContentAddressed } from "../remote-bundle.ts";

const REFERENCED_FILE = new RegExp(
  String.raw`^(?:[^\s"/]+/)*[^\s"/]+\.([0-9a-f]{${CONTENT_HASH_HEX_DIGITS}})\.[a-z0-9]+$`,
  "u",
);
const JSON_EXTENSION = ".json";

const BundleFallback = v.strictObject({ manifest_file: BundleManifestFile });

function collectNames(value: unknown, names: Set<string>): void {
  if (typeof value === "string") {
    if (REFERENCED_FILE.test(value)) names.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectNames(item, names);
  } else if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectNames(item, names);
  }
}

function namesIn(key: string, bytes: Uint8Array): Set<string> {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error(`${key} is not JSON`);
  }
  const names = new Set<string>();
  collectNames(json, names);
  return names;
}

function digestOf(name: string): string {
  const digest = REFERENCED_FILE.exec(name)?.[1];
  if (digest === undefined) throw new Error(`${name} is not content-addressed`);
  return digest;
}

async function lodReferences(
  lod: string,
  manifestFile: string,
  read: ObjectReader,
): Promise<ManifestReferences> {
  const manifestKey = `${lod}/${manifestFile}`;
  const manifest = await read(manifestKey);
  if (manifest === undefined) throw new Error(`${manifestKey} is not stored`);
  const indexes = [manifestKey];
  const files: ReferencedFile[] = [];
  const seen = new Set<string>();
  let frontier = [namesIn(manifestKey, manifest)];
  if (frontier[0]?.size === 0) throw new Error(`${manifestKey} names no files`);
  while (frontier.length > 0) {
    const documents: Promise<Set<string>>[] = [];
    for (const names of frontier) {
      for (const name of names) {
        if (seen.has(name)) continue;
        seen.add(name);
        const key = `${lod}/${name}`;
        if (!name.endsWith(JSON_EXTENSION)) {
          files.push({ key, sha256Prefix: digestOf(name) });
          continue;
        }
        indexes.push(key);
        documents.push(
          read(key).then((bytes) => {
            if (bytes === undefined) throw new Error(`${key} is not stored`);
            if (!isContentAddressed(name, bytes)) {
              throw new Error(`${key} differs from its content address`);
            }
            return namesIn(key, bytes);
          }),
        );
      }
    }
    frontier = await Promise.all(documents);
  }
  return { indexes, files };
}

async function manifestReferences(
  manifestFile: string,
  read: ObjectReader,
): Promise<ManifestReferences> {
  const indexes: string[] = [];
  const files: ReferencedFile[] = [];
  for (const lod of BundleLod.options) {
    const references = await lodReferences(lod, manifestFile, read);
    indexes.push(...references.indexes);
    files.push(...references.files);
  }
  return { indexes, files };
}

export function partBundlePointer(fallbackPath: string): PointerAdapter<string> {
  return {
    key: BUNDLE_POINTER_FILE,
    prefixes: BundleLod.options.map((lod) => `${lod}/`),
    headers: { "Content-Type": "application/json", "Cache-Control": BUNDLE_POINTER_CACHE_CONTROL },
    decode: (bytes) => {
      const pointer = decodeJsonFile(BundlePointer, bytes, BUNDLE_POINTER_FILE);
      return { current: pointer.manifestFile, previous: pointer.previous ?? null };
    },
    encode: (pointer) => {
      const file: BundlePointer = { manifestFile: pointer.current, previous: pointer.previous };
      return new TextEncoder().encode(`${JSON.stringify(file)}\n`);
    },
    sameManifest: (a, b) => a === b,
    describeManifest: (manifestFile) => manifestFile,
    references: manifestReferences,
    retained: async () => [
      decodeJsonFile(BundleFallback, await readFile(fallbackPath), fallbackPath).manifest_file,
    ],
  };
}

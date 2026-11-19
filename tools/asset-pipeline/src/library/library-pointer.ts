import { BundleLod, GithubMirror, LdrawLibraryIndex } from "@brr/schema/bundle";
import { BUNDLE_POINTER_FILE } from "@brr/schema/bundle-pointer";
import * as v from "valibot";
import { partBundlePointer } from "../pointer/part-bundle-pointer.ts";
import {
  decodeJsonFile,
  readPointer,
  type ManifestReferences,
  type PointerAdapter,
} from "../publication/pinned-publication.ts";
import { libraryIndexKey, libraryObjectKey, type ObjectReader } from "./ldraw-library.ts";

export const LDRAW_LIBRARY_POINTER = "index/latest.json";

const PointerFile = v.strictObject({ current: GithubMirror, previous: v.nullable(GithubMirror) });
const BundleManifestSource = v.object({ source: GithubMirror });

function sameSource(a: GithubMirror, b: GithubMirror): boolean {
  return a.kind === b.kind && a.repo === b.repo && a.commit === b.commit && a.root === b.root;
}

function describeSource(source: GithubMirror): string {
  return `${source.repo}@${source.commit}/${source.root}`;
}

async function libraryReferences(
  source: GithubMirror,
  read: ObjectReader,
): Promise<ManifestReferences> {
  const key = libraryIndexKey(source);
  const bytes = await read(key);
  if (bytes === undefined) throw new Error(`${key} is not stored`);
  const index = decodeJsonFile(LdrawLibraryIndex, bytes, key);
  if (!sameSource(index.source, source)) {
    throw new Error(
      `${key} indexes ${describeSource(index.source)}, not ${describeSource(source)}`,
    );
  }
  const files = Object.entries(index.files).map(([path, sha256]) => ({
    key: libraryObjectKey(source, path),
    sha256Prefix: sha256,
  }));
  if (files.length === 0) throw new Error(`${key} lists no files`);
  return { indexes: [key], files };
}

export async function liveBundleSources(
  readBundle: ObjectReader,
  fallbackPath: string,
): Promise<GithubMirror[]> {
  const bundle = partBundlePointer(fallbackPath);
  const pointer = await readPointer(bundle, readBundle);
  if (pointer === null) {
    throw new Error(
      `${BUNDLE_POINTER_FILE} is not served, so the commits the live bundles need are unknown`,
    );
  }
  const manifests = [pointer.current];
  if (pointer.previous !== null) manifests.push(pointer.previous);
  manifests.push(...(await bundle.retained()));
  const sources: GithubMirror[] = [];
  for (const manifest of new Set(manifests)) {
    for (const lod of BundleLod.options) {
      const key = `${lod}/${manifest}`;
      const bytes = await readBundle(key);
      if (bytes === undefined) throw new Error(`${key} is not served`);
      const { source } = decodeJsonFile(BundleManifestSource, bytes, key);
      if (!sources.some((known) => sameSource(known, source))) sources.push(source);
    }
  }
  return sources;
}

export function ldrawLibraryPointer(
  retained: () => Promise<ReadonlyArray<GithubMirror>>,
): PointerAdapter<GithubMirror> {
  return {
    key: LDRAW_LIBRARY_POINTER,
    prefixes: [""],
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    decode: (bytes) => decodeJsonFile(PointerFile, bytes, LDRAW_LIBRARY_POINTER),
    encode: (pointer) => new TextEncoder().encode(`${JSON.stringify(pointer)}\n`),
    sameManifest: sameSource,
    describeManifest: describeSource,
    references: libraryReferences,
    retained,
  };
}

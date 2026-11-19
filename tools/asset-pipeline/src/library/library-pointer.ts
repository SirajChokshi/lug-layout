import { GithubMirror, LdrawLibraryIndex } from "@brr/schema/bundle";
import * as v from "valibot";
import { liveBundleManifestValues } from "../pointer/live-bundles.ts";
import {
  decodeJsonFile,
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
  const values = await liveBundleManifestValues(readBundle, fallbackPath, BundleManifestSource);
  return values.map(({ source }) => source);
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

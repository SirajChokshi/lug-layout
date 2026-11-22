import { BundleCompiler, BundleLod } from "@brr/schema/bundle";
import { BUNDLE_POINTER_FILE } from "@brr/schema/bundle-pointer";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import * as v from "valibot";
import type { ObjectReader } from "../library/ldraw-library.ts";
import {
  decodeJsonFile,
  readPointer,
  type PinnedIndex,
} from "../publication/pinned-publication.ts";
import { partBundlePointer } from "./part-bundle-pointer.ts";

interface StoreConfig {
  readonly public_base_url?: string | null;
}

export async function bundleBaseUrl(storeConfigPath: string): Promise<string> {
  const config = JSON.parse(await readFile(storeConfigPath, "utf8")) as StoreConfig;
  const base = process.env["PART_BUNDLE_BASE_URL"] || config.public_base_url;
  if (!base) throw new Error(`set PART_BUNDLE_BASE_URL or public_base_url in ${storeConfigPath}`);
  return base.endsWith("/") ? base : `${base}/`;
}

export async function liveBundleManifestValues<const TSchema extends v.GenericSchema>(
  read: ObjectReader,
  fallbackPath: string,
  schema: TSchema,
): Promise<Array<v.InferOutput<TSchema>>> {
  const bundle = partBundlePointer(fallbackPath);
  const pointer = await readPointer(bundle, read);
  if (pointer === null) {
    throw new Error(
      `${BUNDLE_POINTER_FILE} is not served, so what the live bundles name is unknown`,
    );
  }
  const manifests = [pointer.current];
  if (pointer.previous !== null) manifests.push(pointer.previous);
  manifests.push(...(await bundle.retained()));
  const values: Array<v.InferOutput<TSchema>> = [];
  for (const manifest of new Set(manifests)) {
    for (const lod of BundleLod.options) {
      const key = `${lod}/${manifest}`;
      const bytes = await read(key);
      if (bytes === undefined) throw new Error(`${key} is not served`);
      const value = decodeJsonFile(schema, bytes, key);
      if (!values.some((known) => isDeepStrictEqual(known, value))) values.push(value);
    }
  }
  return values;
}

const ManifestLibraryBake = v.object({
  compiler: v.nullable(v.object({ libraryBake: BundleCompiler.entries.libraryBake })),
});

export async function liveBundleLibraryBakeIndexes(
  read: ObjectReader,
  fallbackPath: string,
): Promise<PinnedIndex[]> {
  const values = await liveBundleManifestValues(read, fallbackPath, ManifestLibraryBake);
  return values.flatMap(({ compiler }) =>
    compiler?.libraryBake === undefined ? [] : [compiler.libraryBake],
  );
}

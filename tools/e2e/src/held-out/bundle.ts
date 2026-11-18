import { ConnectorRecords } from "@brr/catalog/connector-records";
import type { ImportJob } from "@brr/import";
import {
  BundleIndex,
  CrosswalkFile,
  PartTableFile,
  type BundleColor,
  type ManifestPart,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type * as v from "valibot";

const LOD = "standard";
const OPAQUE_ALPHA = 255;

export interface Bundle {
  readonly directory: string;
  readonly version: string;
  readonly source: ImportJob["source"];
  readonly compiler: WebAssembly.Module;
  readonly connectors: ConnectorRecords;
  readonly parts: ReadonlyMap<string, ManifestPart>;
  readonly colors: ReadonlyArray<BundleColor>;
  readonly bricklinkParts: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly job: Omit<ImportJob, "fileName" | "text">;
}

async function decodedFile<TSchema extends v.GenericSchema>(
  schema: TSchema,
  path: string,
): Promise<v.InferOutput<TSchema>> {
  return decodedOrThrow(decode(schema, JSON.parse(await readFile(path, "utf8"))), path);
}

export async function openBundle(root: string): Promise<Bundle> {
  const directory = join(root, LOD);
  const index = await decodedFile(BundleIndex, join(directory, "manifest.json"));
  if (!index.compiler) throw new Error(`bundle ${index.bundleVersion} ships no compiler`);
  const [table, crosswalk, wasm] = await Promise.all([
    decodedFile(PartTableFile, join(directory, index.partTable.file)),
    decodedFile(CrosswalkFile, join(directory, index.crosswalk.file)),
    readFile(join(directory, index.compiler.file)),
  ]);
  return {
    directory,
    version: index.bundleVersion,
    source: index.source,
    compiler: await WebAssembly.compile(wasm),
    connectors: new ConnectorRecords(
      async (path) => JSON.parse(await readFile(join(directory, path), "utf8")),
      { connectivity: index.connectivity.file, connectors: index.connectors.file },
    ),
    parts: new Map(table.parts.map((part) => [part.id, part])),
    colors: index.colors,
    bricklinkParts: crosswalk.bricklinkParts,
    job: {
      lod: LOD,
      source: index.source,
      studPrimitives: index.studPrimitives.map((primitive) => primitive.name),
      unofficialAllowlist: index.compiler.unofficialAllowlist,
      primitives: index.compiler.primitives ?? null,
      bundlePartIds: table.parts.map((part) => part.id),
      ldconfigCodes: index.colors.map((color) => color.code),
      translucentColors: index.colors
        .filter((color) => color.alpha < OPAQUE_ALPHA)
        .map((color) => color.code),
      vehicles: index.compiler.vehicles ?? null,
    },
  };
}

export async function bundlePartGlb(bundle: Bundle, part: ManifestPart): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(bundle.directory, part.file)));
}

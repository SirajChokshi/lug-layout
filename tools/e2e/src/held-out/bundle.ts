import { ConnectorRecords } from "@brr/catalog/connector-records";
import {
  BundleThenLibraryConnectors,
  LibraryBakeStore,
  LibraryConnectorStore,
  NO_BYTE_CACHE,
  type FetchFunction,
  type ImportJob,
  type IPartRecords,
  type PartConnectorSource,
} from "@brr/import";
import {
  BundleIndex,
  contentAddressedFile,
  CrosswalkFile,
  PartTableFile,
  SectionVocabularyFile,
  type BundleColor,
  type ManifestPart,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type * as v from "valibot";

const LOD = "standard";
const OPAQUE_ALPHA = 255;
const RECORDS_URL = "file:///library-bake/";
const LIBRARY_CONNECTORS_URL = "file:///library-connectors/";
const HTTP_NOT_FOUND = 404;

export interface Bundle {
  readonly directory: string;
  readonly version: string;
  readonly source: ImportJob["source"];
  readonly compiler: WebAssembly.Module;
  readonly connectors: PartConnectorSource;
  readonly libraryConnectors: LibraryConnectorStore | null;
  readonly parts: ReadonlyMap<string, ManifestPart>;
  readonly colors: ReadonlyArray<BundleColor>;
  readonly bricklinkParts: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly job: Omit<ImportJob, "fileName" | "text">;
  readonly records: IPartRecords | null;
  readonly recordsIndex: string | null;
}

function diskFetch(directory: string, base: string): FetchFunction {
  return async (url) => {
    const bytes = await readFile(join(directory, url.slice(base.length))).catch(() => null);
    return bytes === null ? new Response(null, { status: HTTP_NOT_FOUND }) : new Response(bytes);
  };
}

async function localRecords(
  directory: string,
  pin: { readonly file: string; readonly sha256: string } | undefined,
): Promise<IPartRecords | null> {
  if (pin === undefined) return null;
  const indexFile = join(directory, contentAddressedFile(pin.file, pin.sha256));
  const served = await readFile(indexFile).catch(() => null);
  if (served === null) {
    throw new Error(
      `the bundle pins precompiled records but ${indexFile} is missing: run pnpm --filter @brr/asset-pipeline library-bake first`,
    );
  }
  return new LibraryBakeStore(RECORDS_URL, pin, diskFetch(directory, RECORDS_URL), NO_BYTE_CACHE);
}

async function localLibraryConnectors(
  directory: string,
  pin: { readonly file: string; readonly sha256: string } | undefined,
): Promise<LibraryConnectorStore | null> {
  if (pin === undefined) return null;
  const indexFile = join(directory, contentAddressedFile(pin.file, pin.sha256));
  if ((await readFile(indexFile).catch(() => null)) === null) {
    throw new Error(
      `the bundle pins library connector records but ${indexFile} is missing: run pnpm --filter @brr/asset-pipeline library-connectors first`,
    );
  }
  return new LibraryConnectorStore(
    LIBRARY_CONNECTORS_URL,
    pin,
    diskFetch(directory, LIBRARY_CONNECTORS_URL),
    NO_BYTE_CACHE,
  );
}

async function decodedFile<TSchema extends v.GenericSchema>(
  schema: TSchema,
  path: string,
): Promise<v.InferOutput<TSchema>> {
  return decodedOrThrow(decode(schema, JSON.parse(await readFile(path, "utf8"))), path);
}

export async function openBundle(
  root: string,
  recordsRoot: string,
  libraryConnectorsRoot: string,
): Promise<Bundle> {
  const directory = join(root, LOD);
  const index = await decodedFile(BundleIndex, join(directory, "manifest.json"));
  if (!index.compiler) throw new Error(`bundle ${index.bundleVersion} ships no compiler`);
  const [table, crosswalk, wasm, vocabulary] = await Promise.all([
    decodedFile(PartTableFile, join(directory, index.partTable.file)),
    decodedFile(CrosswalkFile, join(directory, index.crosswalk.file)),
    readFile(join(directory, index.compiler.file)),
    decodedFile(SectionVocabularyFile, join(directory, index.compiler.sectionVocabulary.file)),
  ]);
  const records = await localRecords(recordsRoot, index.compiler.libraryBake);
  const libraryConnectors = await localLibraryConnectors(
    libraryConnectorsRoot,
    index.compiler.libraryConnectors,
  );
  const bundleConnectors = new ConnectorRecords(
    async (path) => JSON.parse(await readFile(join(directory, path), "utf8")),
    { connectivity: index.connectivity.file, connectors: index.connectors.file },
    index.compiler.sectionVocabulary.sha256,
  );
  return {
    directory,
    records,
    libraryConnectors,
    recordsIndex: records === null ? null : (index.compiler.libraryBake?.sha256 ?? null),
    version: index.bundleVersion,
    source: index.source,
    compiler: await WebAssembly.compile(wasm),
    connectors:
      libraryConnectors === null
        ? bundleConnectors
        : new BundleThenLibraryConnectors(
            bundleConnectors,
            libraryConnectors.source({
              source: index.source,
              sectionVocabulary: index.compiler.sectionVocabulary.sha256,
            }),
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
      sectionVocabulary: { sizes: vocabulary.sizes, lengths: vocabulary.lengths },
      cavityProbe: index.compiler.cavityProbe,
      bundlePartIds: table.parts.map((part) => part.id),
      ldconfigCodes: index.colors.map((color) => color.code),
      translucentColors: index.colors
        .filter((color) => color.alpha < OPAQUE_ALPHA)
        .map((color) => color.code),
      tableDepthLdu: index.tablePlane.depthBelowTopLdu,
      vehicles: index.compiler.vehicles ?? null,
    },
  };
}

export type BundleParts = Pick<Bundle, "directory" | "source" | "parts" | "colors">;

export async function openBundleParts(root: string): Promise<BundleParts> {
  const directory = join(root, LOD);
  const index = await decodedFile(BundleIndex, join(directory, "manifest.json"));
  const table = await decodedFile(PartTableFile, join(directory, index.partTable.file));
  return {
    directory,
    source: index.source,
    parts: new Map(table.parts.map((part) => [part.id, part])),
    colors: index.colors,
  };
}

export async function bundlePartGlb(
  bundle: Pick<Bundle, "directory">,
  part: ManifestPart,
): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(bundle.directory, part.file)));
}

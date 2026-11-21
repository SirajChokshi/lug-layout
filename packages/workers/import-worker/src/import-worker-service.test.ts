import {
  ASSET_FETCHER,
  BUNDLE_BASE_URL,
  BUNDLE_MANIFEST_FILE,
  NETWORK_ASSET_FETCHER,
  PART_BUNDLE_LOADER,
  catalogModule,
  type PartConnectors,
} from "@brr/catalog";
import { BrickCompiler, type CompileRequest, type PartOutcome } from "@brr/import";
import {
  BundleIndex,
  CONNECTIVITY_SOURCES,
  CONNECTOR_SOURCE,
  ConnectorIndexFile,
  ConnectorRecordFile,
  contentAddressedFile,
  LIBRARY_CONNECTORS_FORMAT,
  LIBRARY_CONNECTORS_INDEX_FILE,
  SectionVocabularyFile,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import type { FetchFunction, ImportWorkerRequest } from "@brr/import";
import type { RpcPort } from "@brr/rpc";
import { INDEXED_DB } from "@brr/storage";
import type { CompilerVehicles, PrimitiveConnectorTable } from "@brr/schema/bundle";
import { IDBFactory } from "fake-indexeddb";
import { Container } from "inversify";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { IImportWorkerService } from "./import-worker-service.ts";
import { importWorkerModules } from "./import-worker.module.ts";
import { IMPORT_CLOCK, IMPORT_FETCH, IMPORT_WORKER_SERVICE } from "./tokens.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const pinnedLibrary = new URL("../../../../.cache/ldraw/", import.meta.url);
const pipelineRoot = new URL("../../../../tools/asset-pipeline/", import.meta.url);
const nativeExtractor = new URL("../../../../target/release/library-connectors", import.meta.url);
const vocabularyFile = new URL(
  "../../../../tools/asset-pipeline/section-vocabulary.json",
  import.meta.url,
);
const MIRROR_PREFIX = "/mirror/";
const LIBRARY_PREFIX = "/library/";
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const LOD = "standard";
const TECHNIC_PART = "ldraw:52031";
const UNBUNDLED_PART = "ldraw:3023b";
const INFERRED_ONLY_PART = "ldraw:1751";
const INFERRED_ONLY_FILE = "parts/1751.dat";
const INFERRED_ONLY_FACES = 25;
const OUTSIDE_PINNED_LIBRARY = "brr-renamed-1751.dat";
const ROTATED_REFERENCE = "26047.dat";
const ROTATED_PART = "brr-rotated-26047.dat";
const ROTATION_DEGREES = 37;
const LDRAW_DECIMALS = 1e6;
const COMPILE_ROUNDS = 16;
const runFile = promisify(execFile);

const idlePort: RpcPort = { postMessage: () => undefined, addEventListener: () => undefined };

function importWorker(indexedDb?: IDBFactory, fetchUrl?: FetchFunction): IImportWorkerService {
  const container = new Container();
  container.load(...importWorkerModules(idlePort));
  if (indexedDb !== undefined) container.rebind(INDEXED_DB).toConstantValue(indexedDb);
  if (fetchUrl !== undefined) container.rebind(IMPORT_FETCH).toConstantValue(fetchUrl);
  return container.get(IMPORT_WORKER_SERVICE);
}

let server: Server;
let base = "";

async function published(file: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`${LOD}/${file}`, bundleRoot), "utf8"));
}

async function publishedRecords(partId: string): Promise<ConnectorRecordFile[]> {
  const manifest = decodedOrThrow(decode(BundleIndex, await published("manifest.json")), LOD);
  const records: ConnectorRecordFile[] = [];
  for (const pkg of ["connectivity", "connectors"] as const) {
    const packageIndex = decodedOrThrow(
      decode(ConnectorIndexFile, await published(manifest[pkg].file)),
      pkg,
    );
    const entry = packageIndex.parts[partId];
    if (entry) {
      records.push(
        decodedOrThrow(decode(ConnectorRecordFile, await published(entry.file)), entry.file),
      );
    }
  }
  return records;
}

let mirrorRoot = MIRROR_PREFIX;

const FACE_COLUMNS = [
  "gender",
  "source",
  "status",
  "caps",
  "origin",
  "axis",
  "sectionCount",
  "sectionCode",
  "sectionSize",
  "sectionLength",
  "piece",
] as const;

function expectTableOf(table: PartConnectors, records: ReadonlyArray<ConnectorRecordFile>): void {
  const faceOffsets = records.map((_, i) =>
    records.slice(0, i).reduce((sum, record) => sum + record.faces.gender.length, 0),
  );
  const sectionOffsets = records.map((_, i) =>
    records.slice(0, i).reduce((sum, record) => sum + record.faces.sectionCode.length, 0),
  );
  for (const column of FACE_COLUMNS) {
    expect({ column, values: [...table[column]] }).toEqual({
      column,
      values: records.flatMap((record) => record.faces[column]),
    });
  }
  expect([...table.slide]).toEqual(records.flatMap((record) => record.faces.slide.map(Number)));
  expect(table.group).toEqual(records.flatMap((record) => record.faces.group));
  expect([...table.sectionStart]).toEqual(
    records.flatMap((record, i) =>
      record.faces.sectionStart.map((start) => start + (sectionOffsets[i] ?? 0)),
    ),
  );
  expect([...table.freeFace]).toEqual(
    records.flatMap((record, i) => record.free.face.map((face) => face + (faceOffsets[i] ?? 0))),
  );
  expect([...table.freeOrigin]).toEqual(records.flatMap((record) => record.free.origin));
  expect([...table.freeAxis]).toEqual(records.flatMap((record) => record.free.axis));
  expect(table.unreadable).toEqual(records.flatMap((record) => record.unreadable));
  expect(table.count).toBe(records.reduce((sum, record) => sum + record.faces.gender.length, 0));
}

function served(path: string): URL {
  if (path.startsWith(LIBRARY_PREFIX)) {
    return new URL(path.slice(LIBRARY_PREFIX.length), new URL(`${LOD}/`, bundleRoot));
  }
  if (!path.startsWith(MIRROR_PREFIX)) return new URL(path.slice(1), bundleRoot);
  return new URL(path.slice(mirrorRoot.length), pinnedLibrary);
}

const tampered = new Map<string, unknown>();

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = decodeURIComponent(request.url ?? "/");
    const replaced = tampered.get(path);
    if (replaced !== undefined) {
      response.writeHead(HTTP_OK).end(JSON.stringify(replaced));
      return;
    }
    readFile(served(path)).then(
      (bytes) => response.writeHead(HTTP_OK).end(bytes),
      () => response.writeHead(HTTP_NOT_FOUND).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function bundleLoader() {
  const container = new Container();
  await container.load(catalogModule);
  container.bind(ASSET_FETCHER).toService(NETWORK_ASSET_FETCHER);
  container.bind(BUNDLE_BASE_URL).toConstantValue(base);
  container.bind(BUNDLE_MANIFEST_FILE).toConstantValue("manifest.json");
  return container.get(PART_BUNDLE_LOADER);
}

it("hands the import path the committed section vocabulary, pinned by its SHA-256, that the bundle's tier 4 records were inferred with", async () => {
  const context = await (await bundleLoader()).importContext(LOD);
  const committed = decodedOrThrow(
    decode(SectionVocabularyFile, JSON.parse(await readFile(vocabularyFile, "utf8"))),
    vocabularyFile.pathname,
  );
  expect(context.sectionVocabulary).toEqual({
    sha256: createHash("sha256")
      .update(await readFile(vocabularyFile))
      .digest("hex"),
    vocabulary: { sizes: committed.sizes, lengths: committed.lengths },
  });
});

it("gives a bundle part the same connector table from the catalog loader as when an import fetches it as a pinned part", async () => {
  const loader = await bundleLoader();
  const context = await loader.importContext(LOD);
  const { repo, commit, root } = context.source;
  mirrorRoot = `${MIRROR_PREFIX}${[repo, commit, root].filter((segment) => segment !== "").join("/")}/`;

  const fromCatalog = await loader.loadPartConnectors(LOD, TECHNIC_PART);
  const imported = await importWorker().run({
    kind: "import",
    ticket: 1,
    compilerUrl: new URL(context.compilerPath, base).href,
    bundleBaseUrl: base,
    connectorIndexes: context.connectorIndexes,
    connectorVocabulary: context.sectionVocabulary.sha256,
    ldrawLibraryUrl: new URL(MIRROR_PREFIX, base).href,
    input: {
      kind: "ldraw",
      job: {
        fileName: "pair.ldr",
        text: [
          "1 4 0 0 0 1 0 0 0 1 0 0 0 1 52031.dat",
          "1 4 0 -80 0 1 0 0 0 1 0 0 0 1 3023b.dat",
        ].join("\n"),
        lod: LOD,
        source: context.source,
        studPrimitives: context.studPrimitiveNames,
        unofficialAllowlist: context.unofficialAllowlist,
        primitives: context.primitives,
        sectionVocabulary: context.sectionVocabulary.vocabulary,
        cavityProbe: context.cavityProbe,
        bundlePartIds: context.partIds.filter((partId) => partId !== TECHNIC_PART),
        ldconfigCodes: context.ldconfigCodes,
        translucentColors: context.translucentCodes,
        tableDepthLdu: context.tableDepthLdu,
        vehicles: context.vehicles,
      },
    },
  });

  const records = await publishedRecords(TECHNIC_PART);
  const [tier1, rest] = records;
  expect(tier1?.faces.source.every((source) => CONNECTIVITY_SOURCES.includes(source))).toBe(true);
  expect(rest?.faces.source.some((source) => !CONNECTIVITY_SOURCES.includes(source))).toBe(true);
  expect(records.some((record) => record.free.face.length > 0)).toBe(true);
  expect(fromCatalog).not.toBeNull();
  if (fromCatalog) expectTableOf(fromCatalog, records);

  const technic = imported.partIds.indexOf(TECHNIC_PART);
  const unbundled = imported.partIds.indexOf(UNBUNDLED_PART);
  expect(imported.report.parts.map(({ kind, reference }) => [reference, kind])).toEqual([
    ["52031.dat", "compiled"],
    ["3023b.dat", "compiled"],
  ]);
  expect(imported.connectors[technic]).toEqual(fromCatalog);
  expect(imported.connectors[unbundled]).toBeNull();
  expect(imported.report.withoutConnectorRecords).toEqual([UNBUNDLED_PART]);
});

it("gives a part the bundle's connector packages don't list the record a pinned library publication lists for it, fetched beside the bundle's and kept in the asset cache for a later worker that can't reach the publication, and still reports a part neither lists", async () => {
  const loader = await bundleLoader();
  const context = await loader.importContext(LOD);
  const { repo, commit, root } = context.source;
  mirrorRoot = `${MIRROR_PREFIX}${[repo, commit, root].filter((segment) => segment !== "").join("/")}/`;
  const fromCatalog = await loader.loadPartConnectors(LOD, TECHNIC_PART);
  const manifest = decodedOrThrow(decode(BundleIndex, await published("manifest.json")), LOD);
  const connectivity = decodedOrThrow(
    decode(ConnectorIndexFile, await published(manifest.connectivity.file)),
    manifest.connectivity.file,
  );
  const libraryIndex = {
    format: LIBRARY_CONNECTORS_FORMAT,
    ldraw: context.source,
    shadow: { ...connectivity.source, kind: "github-archive" },
    sectionVocabulary: context.sectionVocabulary.sha256,
    connectivity: { file: manifest.connectivity.file },
    connectors: { file: manifest.connectors.file },
  };
  const libraryText = JSON.stringify(libraryIndex);
  const pin = {
    file: LIBRARY_CONNECTORS_INDEX_FILE,
    sha256: createHash("sha256").update(libraryText).digest("hex"),
  };
  tampered.set(`${LIBRARY_PREFIX}${contentAddressedFile(pin.file, pin.sha256)}`, libraryIndex);
  for (const path of [context.connectorIndexes.connectivity, context.connectorIndexes.connectors]) {
    const packageIndex = decodedOrThrow(
      decode(ConnectorIndexFile, JSON.parse(await readFile(new URL(path, bundleRoot), "utf8"))),
      path,
    );
    const { [TECHNIC_PART]: _withdrawn, ...parts } = packageIndex.parts;
    tampered.set(`/${path}`, { ...packageIndex, parts });
  }
  try {
    const request = (withLibrary: boolean): ImportWorkerRequest => ({
      kind: "import",
      ticket: 1,
      compilerUrl: new URL(context.compilerPath, base).href,
      bundleBaseUrl: base,
      connectorIndexes: context.connectorIndexes,
      connectorVocabulary: context.sectionVocabulary.sha256,
      ldrawLibraryUrl: new URL(MIRROR_PREFIX, base).href,
      ...(withLibrary
        ? { libraryConnectors: { url: new URL(LIBRARY_PREFIX, base).href, pin } }
        : {}),
      input: {
        kind: "ldraw",
        job: {
          fileName: "pair.ldr",
          text: [
            "1 4 0 0 0 1 0 0 0 1 0 0 0 1 52031.dat",
            "1 4 0 -80 0 1 0 0 0 1 0 0 0 1 3023b.dat",
          ].join("\n"),
          lod: LOD,
          source: context.source,
          studPrimitives: context.studPrimitiveNames,
          unofficialAllowlist: context.unofficialAllowlist,
          primitives: context.primitives,
          sectionVocabulary: context.sectionVocabulary.vocabulary,
          cavityProbe: context.cavityProbe,
          bundlePartIds: context.partIds.filter((partId) => partId !== TECHNIC_PART),
          ldconfigCodes: context.ldconfigCodes,
          translucentColors: context.translucentCodes,
          tableDepthLdu: context.tableDepthLdu,
          vehicles: context.vehicles,
        },
      },
    });

    const indexedDb = new IDBFactory();
    const withoutLibrary = await importWorker().run(request(false));
    const withLibrary = await importWorker(indexedDb).run(request(true));
    const publicationUnreachable: FetchFunction = async (url) => {
      if (new URL(url).pathname.startsWith(LIBRARY_PREFIX)) throw new TypeError("Failed to fetch");
      return fetch(url);
    };
    const later = await importWorker(indexedDb, publicationUnreachable).run(request(true));

    const technic = withLibrary.partIds.indexOf(TECHNIC_PART);
    const unbundled = withLibrary.partIds.indexOf(UNBUNDLED_PART);
    expect(withoutLibrary.connectors).toEqual([null, null]);
    expect(withoutLibrary.report.withoutConnectorRecords.toSorted()).toEqual(
      [TECHNIC_PART, UNBUNDLED_PART].toSorted(),
    );
    expect(fromCatalog).not.toBeNull();
    expect(withLibrary.connectors[technic]).toEqual(fromCatalog);
    expect(withLibrary.connectors[unbundled]).toBeNull();
    expect(withLibrary.report.withoutConnectorRecords).toEqual([UNBUNDLED_PART]);
    expect(withLibrary.report.refusedConnectorRecords).toEqual([]);
    expect(later.connectors).toEqual(withLibrary.connectors);
    expect(later.report.refusedConnectorRecords).toEqual([]);
  } finally {
    tampered.clear();
  }
});

async function pinnedFile(path: string): Promise<string | null> {
  return readFile(new URL(path, pinnedLibrary), "utf8").catch(() => null);
}

async function inferredAtImport(
  part: string,
  files: Map<string, string>,
): Promise<PartOutcome | undefined> {
  const context = await (await bundleLoader()).importContext(LOD);
  const compiler = new BrickCompiler(
    await WebAssembly.compile(await readFile(new URL(context.compilerPath, bundleRoot))),
  );
  const absent = new Set<string>();
  const request: CompileRequest = {
    lod: LOD,
    studPrimitives: context.studPrimitiveNames,
    unofficialAllowlist: context.unofficialAllowlist,
    connectors: {
      primitives: context.primitives,
      sectionVocabulary: context.sectionVocabulary.vocabulary,
      cavityProbe: context.cavityProbe,
      infer: [part],
    },
    parts: [part],
    model: "",
    inlineChecks: [],
  };
  let outcome: PartOutcome | undefined;
  for (let round = 0; round < COMPILE_ROUNDS; round++) {
    [outcome] = compiler.compile(request, { key: part, files, absent }).parts;
    if (outcome?.status !== "need") break;
    for (const path of outcome.paths) {
      const text = await pinnedFile(path);
      if (text === null) absent.add(path);
      else files.set(path, text);
    }
  }
  return outcome;
}

it("infers tier 4 at import for a part outside the pinned library with the bundle's section vocabulary, face for face what the bundle bake published for the same geometry", async () => {
  const context = await (await bundleLoader()).importContext(LOD);
  const geometry = await pinnedFile(INFERRED_ONLY_FILE);
  if (geometry === null) throw new Error(`${INFERRED_ONLY_FILE} is not in the pinned library`);
  const outcome = await inferredAtImport(
    OUTSIDE_PINNED_LIBRARY,
    new Map([[`parts/${OUTSIDE_PINNED_LIBRARY}`, geometry]]),
  );

  const records = await publishedRecords(INFERRED_ONLY_PART);
  expect(records).toHaveLength(1);
  const [bundled] = records;
  expect(bundled?.faces.source).toEqual(
    Array.from({ length: INFERRED_ONLY_FACES }, () => CONNECTOR_SOURCE.inferred),
  );
  expect(bundled?.sectionVocabulary).toBe(context.sectionVocabulary.sha256);
  expect(outcome?.status === "compiled" ? outcome.connectors : outcome).toEqual({
    ...bundled,
    part: OUTSIDE_PINNED_LIBRARY,
    sectionVocabulary: undefined,
  });
});

it("refuses, and reports, a bundle part whose connector record was inferred with another section vocabulary", async () => {
  const loader = await bundleLoader();
  const context = await loader.importContext(LOD);
  const manifest = decodedOrThrow(decode(BundleIndex, await published("manifest.json")), LOD);
  const index = decodedOrThrow(
    decode(ConnectorIndexFile, await published(manifest.connectors.file)),
    manifest.connectors.file,
  );
  const entry = index.parts[TECHNIC_PART];
  if (!entry) throw new Error(`${TECHNIC_PART} has no connector record`);
  const otherVocabulary = "0".repeat(context.sectionVocabulary.sha256.length);
  tampered.set(`/${LOD}/${entry.file}`, {
    ...((await published(entry.file)) as object),
    sectionVocabulary: otherVocabulary,
  });
  try {
    const { repo, commit, root } = context.source;
    mirrorRoot = `${MIRROR_PREFIX}${[repo, commit, root].filter((segment) => segment !== "").join("/")}/`;
    const imported = await importWorker().run({
      kind: "import",
      ticket: 1,
      compilerUrl: new URL(context.compilerPath, base).href,
      bundleBaseUrl: base,
      connectorIndexes: context.connectorIndexes,
      connectorVocabulary: context.sectionVocabulary.sha256,
      ldrawLibraryUrl: new URL(MIRROR_PREFIX, base).href,
      input: {
        kind: "ldraw",
        job: {
          fileName: "technic.ldr",
          text: "1 4 0 0 0 1 0 0 0 1 0 0 0 1 52031.dat",
          lod: LOD,
          source: context.source,
          studPrimitives: context.studPrimitiveNames,
          unofficialAllowlist: context.unofficialAllowlist,
          primitives: context.primitives,
          sectionVocabulary: context.sectionVocabulary.vocabulary,
          cavityProbe: context.cavityProbe,
          bundlePartIds: context.partIds,
          ldconfigCodes: context.ldconfigCodes,
          translucentColors: context.translucentCodes,
          tableDepthLdu: context.tableDepthLdu,
          vehicles: context.vehicles,
        },
      },
    });
    expect(imported.partIds).toEqual([TECHNIC_PART]);
    expect(imported.connectors).toEqual([null]);
    expect(imported.report.withoutConnectorRecords).toEqual([]);
    expect(imported.report.refusedConnectorRecords).toEqual([
      {
        partId: TECHNIC_PART,
        reason: `${TECHNIC_PART}'s connector record was inferred with section vocabulary ${otherVocabulary}, not ${context.sectionVocabulary.sha256}`,
      },
    ]);
  } finally {
    tampered.clear();
  }
});

function ldrawDecimal(value: number): number {
  return Math.round(value * LDRAW_DECIMALS) / LDRAW_DECIMALS;
}

function rotatedAboutY(reference: string, degrees: number, name: string): string {
  const radians = (degrees * Math.PI) / 180;
  const [cos, sin] = [ldrawDecimal(Math.cos(radians)), ldrawDecimal(Math.sin(radians))];
  return [
    `0 ${reference} turned ${degrees} degrees about y`,
    `0 Name: ${name}`,
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "0 BFC CERTIFY CCW",
    `1 16 0 0 0 ${cos} 0 ${sin} 0 1 0 ${-sin} 0 ${cos} ${reference}`,
    "",
  ].join("\n");
}

it("infers at import, face for face, what the native extractor infers for a part whose arc seams fall off the lattice", async () => {
  const files = new Map([
    [`parts/${ROTATED_PART}`, rotatedAboutY(ROTATED_REFERENCE, ROTATION_DEGREES, ROTATED_PART)],
  ]);
  const outcome = await inferredAtImport(ROTATED_PART, files);
  const root = await mkdtemp(join(tmpdir(), "brr-arc-seams-"));
  try {
    for (const [path, text] of files) {
      await mkdir(dirname(join(root, "ldraw", path)), { recursive: true });
      await writeFile(join(root, "ldraw", path), text);
    }
    await mkdir(join(root, "shadow"));
    const pipeline = (file: string): string => fileURLToPath(new URL(file, pipelineRoot));
    await runFile(fileURLToPath(nativeExtractor), [
      "--ldraw",
      join(root, "ldraw"),
      "--shadow",
      join(root, "shadow"),
      "--patches",
      pipeline("shadow-patches"),
      "--primitives",
      pipeline("primitive-connectors.json"),
      "--inferred",
      pipeline("inferred-connectors.json"),
      "--vocabulary",
      pipeline("section-vocabulary.json"),
      "--out",
      join(root, "out"),
      "--shard",
      "0/1",
    ]);
    const nativeFile = join(root, "out", "connectors", ROTATED_PART.replace(/\.dat$/u, ".json"));
    const native = decodedOrThrow(
      decode(ConnectorRecordFile, JSON.parse(await readFile(nativeFile, "utf8"))),
      nativeFile,
    );
    expect(native.faces.source.every((source) => source === CONNECTOR_SOURCE.inferred)).toBe(true);
    expect(outcome?.status === "compiled" ? outcome.connectors : outcome).toEqual({
      ...native,
      part: ROTATED_PART,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const standardBundleRoot = new URL(
  "../../../../tools/asset-pipeline/dist/bundle/standard/",
  import.meta.url,
);
const probeFile = new URL("../../../import/test-data/critic-gap-3.mpd", import.meta.url);
const COMPILER_URL = "https://bundle.example/brick-compile.wasm";
const LIBRARY_URL = "https://library.example/mirror";
const BUNDLE_URL = "https://bundle.example/standard/";
const OPAQUE_ALPHA = 255;

interface Manifest {
  readonly source: { readonly repo: string; readonly commit: string; readonly root: string };
  readonly partTable: { readonly file: string };
  readonly studPrimitives: ReadonlyArray<{ readonly name: string }>;
  readonly colors: ReadonlyArray<{ readonly code: number; readonly alpha: number }>;
  readonly compiler: {
    readonly file: string;
    readonly vehicles?: CompilerVehicles;
    readonly primitives?: PrimitiveConnectorTable;
    readonly sectionVocabulary: { readonly file: string; readonly sha256: string };
    readonly cavityProbe: string;
  };
  readonly tablePlane: { readonly depthBelowTopLdu: number };
  readonly connectivity: { readonly file: string };
  readonly connectors: { readonly file: string };
}

async function readManifest(): Promise<Manifest> {
  return JSON.parse(
    await readFile(new URL("manifest.json", standardBundleRoot), "utf8"),
  ) as Manifest;
}

function servedFrom(manifest: Manifest, requested: string[]): FetchFunction {
  const libraryPrefix = `${LIBRARY_URL}/${manifest.source.repo}/${manifest.source.commit}/${manifest.source.root}/`;
  return async (url) => {
    requested.push(url);
    if (url === COMPILER_URL)
      return new Response(await readFile(new URL(manifest.compiler.file, standardBundleRoot)));
    if (url.startsWith(BUNDLE_URL)) {
      return readFile(new URL(url.slice(BUNDLE_URL.length), standardBundleRoot)).then(
        (bytes) => new Response(bytes),
        () => new Response(null, { status: HTTP_NOT_FOUND }),
      );
    }
    if (!url.startsWith(libraryPrefix)) return new Response(null, { status: HTTP_NOT_FOUND });
    const path = url.slice(libraryPrefix.length).split("/").map(decodeURIComponent).join("/");
    return readFile(new URL(path, pinnedLibrary), "utf8").then(
      (text) => new Response(text),
      () => new Response(null, { status: HTTP_NOT_FOUND }),
    );
  };
}

it("imports with the compiler and LDraw library the request names and the worker clock, downloading the compiler once", async () => {
  const manifest = await readManifest();
  const partTable = JSON.parse(
    await readFile(new URL(manifest.partTable.file, standardBundleRoot), "utf8"),
  ) as { readonly parts: ReadonlyArray<{ readonly id: string }> };
  const standardVocabularyFile = new URL(
    manifest.compiler.sectionVocabulary.file,
    standardBundleRoot,
  );
  const vocabulary = decodedOrThrow(
    decode(SectionVocabularyFile, JSON.parse(await readFile(standardVocabularyFile, "utf8"))),
    standardVocabularyFile.pathname,
  );
  const requested: string[] = [];
  let clockReads = 0;
  const container = new Container();
  container.load(...importWorkerModules(idlePort));
  container.rebind(IMPORT_FETCH).toConstantValue(servedFrom(manifest, requested));
  container.rebind(IMPORT_CLOCK).toConstantValue(() => {
    clockReads++;
    return 0;
  });
  const service = container.get(IMPORT_WORKER_SERVICE);
  const request = (text: string): ImportWorkerRequest => ({
    kind: "import",
    ticket: 1,
    compilerUrl: COMPILER_URL,
    bundleBaseUrl: BUNDLE_URL,
    connectorIndexes: {
      connectivity: manifest.connectivity.file,
      connectors: manifest.connectors.file,
    },
    connectorVocabulary: manifest.compiler.sectionVocabulary.sha256,
    ldrawLibraryUrl: LIBRARY_URL,
    input: {
      kind: "ldraw",
      job: {
        fileName: "critic-gap-3.mpd",
        text,
        lod: "standard",
        source: manifest.source,
        studPrimitives: manifest.studPrimitives.map((primitive) => primitive.name),
        unofficialAllowlist: [],
        bundlePartIds: partTable.parts.map((part) => part.id),
        ldconfigCodes: manifest.colors.map((color) => color.code),
        translucentColors: manifest.colors
          .filter((color) => color.alpha < OPAQUE_ALPHA)
          .map((color) => color.code),
        vehicles: manifest.compiler.vehicles ?? null,
        tableDepthLdu: manifest.tablePlane.depthBelowTopLdu,
        primitives: manifest.compiler.primitives ?? null,
        sectionVocabulary: { sizes: vocabulary.sizes, lengths: vocabulary.lengths },
        cavityProbe: manifest.compiler.cavityProbe,
      },
    },
  });
  const text = await readFile(probeFile, "utf8");

  const first = await service.run(request(text));
  await service.run(request(text));

  expect(clockReads).toBeGreaterThan(0);
  expect(first.report.fetched.found).toBeGreaterThan(0);
  expect(requested.filter((url) => url === COMPILER_URL)).toHaveLength(1);
  expect(
    requested.filter(
      (url) =>
        url !== COMPILER_URL && !url.startsWith(`${LIBRARY_URL}/`) && !url.startsWith(BUNDLE_URL),
    ),
  ).toEqual([]);
});

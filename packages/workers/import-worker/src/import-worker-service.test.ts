import {
  BUNDLE_BASE_URL,
  BUNDLE_MANIFEST_FILE,
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
  SectionVocabularyFile,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { Container } from "inversify";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import { BakeHelperRegistry } from "./bake-helper-registry.ts";
import { CompilerLoader } from "./compiler-loader.ts";
import { ImportWorkerService } from "./import-worker-service.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const pinnedLibrary = new URL("../../../../.cache/ldraw/", import.meta.url);
const vocabularyFile = new URL(
  "../../../../tools/asset-pipeline/section-vocabulary.json",
  import.meta.url,
);
const MIRROR_PREFIX = "/mirror/";
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const LOD = "standard";
const TECHNIC_PART = "ldraw:52031";
const UNBUNDLED_PART = "ldraw:3023b";
const INFERRED_ONLY_PART = "ldraw:1751";
const INFERRED_ONLY_FILE = "parts/1751.dat";
const INFERRED_ONLY_FACES = 25;
const OUTSIDE_PINNED_LIBRARY = "brr-renamed-1751.dat";
const COMPILE_ROUNDS = 16;

function importWorker(): ImportWorkerService {
  return new ImportWorkerService(new CompilerLoader(), new BakeHelperRegistry());
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
  if (!path.startsWith(MIRROR_PREFIX)) return new URL(path.slice(1), bundleRoot);
  return new URL(path.slice(mirrorRoot.length), pinnedLibrary);
}

beforeAll(async () => {
  server = createServer((request, response) => {
    readFile(served(decodeURIComponent(request.url ?? "/"))).then(
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
    compilerUrl: new URL(context.compilerPath, base).href,
    bundleBaseUrl: base,
    connectorIndexes: context.connectorIndexes,
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

async function pinnedFile(path: string): Promise<string | null> {
  return readFile(new URL(path, pinnedLibrary), "utf8").catch(() => null);
}

it("infers tier 4 at import for a part outside the pinned library with the bundle's section vocabulary, face for face what the bundle bake published for the same geometry", async () => {
  const context = await (await bundleLoader()).importContext(LOD);
  const compiler = new BrickCompiler(
    await WebAssembly.compile(await readFile(new URL(context.compilerPath, bundleRoot))),
  );
  const geometry = await pinnedFile(INFERRED_ONLY_FILE);
  if (geometry === null) throw new Error(`${INFERRED_ONLY_FILE} is not in the pinned library`);
  const files = new Map([[`parts/${OUTSIDE_PINNED_LIBRARY}`, geometry]]);
  const absent = new Set<string>();
  const request: CompileRequest = {
    lod: LOD,
    studPrimitives: context.studPrimitiveNames,
    unofficialAllowlist: context.unofficialAllowlist,
    connectors: {
      primitives: context.primitives,
      sectionVocabulary: context.sectionVocabulary.vocabulary,
      cavityProbe: context.cavityProbe,
      infer: [OUTSIDE_PINNED_LIBRARY],
    },
    parts: [OUTSIDE_PINNED_LIBRARY],
    model: "",
    inlineChecks: [],
  };
  let outcome: PartOutcome | undefined;
  for (let round = 0; round < COMPILE_ROUNDS; round++) {
    [outcome] = compiler.compile(request, { key: "pinned", files, absent }).parts;
    if (outcome?.status !== "need") break;
    for (const path of outcome.paths) {
      const text = await pinnedFile(path);
      if (text === null) absent.add(path);
      else files.set(path, text);
    }
  }

  const records = await publishedRecords(INFERRED_ONLY_PART);
  expect(records).toHaveLength(1);
  const [bundled] = records;
  expect(bundled?.faces.source).toEqual(
    Array.from({ length: INFERRED_ONLY_FACES }, () => CONNECTOR_SOURCE.inferred),
  );
  expect(outcome?.status === "compiled" ? outcome.connectors : outcome).toEqual({
    ...bundled,
    part: OUTSIDE_PINNED_LIBRARY,
  });
});

import {
  BUNDLE_BASE_URL,
  BUNDLE_MANIFEST_FILE,
  PART_BUNDLE_LOADER,
  catalogModule,
  type PartConnectors,
} from "@brr/catalog";
import {
  BundleIndex,
  CONNECTIVITY_SOURCES,
  ConnectorIndexFile,
  ConnectorRecordFile,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import type { FetchFunction, ImportWorkerRequest } from "@brr/import";
import type { RpcPort } from "@brr/rpc";
import type { CompilerVehicles, PrimitiveConnectorTable } from "@brr/schema/bundle";
import { Container } from "inversify";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { IImportWorkerService } from "./import-worker-service.ts";
import { importWorkerModule } from "./import-worker.module.ts";
import { IMPORT_CLOCK, IMPORT_FETCH, IMPORT_WORKER_SERVICE } from "./tokens.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const pinnedLibrary = new URL("../../../../.cache/ldraw/", import.meta.url);
const MIRROR_PREFIX = "/mirror/";
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const LOD = "standard";
const TECHNIC_PART = "ldraw:52031";
const UNBUNDLED_PART = "ldraw:3023b";

const idlePort: RpcPort = { postMessage: () => undefined, addEventListener: () => undefined };

function importWorker(): IImportWorkerService {
  const container = new Container();
  container.load(importWorkerModule(idlePort));
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

it("gives a bundle part the same connector table from the catalog loader as when an import fetches it as a pinned part", async () => {
  const container = new Container();
  await container.load(catalogModule);
  container.bind(BUNDLE_BASE_URL).toConstantValue(base);
  container.bind(BUNDLE_MANIFEST_FILE).toConstantValue("manifest.json");
  const loader = container.get(PART_BUNDLE_LOADER);
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
  const requested: string[] = [];
  let clockReads = 0;
  const container = new Container();
  container.load(importWorkerModule(idlePort));
  container.rebind(IMPORT_FETCH).toConstantValue(servedFrom(manifest, requested));
  container.rebind(IMPORT_CLOCK).toConstantValue(() => {
    clockReads++;
    return 0;
  });
  const service = container.get(IMPORT_WORKER_SERVICE);
  const request = (text: string): ImportWorkerRequest => ({
    kind: "import",
    compilerUrl: COMPILER_URL,
    bundleBaseUrl: BUNDLE_URL,
    connectorIndexes: {
      connectivity: manifest.connectivity.file,
      connectors: manifest.connectors.file,
    },
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

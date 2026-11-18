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
  SHADOW_NAMESPACE,
  SHADOW_PATCH_NAMESPACE,
  ShadowLibraryPin,
  ShadowPatchManifest,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
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
import { ImportWorkerService } from "./import-worker-service.ts";

const bundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);
const pinnedLibrary = new URL("../../../../.cache/ldraw/", import.meta.url);
const pipelineRoot = new URL("../../../../tools/asset-pipeline/", import.meta.url);
const shadowLibraryRoot = new URL("../../../../.cache/ldcad-shadow-library/", import.meta.url);
const shadowPatchesRoot = new URL("shadow-patches/", pipelineRoot);
const shadowLibraryDist = new URL("dist/shadow-library/", pipelineRoot);
const nativeExtractor = new URL("../../../../target/release/library-connectors", import.meta.url);
const vocabularyFile = new URL(
  "../../../../tools/asset-pipeline/section-vocabulary.json",
  import.meta.url,
);
const MIRROR_PREFIX = "/mirror/";
const SHADOW_LIBRARY_PREFIX = "/shadow-library/";
const CUSTOM_BRICK = "brr-custom-2x4.dat";
const CUSTOM_BRICK_ID = "ldraw:brr-custom-2x4";
const OFFICIAL_BRICK = "parts/3001.dat";
const OFFICIAL_BRICK_ID = "ldraw:3001";
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

let server: Server;
let base = "";

async function published(file: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`${LOD}/${file}`, bundleRoot), "utf8"));
}

async function publishedRecord(
  partId: string,
  pkg: "connectivity" | "connectors",
): Promise<ConnectorRecordFile | null> {
  const manifest = decodedOrThrow(decode(BundleIndex, await published("manifest.json")), LOD);
  const packageIndex = decodedOrThrow(
    decode(ConnectorIndexFile, await published(manifest[pkg].file)),
    pkg,
  );
  const entry = packageIndex.parts[partId];
  if (!entry) return null;
  return decodedOrThrow(decode(ConnectorRecordFile, await published(entry.file)), entry.file);
}

async function publishedRecords(partId: string): Promise<ConnectorRecordFile[]> {
  const records = [
    await publishedRecord(partId, "connectivity"),
    await publishedRecord(partId, "connectors"),
  ];
  return records.filter((record) => record !== null);
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
  if (path.startsWith(SHADOW_LIBRARY_PREFIX)) {
    return new URL(path.slice(SHADOW_LIBRARY_PREFIX.length), shadowLibraryDist);
  }
  if (!path.startsWith(MIRROR_PREFIX)) return new URL(path.slice(1), bundleRoot);
  return new URL(path.slice(mirrorRoot.length), pinnedLibrary);
}

const tampered = new Map<string, unknown>();
const extraMirrorFiles = new Map<string, string>();

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = decodeURIComponent(request.url ?? "/");
    const replaced = tampered.get(path);
    if (replaced !== undefined) {
      response.writeHead(HTTP_OK).end(JSON.stringify(replaced));
      return;
    }
    const extra = path.startsWith(mirrorRoot)
      ? extraMirrorFiles.get(path.slice(mirrorRoot.length))
      : undefined;
    if (extra !== undefined) {
      response.writeHead(HTTP_OK).end(extra);
      return;
    }
    readFile(served(path)).then(
      (bytes) => response.writeHead(HTTP_OK).end(bytes),
      () => response.writeHead(HTTP_NOT_FOUND).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  await runFile(process.execPath, ["src/shadow-library/cli.ts", "--check"], {
    cwd: fileURLToPath(pipelineRoot),
  });
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
  const imported = await new ImportWorkerService().run({
    id: 1,
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

async function libraryFile(path: string): Promise<string | null> {
  if (path.startsWith(SHADOW_NAMESPACE)) {
    const shadowPath = path.slice(SHADOW_NAMESPACE.length);
    return readFile(new URL(shadowPath, shadowLibraryRoot), "utf8").catch(() => null);
  }
  if (path.startsWith(SHADOW_PATCH_NAMESPACE)) {
    const patchPath = path.slice(SHADOW_PATCH_NAMESPACE.length);
    return readFile(new URL(patchPath, shadowPatchesRoot), "utf8").catch(() => null);
  }
  return pinnedFile(path);
}

async function shadowPatchManifest(): Promise<ShadowPatchManifest> {
  const path = new URL("manifest.json", shadowPatchesRoot);
  return decodedOrThrow(
    decode(ShadowPatchManifest, JSON.parse(await readFile(path, "utf8"))),
    path.pathname,
  );
}

async function customBrick(): Promise<string> {
  const official = await pinnedFile(OFFICIAL_BRICK);
  if (official === null) throw new Error(`${OFFICIAL_BRICK} is not in the pinned library`);
  const geometry = official
    .split("\n")
    .filter((line) => line.startsWith("1 ") || line.startsWith("4 "));
  return [
    "0 A custom 2 x 4 brick with 3001's geometry",
    `0 Name: ${CUSTOM_BRICK}`,
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "0 BFC CERTIFY CCW",
    ...geometry,
    "",
  ].join("\n");
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
      shadowPatchManifest: await shadowPatchManifest(),
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
      const text = await libraryFile(path);
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
    connectivity: null,
    connectors: { ...bundled, part: OUTSIDE_PINNED_LIBRARY, sectionVocabulary: undefined },
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
    const imported = await new ImportWorkerService().run({
      id: 2,
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
    const pipeline = (file: string): string => fileURLToPath(new URL(file, pipelineRoot));
    await runFile(fileURLToPath(nativeExtractor), [
      "--ldraw",
      join(root, "ldraw"),
      "--shadow",
      fileURLToPath(shadowLibraryRoot),
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
    const nativeRecord = async (pkg: string): Promise<ConnectorRecordFile | null> => {
      const file = join(root, "out", pkg, ROTATED_PART.replace(/\.dat$/u, ".json"));
      const text = await readFile(file, "utf8").catch(() => null);
      if (text === null) return null;
      return decodedOrThrow(decode(ConnectorRecordFile, JSON.parse(text)), file);
    };
    const native = await nativeRecord("connectors");
    expect(native?.faces.source.every((source) => source === CONNECTOR_SOURCE.inferred)).toBe(true);
    expect(outcome?.status === "compiled" ? outcome.connectors : outcome).toEqual({
      connectivity: await nativeRecord("connectivity"),
      connectors: native,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("infers at import, for a custom brick with 3001's geometry, official 3001's published connectivity and connectors records", async () => {
  const outcome = await inferredAtImport(
    CUSTOM_BRICK,
    new Map([[`parts/${CUSTOM_BRICK}`, await customBrick()]]),
  );
  const connectivity = await publishedRecord(OFFICIAL_BRICK_ID, "connectivity");
  const connectors = await publishedRecord(OFFICIAL_BRICK_ID, "connectors");

  expect(new Set(connectivity?.faces.source)).toEqual(new Set([CONNECTOR_SOURCE.shadow]));
  expect(new Set(connectors?.faces.source)).toEqual(
    new Set([CONNECTOR_SOURCE.primitive, CONNECTOR_SOURCE.inferred]),
  );
  expect(outcome?.status === "compiled" ? outcome.connectors : outcome).toEqual({
    connectivity: connectivity && { ...connectivity, part: CUSTOM_BRICK },
    connectors: connectors && { ...connectors, part: CUSTOM_BRICK, sectionVocabulary: undefined },
  });
});

it("hands back through the import worker, for a custom brick listed for inference, official 3001's records in their own licence packages, fetching the shadow files from the pinned shadow library", async () => {
  const context = await (await bundleLoader()).importContext(LOD);
  const pin = decodedOrThrow(
    decode(
      ShadowLibraryPin,
      JSON.parse(await readFile(new URL("shadow-library.json", pipelineRoot), "utf8")),
    ),
    "shadow-library.json",
  );
  const { repo, commit, root } = context.source;
  mirrorRoot = `${MIRROR_PREFIX}${[repo, commit, root].filter((segment) => segment !== "").join("/")}/`;
  extraMirrorFiles.set(`parts/${CUSTOM_BRICK}`, await customBrick());
  try {
    const imported = await new ImportWorkerService().run({
      id: 3,
      compilerUrl: new URL(context.compilerPath, base).href,
      bundleBaseUrl: base,
      connectorIndexes: context.connectorIndexes,
      connectorVocabulary: context.sectionVocabulary.sha256,
      ldrawLibraryUrl: new URL(MIRROR_PREFIX, base).href,
      shadowLibrary: {
        indexUrl: new URL(
          `${SHADOW_LIBRARY_PREFIX.slice(1)}shadow-library.${pin.index.sha256.slice(0, 16)}.json`,
          base,
        ).href,
        sha256: pin.index.sha256,
      },
      input: {
        kind: "ldraw",
        job: {
          fileName: "custom.ldr",
          text: `1 4 0 0 0 1 0 0 0 1 0 0 0 1 ${CUSTOM_BRICK}`,
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
          vehicles: context.vehicles,
          infer: [CUSTOM_BRICK],
        },
      },
    });
    const connectivity = await publishedRecord(OFFICIAL_BRICK_ID, "connectivity");
    const connectors = await publishedRecord(OFFICIAL_BRICK_ID, "connectors");
    if (connectivity === null || connectors === null) {
      throw new Error(`${OFFICIAL_BRICK_ID} has no published connectivity and connector records`);
    }

    expect(imported.partIds).toEqual([CUSTOM_BRICK_ID]);
    expect(imported.inferredConnectors).toEqual([
      {
        partId: CUSTOM_BRICK_ID,
        connectivity: { ...connectivity, part: CUSTOM_BRICK_ID },
        connectors: { ...connectors, part: CUSTOM_BRICK_ID },
      },
    ]);
    const [table] = imported.connectors;
    if (!table) throw new Error(`${CUSTOM_BRICK_ID} has no connector table`);
    expectTableOf(table, [connectivity, connectors]);
    expect(imported.report.withoutConnectorRecords).toEqual([]);
    expect(imported.report.refusedConnectorRecords).toEqual([]);
    expect(imported.report.fetchedShadowLibrary?.requests).toBeGreaterThan(0);
  } finally {
    extraMirrorFiles.clear();
  }
});

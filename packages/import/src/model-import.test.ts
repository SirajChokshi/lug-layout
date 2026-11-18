import { ConnectorRecords } from "@brr/catalog/connector-records";
import {
  CONNECTOR_SOURCE,
  CONNECTOR_STATUS,
  SectionVocabularyFile,
  type CompilerVehicles,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { BrickCompiler, type CompileRequest } from "./brick-compiler.ts";
import { LdrawMirror, type FetchFunction } from "./ldraw-mirror.ts";
import { ModelImportEngine, type ImportJob, type ImportResult } from "./model-import.ts";
import { importStudioFile } from "./studio-import.ts";

const bundleRoot = new URL("../../../tools/asset-pipeline/dist/bundle/standard/", import.meta.url);
const pinnedLibrary = new URL("../../../.cache/ldraw/", import.meta.url);
const probeFile = new URL("../test-data/critic-gap.mpd", import.meta.url);
const holeProbeFile = new URL("../test-data/critic-gap-3.mpd", import.meta.url);
const paletteTemplate = new URL(
  "../../../docs/verified-facts/scenes/mils-road-straight.ldr",
  import.meta.url,
);
const PALETTE_TEMPLATE_MODEL = "mils-road-straight";
const BAKE_TIMEOUT_MS = 120_000;
const OPAQUE_ALPHA = 255;
const HTTP_NOT_FOUND = 404;
const COLOR_NOT_IN_LDCONFIG = 99_999;
const MAIN_COLOUR = 16;
const RED = 4;
const YELLOW = 14;
const CC_BY_4 = "Licensed under CC BY 4.0 : see CAreadme.txt";
const STUD_PITCH_LDU = 20;
const GENDER_FEMALE = 1;
const ORIGIN_STEPS_PER_LDU = 16;

function customIdPattern(name: string): RegExp {
  return new RegExp(`^custom:[0-9a-f]{12}/${name.replaceAll(".", "\\.")}$`, "u");
}

interface Manifest {
  readonly source: { readonly repo: string; readonly commit: string; readonly root: string };
  readonly partTable: { readonly file: string };
  readonly studPrimitives: ReadonlyArray<{ readonly name: string }>;
  readonly colors: ReadonlyArray<{ readonly code: number; readonly alpha: number }>;
  readonly compiler: {
    readonly file: string;
    readonly vehicles?: CompilerVehicles;
    readonly primitives?: CompileRequest["connectors"]["primitives"];
    readonly sectionVocabulary: { readonly file: string; readonly sha256: string };
    readonly cavityProbe: string;
  };
  readonly models: ReadonlyArray<{ readonly name: string; readonly file: string }>;
  readonly connectors: { readonly file: string };
  readonly connectivity: { readonly file: string };
}

interface BundledModel {
  readonly lattice: {
    readonly phase: readonly [number, number];
    readonly aabb: { readonly min: ReadonlyArray<number>; readonly max: ReadonlyArray<number> };
  } | null;
  readonly cover: {
    readonly studs: number;
    readonly coveredStuds: number;
    readonly visibleBits: ReadonlyArray<number>;
    readonly cells: {
      readonly origin: readonly [number, number];
      readonly size: readonly [number, number];
      readonly bottomY: number;
      readonly footprint: ReadonlyArray<number>;
      readonly flat: ReadonlyArray<number>;
      readonly columnBottom: ReadonlyArray<number>;
      readonly columnTop: ReadonlyArray<number>;
    } | null;
  };
}

async function bundleManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(new URL("manifest.json", bundleRoot), "utf8")) as Manifest;
}

interface ImportContext {
  readonly compiler: BrickCompiler;
  readonly mirror: LdrawMirror;
  readonly connectors: ConnectorRecords;
  readonly job: Omit<ImportJob, "fileName" | "text">;
}

async function importContext(fetchUrl: FetchFunction): Promise<ImportContext> {
  const manifest = await bundleManifest();
  const partTable = JSON.parse(
    await readFile(new URL(manifest.partTable.file, bundleRoot), "utf8"),
  ) as { readonly parts: ReadonlyArray<{ readonly id: string }> };
  const compiler = new BrickCompiler(
    new WebAssembly.Module(await readFile(new URL(manifest.compiler.file, bundleRoot))),
  );
  const vocabularyFile = new URL(manifest.compiler.sectionVocabulary.file, bundleRoot);
  const vocabulary = decodedOrThrow(
    decode(SectionVocabularyFile, JSON.parse(await readFile(vocabularyFile, "utf8"))),
    vocabularyFile.pathname,
  );
  const connectors = new ConnectorRecords(
    async (path) => JSON.parse(await readFile(new URL(path, bundleRoot), "utf8")),
    { connectivity: manifest.connectivity.file, connectors: manifest.connectors.file },
    manifest.compiler.sectionVocabulary.sha256,
  );
  const job = {
    lod: "standard",
    source: manifest.source,
    studPrimitives: manifest.studPrimitives.map((primitive) => primitive.name),
    unofficialAllowlist: [],
    primitives: manifest.compiler.primitives ?? null,
    sectionVocabulary: { sizes: vocabulary.sizes, lengths: vocabulary.lengths },
    cavityProbe: manifest.compiler.cavityProbe,
    bundlePartIds: partTable.parts.map((part) => part.id),
    ldconfigCodes: manifest.colors.map((color) => color.code),
    translucentColors: manifest.colors
      .filter((color) => color.alpha < OPAQUE_ALPHA)
      .map((color) => color.code),
    vehicles: manifest.compiler.vehicles ?? null,
  } as const;
  return { compiler, mirror: new LdrawMirror(manifest.source, fetchUrl), connectors, job };
}

async function importWith(
  fetchUrl: FetchFunction,
  fileName: string,
  text: string,
  unofficialAllowlist: ReadonlyArray<string> = [],
): Promise<ImportResult> {
  const { compiler, mirror, connectors, job } = await importContext(fetchUrl);
  return new ModelImportEngine(compiler, mirror, connectors, () => 0).importText({
    ...job,
    unofficialAllowlist,
    fileName,
    text,
  });
}

const nothingFound: FetchFunction = async () => new Response(null, { status: HTTP_NOT_FOUND });

const pinnedMirror: FetchFunction = async (url) => {
  const path = /\/ldraw\/(?<path>.+)$/u.exec(url)?.groups?.["path"];
  if (path === undefined) return new Response(null, { status: HTTP_NOT_FOUND });
  return readFile(new URL(path, pinnedLibrary), "utf8").then(
    (text) => new Response(text),
    () => new Response(null, { status: HTTP_NOT_FOUND }),
  );
};

it("draws bundle parts and reports, without drawing, a part the library lacks and a colour LDConfig lacks", async () => {
  const text = [
    "0 Import contract",
    "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 4 0 -24 0 1 0 0 0 1 0 0 0 1 not-an-ldraw-part.dat",
    `1 ${COLOR_NOT_IN_LDCONFIG} 0 -48 0 1 0 0 0 1 0 0 0 1 3001.dat`,
  ].join("\n");

  const result = await importWith(nothingFound, "contract.ldr", text);

  expect(result.report.parts).toEqual([
    {
      kind: "bundle",
      reference: "3001.dat",
      official: "3001.dat",
      instances: 2,
      partId: "ldraw:3001",
    },
    {
      kind: "notInLibrary",
      reference: "not-an-ldraw-part.dat",
      official: "not-an-ldraw-part.dat",
      instances: 1,
      definedInline: false,
    },
  ]);
  expect(result.report.unknownColors).toEqual([{ code: COLOR_NOT_IN_LDCONFIG, instances: 1 }]);
  expect(result.instanceCount).toBe(1);
  expect(result.partIds).toEqual(["ldraw:3001"]);
});

it("draws CA-licensed custom parts from the file as custom whatever their LDRAW_ORG, keeps an inline copy's measured difference, reports loose model geometry, and draws a copy whose quads only start elsewhere", async () => {
  const result = await importWith(
    pinnedMirror,
    "critic-gap.mpd",
    await readFile(probeFile, "utf8"),
  );
  const parts = result.report.parts;

  expect(parts.map((part) => [part.reference, part.kind, part.instances])).toEqual([
    ["3001.dat", "bundle", 1],
    ["mycustom.dat", "custom", 1],
    ["mycustom2.dat", "custom", 1],
    ["9999-1 - 3001.dat", "custom", 1],
    ["9998-1 - 3001.dat", "bundle", 1],
  ]);
  const custom = parts.flatMap((part) => (part.kind === "custom" ? [part] : []));
  expect(custom.map((part) => part.partId)).toEqual([
    expect.stringMatching(customIdPattern("mycustom.dat")),
    expect.stringMatching(customIdPattern("mycustom2.dat")),
    expect.stringMatching(customIdPattern("9999-1 - 3001.dat")),
  ]);
  expect(custom.map((part) => [part.origin, part.header.ldrawOrg, part.header.license])).toEqual([
    ["mpd", null, CC_BY_4],
    ["mpd", "Unofficial_Part", CC_BY_4],
    ["inlineDiffers", "Unofficial_Part", CC_BY_4],
  ]);
  expect(custom[2]).toMatchObject({
    official: "3001.dat",
    difference: { colorsMatch: false, inlineColors: [RED, YELLOW], officialColors: [MAIN_COLOUR] },
  });
  expect(parts[4]).toMatchObject({ official: "3001.dat", partId: "ldraw:3001" });
  expect(result.report.looseGeometry).toEqual([
    { section: "critic-gap.ldr", triangles: 0, quads: 1, occurrences: 1 },
  ]);
  expect(result.instanceCount).toBe(5);
  expect(result.partIds).toEqual(["ldraw:3001", ...custom.map((part) => part.partId)]);
  expect(result.compiled.map((part) => part.partId)).toEqual(custom.map((part) => part.partId));
  expect(result.report.bakeIssue).toBeNull();
});

it("draws an inline copy with a hole in a large face as custom, keeping the measured hole", async () => {
  const result = await importWith(
    pinnedMirror,
    "critic-gap-3.mpd",
    await readFile(holeProbeFile, "utf8"),
  );
  const parts = result.report.parts;

  expect(parts.map((part) => [part.reference, part.kind, part.instances])).toEqual([
    ["9996-1 - 3001.dat", "custom", 1],
    ["3001.dat", "bundle", 1],
  ]);
  const hole = parts[0]?.kind === "custom" ? parts[0].difference : null;
  expect(hole?.colorsMatch && !hole.surfaceWithinWeld).toBe(true);
  expect(hole && hole.maxMeasuredDistanceLdu > hole.weldEpsilonLdu).toBe(true);
  expect(result.instanceCount).toBe(2);
});

function customFile(name: string, license: string | null, body: ReadonlyArray<string>): string[] {
  return [
    `0 FILE ${name}`,
    `0 ${name} written for the import tests`,
    `0 Name: ${name}`,
    "0 Author: lug-layout tests",
    ...(license === null ? [] : [`0 !LICENSE ${license}`]),
    ...body,
    "0 NOFILE",
  ];
}

function modelOf(references: ReadonlyArray<string>, files: ReadonlyArray<string[]>): string {
  return [
    "0 FILE custom-parts.ldr",
    "0 Custom parts import test",
    "0 Name: custom-parts.ldr",
    "0 Author: lug-layout tests",
    "0 !LDRAW_ORG Model",
    ...references.map(
      (reference, i) => `1 4 ${i * STUD_PITCH_LDU * 4} 0 0 1 0 0 0 1 0 0 0 1 ${reference}`,
    ),
    "0 NOFILE",
    ...files.flat(),
    "",
  ].join("\n");
}

const TRIANGLE = "3 16 0 0 0 20 0 0 0 0 20";
const UNOFFICIAL_PART = "0 !LDRAW_ORG Unofficial_Part";
const LIBRARY_UNOFFICIAL = "parts/library-unofficial.dat";

const mirrorWithAnUnofficialPart: FetchFunction = async (url) =>
  url.endsWith(`/ldraw/${LIBRARY_UNOFFICIAL}`)
    ? new Response(
        customFile("library-unofficial.dat", CC_BY_4, [UNOFFICIAL_PART, TRIANGLE])
          .slice(1, -1)
          .join("\n"),
      )
    : pinnedMirror(url);

it("keeps the unofficial allowlist for a part reached through the library, used directly or from a custom part", async () => {
  const text = modelOf(
    ["library-unofficial.dat", "reaches-library.dat"],
    [
      customFile("reaches-library.dat", CC_BY_4, [
        "1 16 0 0 0 1 0 0 0 1 0 0 0 1 library-unofficial.dat",
      ]),
    ],
  );

  const refused = await importWith(mirrorWithAnUnofficialPart, "custom-parts.mpd", text);
  const allowed = await importWith(mirrorWithAnUnofficialPart, "custom-parts.mpd", text, [
    LIBRARY_UNOFFICIAL,
  ]);

  expect(refused.report.parts).toMatchObject([
    { reference: "library-unofficial.dat", kind: "rejected", gate: "unofficial" },
    {
      reference: "reaches-library.dat",
      kind: "customRefused",
      gate: "unofficial",
      path: LIBRARY_UNOFFICIAL,
    },
  ]);
  expect(allowed.report.parts.map((part) => part.kind)).toEqual(["compiled", "custom"]);
});
const OTHER_TRIANGLE = "3 16 0 0 0 40 0 0 0 0 40";

it("refuses a custom part without a CA licence header whatever its LDRAW_ORG, and one whose own sub-file has none, naming that sub-file", async () => {
  const result = await importWith(
    pinnedMirror,
    "custom-parts.mpd",
    modelOf(
      ["unlicensed.dat", "unofficial-unlicensed.dat", "licensed-top.dat"],
      [
        customFile("unlicensed.dat", null, [TRIANGLE]),
        customFile("unofficial-unlicensed.dat", null, [UNOFFICIAL_PART, TRIANGLE]),
        customFile("licensed-top.dat", CC_BY_4, ["1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\inner.dat"]),
        customFile("s/inner.dat", null, [TRIANGLE]),
      ],
    ),
  );

  expect(result.report.parts).toMatchObject([
    { reference: "unlicensed.dat", kind: "customRefused", gate: "license", path: "unlicensed.dat" },
    {
      reference: "unofficial-unlicensed.dat",
      kind: "customRefused",
      gate: "license",
      path: "unofficial-unlicensed.dat",
    },
    { reference: "licensed-top.dat", kind: "customRefused", gate: "license", path: "s/inner.dat" },
  ]);
  expect(result.instanceCount).toBe(0);
  expect(result.compiled).toEqual([]);
});

function shadowingSubfile(triangle: string): string {
  return modelOf(
    ["shadowing.dat"],
    [
      customFile("shadowing.dat", CC_BY_4, ["1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\3001s01.dat"]),
      customFile("s/3001s01.dat", CC_BY_4, [triangle]),
    ],
  );
}

it("compiles a custom part from the file's own sub-file over the library file of that name, and names it after every file it reaches", async () => {
  const first = await importWith(pinnedMirror, "custom-parts.mpd", shadowingSubfile(TRIANGLE));
  const second = await importWith(
    pinnedMirror,
    "custom-parts.mpd",
    shadowingSubfile(OTHER_TRIANGLE),
  );

  const [one] = first.report.parts;
  const [other] = second.report.parts;
  if (one?.kind !== "custom" || other?.kind !== "custom") {
    throw new Error("shadowing.dat is not drawn as custom");
  }
  expect(one.sourceFiles).toBe(2);
  expect(one.partId).toMatch(customIdPattern("shadowing.dat"));
  expect(other.partId).toMatch(customIdPattern("shadowing.dat"));
  expect(other.partId).not.toBe(one.partId);
});

it("infers a custom brick's connectors at import, flagging every inferred one unverified", async () => {
  const brick = await readFile(new URL("parts/3001.dat", pinnedLibrary), "utf8");
  const geometry = brick.split(/\r?\n/u).filter((line) => /^[1-5] /u.test(line));

  const result = await importWith(
    pinnedMirror,
    "custom-parts.mpd",
    modelOf(["mybrick.dat"], [customFile("mybrick.dat", CC_BY_4, geometry)]),
  );

  const [part] = result.report.parts;
  if (part?.kind !== "custom") throw new Error("mybrick.dat is not drawn as custom");
  const connectors = result.connectors[result.partIds.indexOf(part.partId)];
  if (!connectors) throw new Error("mybrick.dat has no inferred connectors");
  const females: string[] = [];
  for (let face = 0; face < connectors.count; face++) {
    if (connectors.gender[face] !== GENDER_FEMALE) continue;
    expect([connectors.source[face], connectors.status[face]]).toEqual([
      CONNECTOR_SOURCE.inferred,
      CONNECTOR_STATUS.unverified,
    ]);
    const o = face * 3;
    females.push(
      [0, 1, 2].map((axis) => (connectors.origin[o + axis] ?? 0) / ORIGIN_STEPS_PER_LDU).join(" "),
    );
  }
  const antiStuds = [-30, -10, 10, 30].flatMap((x) => [-10, 10].map((z) => `${x} -24 ${z}`));
  const tubes = [-20, 0, 20].map((x) => `${x} -24 0`);
  expect(females.toSorted()).toEqual([...antiStuds, ...tubes].toSorted());
  expect(part.connectors).toMatchObject({ inferred: 11, unverified: 11 });
});

const ZIP_LOCAL_HEADER = 0x04034b50;
const ZIP_CENTRAL_HEADER = 0x02014b50;
const ZIP_END_OF_DIRECTORY = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const ZIP_END_BYTES = 22;

function storedZip(files: ReadonlyArray<readonly [string, string]>): Uint8Array {
  const utf8 = new TextEncoder();
  const encoded = files.map(([name, text]) => [utf8.encode(name), utf8.encode(text)] as const);
  const localBytes = encoded.reduce(
    (sum, [name, data]) => sum + ZIP_LOCAL_HEADER_BYTES + name.length + data.length,
    0,
  );
  const centralBytes = encoded.reduce(
    (sum, [name]) => sum + ZIP_CENTRAL_HEADER_BYTES + name.length,
    0,
  );
  const out = new Uint8Array(localBytes + centralBytes + ZIP_END_BYTES);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  for (const [name, data] of encoded) {
    offsets.push(at);
    view.setUint32(at, ZIP_LOCAL_HEADER, true);
    view.setUint16(at + 4, ZIP_VERSION, true);
    view.setUint32(at + 18, data.length, true);
    view.setUint32(at + 22, data.length, true);
    view.setUint16(at + 26, name.length, true);
    out.set(name, at + ZIP_LOCAL_HEADER_BYTES);
    out.set(data, at + ZIP_LOCAL_HEADER_BYTES + name.length);
    at += ZIP_LOCAL_HEADER_BYTES + name.length + data.length;
  }
  for (const [index, [name, data]] of encoded.entries()) {
    view.setUint32(at, ZIP_CENTRAL_HEADER, true);
    view.setUint16(at + 4, ZIP_VERSION, true);
    view.setUint16(at + 6, ZIP_VERSION, true);
    view.setUint32(at + 20, data.length, true);
    view.setUint32(at + 24, data.length, true);
    view.setUint16(at + 28, name.length, true);
    view.setUint32(at + 42, offsets[index] ?? 0, true);
    out.set(name, at + ZIP_CENTRAL_HEADER_BYTES);
    at += ZIP_CENTRAL_HEADER_BYTES + name.length;
  }
  view.setUint32(at, ZIP_END_OF_DIRECTORY, true);
  view.setUint16(at + 8, files.length, true);
  view.setUint16(at + 10, files.length, true);
  view.setUint32(at + 12, centralBytes, true);
  view.setUint32(at + 16, localBytes, true);
  return out;
}

function partFile(name: string, license: string | null, body: ReadonlyArray<string>): string {
  return customFile(name, license, body).slice(1, -1).join("\n");
}

it("draws a CA-licensed Studio CustomParts file from its own sub-part as custom and refuses an unlicensed one", async () => {
  const { compiler, mirror, connectors, job } = await importContext(pinnedMirror);
  const bytes = storedZip([
    [
      "model.ldr",
      [
        "1 4 0 0 0 1 0 0 0 1 0 0 0 1 studiobrick.dat",
        "1 2 80 0 0 1 0 0 0 1 0 0 0 1 unlicensed.dat",
        "1 1 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat",
        "",
      ].join("\n"),
    ],
    [
      "CustomParts/StudioBrick.dat",
      partFile("studiobrick.dat", CC_BY_4, ["1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\studiobricks01.dat"]),
    ],
    ["CustomParts/s/studiobricks01.dat", partFile("s/studiobricks01.dat", CC_BY_4, [TRIANGLE])],
    ["CustomParts/unlicensed.dat", partFile("unlicensed.dat", null, [TRIANGLE])],
  ]);

  const result = await importStudioFile(compiler, mirror, connectors, () => 0, {
    kind: "studio",
    job: { ...job, fileName: "custom-parts.io" },
    bytes,
    bricklinkParts: {},
  });

  expect(result.report.parts).toMatchObject([
    { reference: "studiobrick.dat", kind: "custom", origin: "studio", sourceFiles: 2 },
    { reference: "unlicensed.dat", kind: "customRefused", origin: "studio", gate: "license" },
    { reference: "3001.dat", kind: "bundle" },
  ]);
  expect(result.studio?.parts.map((part) => [part.studio, part.outcome.kind])).toEqual(
    expect.arrayContaining([
      ["studiobrick.dat", "custom"],
      ["unlicensed.dat", "custom"],
    ]),
  );
  expect(result.instanceCount).toBe(2);
});

it(
  "bakes an imported file to the same lattice, stud cover, footprint and columns as the bundle's own bake of that file",
  async () => {
    const manifest = await bundleManifest();
    const entry = manifest.models.find((model) => model.name === PALETTE_TEMPLATE_MODEL);
    if (!entry) throw new Error(`the bundle has no ${PALETTE_TEMPLATE_MODEL}`);
    const bundled = JSON.parse(
      await readFile(new URL(entry.file, bundleRoot), "utf8"),
    ) as BundledModel;

    const { bake } = await importWith(
      pinnedMirror,
      "mils-road-straight.ldr",
      await readFile(paletteTemplate, "utf8"),
    );

    const cells = bundled.cover.cells;
    expect(bundled.lattice).not.toBeNull();
    expect(cells).not.toBeNull();
    expect(bake?.lattice).toEqual({
      phaseX: bundled.lattice?.phase[0],
      phaseZ: bundled.lattice?.phase[1],
      aabbMin: bundled.lattice?.aabb.min,
      aabbMax: bundled.lattice?.aabb.max,
    });
    expect(bake?.studCover.studs).toBe(bundled.cover.studs);
    expect(bake?.studCover.covered).toBe(bundled.cover.coveredStuds);
    expect([...(bake?.studCover.visibleBits ?? [])]).toEqual(bundled.cover.visibleBits);
    expect(
      bake?.cells && {
        origin: [bake.cells.originX, bake.cells.originZ],
        size: [bake.cells.width, bake.cells.depth],
        bottomY: bake.cells.restY,
        footprint: [...bake.cells.footprint],
        flat: [...bake.cells.flat],
        columnBottom: [...bake.cells.columnBottom],
        columnTop: [...bake.cells.columnTop],
      },
    ).toEqual(cells);
  },
  BAKE_TIMEOUT_MS,
);

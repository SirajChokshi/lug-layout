import { ConnectorRecords } from "@brr/catalog/connector-records";
import { parseGlb } from "@brr/catalog/glb";
import { SectionVocabularyFile, type CompilerVehicles } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readFile } from "node:fs/promises";
import {
  AXIS_NEG_Y,
  AXIS_POS_Y,
  CAP_FAR,
  CAP_ROOT,
  ConnectorTable,
  GENDER_FEMALE,
  GENDER_MALE,
  MODEL_ROOT,
  ModelConnectors,
  SECTION_ROUND,
  SOURCE_SHADOW,
  STATUS_VERIFIED,
  SnapMating,
  SnapShapes,
} from "@brr/domain";
import type { ModelFile } from "@brr/schema/bundle";
import { beforeAll, describe, expect, it } from "vitest";
import { BrickCompiler, type CompileRequest } from "./brick-compiler.ts";
import { LdrawMirror, type FetchFunction } from "./ldraw-mirror.ts";
import { ModelImportEngine, type IBakeHelper, type ImportResult } from "./model-import.ts";

const bundleRoot = new URL("../../../tools/asset-pipeline/dist/bundle/standard/", import.meta.url);
const pinnedLibrary = new URL("../../../.cache/ldraw/", import.meta.url);
const probeFile = new URL("../test-data/critic-gap.mpd", import.meta.url);
const holeProbeFile = new URL("../test-data/critic-gap-3.mpd", import.meta.url);
const customPileFile = new URL("../test-data/custom-pile.ldr", import.meta.url);
const paletteTemplate = new URL(
  "../../../docs/verified-facts/scenes/mils-road-straight.ldr",
  import.meta.url,
);
const PALETTE_TEMPLATE_MODEL = "mils-road-straight";
const BAKE_TIMEOUT_MS = 120_000;
const BUNDLE_MODEL_IMPORT_TIMEOUT_MS = 300_000;
const EVERY_BUNDLE_MODEL_OPT_IN = "IMPORT_EVERY_BUNDLE_MODEL";
const OPAQUE_ALPHA = 255;
const paletteFile = new URL("../../../tools/asset-pipeline/palette.json", import.meta.url);
const omrRoot = new URL("../../../.cache/omr/", import.meta.url);
const fixturesRoot = new URL("../../test-fixtures/", import.meta.url);
const HTTP_NOT_FOUND = 404;
const COLOR_NOT_IN_LDCONFIG = 99_999;
const MAIN_COLOUR = 16;
const RED = 4;
const YELLOW = 14;
const SIXTEENTHS_PER_LDU = 16;

interface PaletteModel {
  readonly name: string;
  readonly origin: string;
  readonly file: string;
}

const paletteModels = (
  JSON.parse(await readFile(paletteFile, "utf8")) as {
    readonly models: ReadonlyArray<PaletteModel>;
  }
).models;

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
  readonly tablePlane: { readonly depthBelowTopLdu: number };
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

async function compilerModule(): Promise<WebAssembly.Module> {
  const manifest = await bundleManifest();
  return new WebAssembly.Module(await readFile(new URL(manifest.compiler.file, bundleRoot)));
}

async function bundleCompiler(): Promise<BrickCompiler> {
  return new BrickCompiler(await compilerModule());
}

async function reactorHelpers(count: number): Promise<ReadonlyArray<IBakeHelper>> {
  const module = await compilerModule();
  return Array.from({ length: count }, (): IBakeHelper => {
    const reactor = new BrickCompiler(module);
    return { bake: async (request, library) => reactor.bake(request, library) };
  });
}

const crashingHelper: IBakeHelper = {
  bake: async () => {
    throw new Error("the helper's reactor trapped");
  },
};

const silentHelper: IBakeHelper = { bake: () => new Promise(() => undefined) };

const outOfSyncHelper: IBakeHelper = {
  bake: async (_, library) => ({ status: "need", paths: [...library.files.keys()].slice(0, 1) }),
};

async function importWith(
  fetchUrl: FetchFunction,
  fileName: string,
  text: string,
  compiler?: BrickCompiler,
  helpers: ReadonlyArray<IBakeHelper> = [],
  studPrimitives?: ReadonlyArray<string>,
): Promise<ImportResult> {
  const manifest = await bundleManifest();
  const partTable = JSON.parse(
    await readFile(new URL(manifest.partTable.file, bundleRoot), "utf8"),
  ) as { readonly parts: ReadonlyArray<{ readonly id: string }> };
  const vocabularyFile = new URL(manifest.compiler.sectionVocabulary.file, bundleRoot);
  const vocabulary = decodedOrThrow(
    decode(SectionVocabularyFile, JSON.parse(await readFile(vocabularyFile, "utf8"))),
    vocabularyFile.pathname,
  );
  const engine = new ModelImportEngine(
    compiler ?? (await bundleCompiler()),
    new LdrawMirror(manifest.source, fetchUrl),
    new ConnectorRecords(
      async (path) => JSON.parse(await readFile(new URL(path, bundleRoot), "utf8")),
      { connectivity: manifest.connectivity.file, connectors: manifest.connectors.file },
      manifest.compiler.sectionVocabulary.sha256,
    ),
    () => 0,
    helpers,
  );
  return engine.importText({
    fileName,
    text,
    lod: "standard",
    source: manifest.source,
    studPrimitives: studPrimitives ?? manifest.studPrimitives.map((primitive) => primitive.name),
    unofficialAllowlist: [],
    primitives: manifest.compiler.primitives ?? null,
    sectionVocabulary: { sizes: vocabulary.sizes, lengths: vocabulary.lengths },
    cavityProbe: manifest.compiler.cavityProbe,
    bundlePartIds: partTable.parts.map((part) => part.id),
    ldconfigCodes: manifest.colors.map((color) => color.code),
    translucentColors: manifest.colors
      .filter((color) => color.alpha < OPAQUE_ALPHA)
      .map((color) => color.code),
    tableDepthLdu: manifest.tablePlane.depthBelowTopLdu,
    vehicles: manifest.compiler.vehicles ?? null,
  });
}

const MATRIX_FLOATS = 12;
const STUD_RADIUS_LDU = 6;
const STUD_HEIGHT_LDU = 4;
const STUD_CENTRE_LDU = 10;
const BRICK_LDU = 24;

function translation(
  matrices: ArrayLike<number>,
  instance: number,
): ReadonlyArray<number | undefined> {
  const at = instance * MATRIX_FLOATS;
  return [matrices[at + 3], matrices[at + 7], matrices[at + 11]];
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
  expect(result.submodels.count).toBe(0);
  expect(Array.from(result.submodels.ofPart)).toEqual([MODEL_ROOT]);
});

it("gives each placement of a sub-file its own sub-model instance and each drawn part its innermost one", async () => {
  const text = [
    "0 FILE main.ldr",
    "0 !LDRAW_ORG Model",
    "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 16 100 0 0 1 0 0 0 1 0 0 0 1 wing.ldr",
    "1 16 -100 0 0 0 0 1 0 1 0 -1 0 0 wing.ldr",
    "0 FILE wing.ldr",
    `1 ${COLOR_NOT_IN_LDCONFIG} 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat`,
    "1 16 0 -24 0 1 0 0 0 1 0 0 0 1 cab.ldr",
    "0 FILE cab.ldr",
    "1 4 20 0 0 1 0 0 0 1 0 0 0 1 3003.dat",
  ].join("\n");

  const { instanceCount, submodels, partTransforms } = await importWith(
    nothingFound,
    "wings.mpd",
    text,
  );

  expect(instanceCount).toBe(3);
  expect(submodels.count).toBe(4);
  expect(Array.from(submodels.parent)).toEqual([MODEL_ROOT, 0, MODEL_ROOT, 2]);
  expect(Array.from(submodels.ofPart)).toEqual([MODEL_ROOT, 1, 3]);
  expect([0, 1, 2, 3].map((i) => translation(submodels.matrices, i))).toEqual([
    [100, 0, 0],
    [100, 24, 0],
    [-100, 0, 0],
    [-100, 24, 0],
  ]);
  expect(translation(partTransforms, 2)).toEqual([-100, 24, 20]);
});

it("identifies a turned sub-model's own stud mate 20,000 LDU from the origin from partTransforms, which single-precision render matrices lose", async () => {
  const text = [
    "0 FILE far.ldr",
    "0 !LDRAW_ORG Model",
    "1 16 20000.0625 0 0 0.866025 0 0.5 0 1 0 -0.5 0 0.866025 tower.ldr",
    "0 FILE tower.ldr",
    "1 4 100 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 4 100 -24 0 1 0 0 0 1 0 0 0 1 3001.dat",
  ].join("\n");
  const shapes = new SnapShapes();
  const mating = new SnapMating(shapes);
  const stud = shapes.intern(
    CAP_ROOT,
    false,
    [SECTION_ROUND],
    [STUD_RADIUS_LDU],
    [STUD_HEIGHT_LDU],
  );
  const receptor = shapes.intern(
    CAP_FAR,
    false,
    [SECTION_ROUND],
    [STUD_RADIUS_LDU],
    [STUD_HEIGHT_LDU],
  );
  const brick = new ConnectorTable(
    Uint16Array.of(stud, receptor),
    Uint8Array.of(GENDER_MALE, GENDER_FEMALE),
    Uint8Array.of(SOURCE_SHADOW, SOURCE_SHADOW),
    Uint8Array.of(STATUS_VERIFIED, STATUS_VERIFIED),
    Float32Array.of(
      STUD_CENTRE_LDU,
      BRICK_LDU,
      STUD_CENTRE_LDU,
      STUD_CENTRE_LDU,
      0,
      STUD_CENTRE_LDU,
    ),
    Int8Array.of(AXIS_POS_Y, AXIS_NEG_Y),
    new Float32Array(6),
    new Uint16Array(2),
  );

  const result = await importWith(nothingFound, "far.mpd", text);
  const identified = (matrices: Float64Array): ReadonlyArray<number> => {
    const connectors = ModelConnectors.fromParts(
      [brick],
      {
        count: result.instanceCount,
        partIndex: result.partIndex,
        matrices,
        submodels: result.submodels,
      },
      mating,
    );
    return [connectors.count, connectors.internalMates, connectors.offLattice];
  };

  expect(identified(result.partTransforms)).toEqual([0, 1, 2]);
  expect(identified(Float64Array.from(result.matrices))).toEqual([0, 0, 4]);
});

it("has a bundle record for every palette model", async () => {
  const manifest = await bundleManifest();
  expect(manifest.models.map((model) => model.name).toSorted()).toEqual(
    paletteModels.map((model) => model.name).toSorted(),
  );
});

describe.runIf(process.env[EVERY_BUNDLE_MODEL_OPT_IN] === "1")(
  "every bundle model, imported",
  () => {
    let compiler: BrickCompiler | undefined;

    beforeAll(async () => {
      compiler = await bundleCompiler();
    });

    it.each(paletteModels)(
      "$name imports with the sub-model tree and part transforms its bake recorded",
      async (model) => {
        const manifest = await bundleManifest();
        const entry = manifest.models.find((bundled) => bundled.name === model.name);
        expect(entry).toBeDefined();
        const root = model.origin === "omr" ? omrRoot : fixturesRoot;
        const result = await importWith(
          pinnedMirror,
          model.file,
          await readFile(new URL(model.file, root), "utf8"),
          compiler,
        );
        const record = JSON.parse(
          await readFile(new URL(entry?.file ?? "", bundleRoot), "utf8"),
        ) as ModelFile;

        expect({
          parent: Array.from(result.submodels.parent),
          matrices: Array.from(result.submodels.matrices),
          ofPart: Array.from(result.submodels.ofPart),
          partTransforms: Array.from(result.partTransforms),
        }).toEqual({ ...record.submodels, partTransforms: record.partTransforms });
      },
      BUNDLE_MODEL_IMPORT_TIMEOUT_MS,
    );
  },
);

it("reports a headerless custom part, loose model geometry and a recoloured inline copy, and draws a copy whose quads only start elsewhere", async () => {
  const result = await importWith(
    pinnedMirror,
    "critic-gap.mpd",
    await readFile(probeFile, "utf8"),
  );
  const parts = result.report.parts;

  expect(parts.map((part) => [part.reference, part.kind, part.instances])).toEqual([
    ["3001.dat", "bundle", 1],
    ["mycustom.dat", "notInLibrary", 1],
    ["mycustom2.dat", "notInLibrary", 1],
    ["9999-1 - 3001.dat", "inlineDiffers", 1],
    ["9998-1 - 3001.dat", "bundle", 1],
  ]);
  expect(parts[3]).toMatchObject({
    official: "3001.dat",
    colorsMatch: false,
    inlineColors: [RED, YELLOW],
    officialColors: [MAIN_COLOUR],
  });
  expect(parts[4]).toMatchObject({ official: "3001.dat", partId: "ldraw:3001" });
  expect(result.report.looseGeometry).toEqual([
    { section: "critic-gap.ldr", triangles: 0, quads: 1, occurrences: 1 },
  ]);
  expect(result.instanceCount).toBe(2);
  expect(result.partIds).toEqual(["ldraw:3001"]);
  expect(result.compiled).toEqual([]);
});

it("reports an inline copy with a hole in a large face, and draws only the file's own official part", async () => {
  const result = await importWith(
    pinnedMirror,
    "critic-gap-3.mpd",
    await readFile(holeProbeFile, "utf8"),
  );
  const parts = result.report.parts;

  expect(parts.map((part) => [part.reference, part.kind, part.instances])).toEqual([
    ["9996-1 - 3001.dat", "inlineDiffers", 1],
    ["3001.dat", "bundle", 1],
  ]);
  const hole = parts[0];
  expect(hole?.kind === "inlineDiffers" && hole.colorsMatch && !hole.surfaceWithinWeld).toBe(true);
  expect(hole?.kind === "inlineDiffers" && hole.maxMeasuredDistanceLdu > hole.weldEpsilonLdu).toBe(
    true,
  );
  expect(result.instanceCount).toBe(1);
});

it.each([0, 2])(
  "bakes an imported file to the same lattice, stud cover, footprint and columns as the bundle's own bake of that file, with %i helper reactors",
  async (helperReactors) => {
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
      undefined,
      await reactorHelpers(helperReactors),
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

it(
  "bakes a custom file the same when helpers crash, never answer or ask for files the primary holds, with the primary baking their slices",
  async () => {
    const text = await readFile(customPileFile, "utf8");
    const alone = await importWith(pinnedMirror, "custom-pile.ldr", text);
    const failing = await importWith(pinnedMirror, "custom-pile.ldr", text, undefined, [
      ...(await reactorHelpers(1)),
      crashingHelper,
      silentHelper,
      outOfSyncHelper,
    ]);

    expect(alone.bake?.studCover.covered).toBeGreaterThan(0);
    expect(alone.bake?.studCover.covered).toBeLessThan(alone.bake?.studCover.studs ?? 0);
    expect(alone.report.bakeHelpersFailed).toBe(0);
    expect(failing.report.bakeHelpersFailed).toBe(3);
    expect(failing.bake).toEqual(alone.bake);
  },
  BAKE_TIMEOUT_MS,
);

function band(from: number, to: number, radii: readonly [number, number]) {
  return {
    source: "measured",
    axis: 0,
    at: [0, 0],
    from: from * SIXTEENTHS_PER_LDU,
    to: to * SIXTEENTHS_PER_LDU,
    radii: radii.map((radius) => radius * SIXTEENTHS_PER_LDU),
  };
}

it(
  "measures the whole outward profile of a wheelset the bundle doesn't hold when the import compiles it",
  async () => {
    const result = await importWith(
      pinnedMirror,
      "wheelset.ldr",
      "0 Wheelset outside the bundle\n1 0 0 0 0 1 0 0 0 1 0 0 0 1 70720c01.dat\n",
    );

    const [compiled] = result.compiled;
    if (!compiled) throw new Error("the import compiled no part");
    const { rolling } = parseGlb(compiled.glb.slice().buffer, compiled.partId).document.extras;
    expect(rolling?.surfaces).toEqual([
      band(-56, -53.5, [0, 2.5]),
      band(-53.5, -52, [2.5, 2.5]),
      band(-52, -49, [6.25, 6.25]),
      band(-52, -46.5, [20.5, 21]),
      band(-52, -42, [2.375, 2.375]),
      band(-46.5, -44, [21, 29]),
      band(-45, -42, [6.25, 6.25]),
      band(-44, -42, [29, 29]),
      band(-42, 42, [2.5, 2.5]),
      band(42, 44, [29, 29]),
      band(42, 45, [6.25, 6.25]),
      band(42, 52, [2.375, 2.375]),
      band(44, 46.5, [29, 21]),
      band(46.5, 52, [21, 20.5]),
      band(49, 52, [6.25, 6.25]),
      band(52, 53.5, [2.5, 2.5]),
      band(53.5, 56, [2.5, 0]),
    ]);
    expect(rolling?.unread).toEqual([]);
  },
  BAKE_TIMEOUT_MS,
);

it("reports, without drawing, a part when the stud primitives draw no ring to measure roundness by", async () => {
  const result = await importWith(
    pinnedMirror,
    "wheelset.ldr",
    "1 0 0 0 0 1 0 0 0 1 0 0 0 1 70720c01.dat\n",
    undefined,
    [],
    ["not-a-stud.dat"],
  );

  expect(result.report.parts).toEqual([
    {
      kind: "failed",
      reference: "70720c01.dat",
      official: "70720c01.dat",
      instances: 1,
      message: "the stud primitives draw no closed round ring to measure roundness by",
    },
  ]);
  expect(result.compiled).toEqual([]);
});

import type { CompilerVehicles } from "@brr/schema/bundle";
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
import { BrickCompiler } from "./brick-compiler.ts";
import { LdrawMirror, type FetchFunction } from "./ldraw-mirror.ts";
import { ModelImportEngine, type ImportResult } from "./model-import.ts";

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
  readonly compiler: { readonly file: string; readonly vehicles?: CompilerVehicles };
  readonly models: ReadonlyArray<{ readonly name: string; readonly file: string }>;
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

async function bundleCompiler(): Promise<BrickCompiler> {
  const manifest = await bundleManifest();
  return new BrickCompiler(
    new WebAssembly.Module(await readFile(new URL(manifest.compiler.file, bundleRoot))),
  );
}

async function importWith(
  fetchUrl: FetchFunction,
  fileName: string,
  text: string,
  compiler?: BrickCompiler,
): Promise<ImportResult> {
  const manifest = await bundleManifest();
  const partTable = JSON.parse(
    await readFile(new URL(manifest.partTable.file, bundleRoot), "utf8"),
  ) as { readonly parts: ReadonlyArray<{ readonly id: string }> };
  const engine = new ModelImportEngine(
    compiler ?? (await bundleCompiler()),
    new LdrawMirror(manifest.source, fetchUrl),
    () => 0,
  );
  return engine.importText({
    fileName,
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

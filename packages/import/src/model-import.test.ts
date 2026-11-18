import type { CompilerVehicles } from "@brr/schema/bundle";
import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
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
const OPAQUE_ALPHA = 255;
const HTTP_NOT_FOUND = 404;
const COLOR_NOT_IN_LDCONFIG = 99_999;
const MAIN_COLOUR = 16;
const RED = 4;
const YELLOW = 14;

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

async function importWith(
  fetchUrl: FetchFunction,
  fileName: string,
  text: string,
): Promise<ImportResult> {
  const manifest = await bundleManifest();
  const partTable = JSON.parse(
    await readFile(new URL(manifest.partTable.file, bundleRoot), "utf8"),
  ) as { readonly parts: ReadonlyArray<{ readonly id: string }> };
  const compiler = new BrickCompiler(
    new WebAssembly.Module(await readFile(new URL(manifest.compiler.file, bundleRoot))),
  );
  const engine = new ModelImportEngine(
    compiler,
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

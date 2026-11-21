import { ConnectorRecords, type PartConnectors } from "@brr/catalog/connector-records";
import { parseGlb } from "@brr/catalog/glb";
import { modelPartCells } from "@brr/catalog/model-part-cells";
import {
  BundleIndex,
  CONNECTOR_SOURCE,
  CONNECTOR_STATUS,
  ModelFile as ModelFileSchema,
  RollingDiagnosticsFile,
  rollingDiagnosticsFit,
  SectionVocabularyFile,
  ShadowLibraryPin,
  isCustomPartId,
  type CompilerVehicles,
  type LibraryBakePart,
  type UnreadBandDiagnostic,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { createHash } from "node:crypto";
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
import type { ModelErratum, ModelFile, NotDrawnSection } from "@brr/schema/bundle";
import { beforeAll, describe, expect, it } from "vitest";
import { BrickCompiler, type CompileRequest } from "./brick-compiler.ts";
import type { CustomSource } from "./custom-parts.ts";
import type { IPartRecords, RecordOptions, RecordStats } from "./library-bake-store.ts";
import { LdrawMirror, type FetchFunction } from "./ldraw-mirror.ts";
import {
  ModelImportEngine,
  type IBakeHelper,
  type ImportResult,
  type PartResolution,
  type PlacedImport,
  type PlacementListener,
} from "./model-import.ts";
import { ShadowMirror, type IShadowLibrary } from "./shadow-mirror.ts";
import { NO_BYTE_CACHE } from "./verified-files.ts";

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
const fixtureBundleRoot = new URL(
  "../../../tools/asset-pipeline/fixture-bundle/standard/",
  import.meta.url,
);
const jumperScene = new URL("../../../docs/verified-facts/scenes/jumper.ldr", import.meta.url);
const JUMPER_FIXTURE_MODEL = "jumper";
const BAKE_TIMEOUT_MS = 120_000;
const BUNDLE_MODEL_IMPORT_TIMEOUT_MS = 300_000;
const EVERY_BUNDLE_MODEL_OPT_IN = "IMPORT_EVERY_BUNDLE_MODEL";

function bySection(a: { readonly section: string }, b: { readonly section: string }): number {
  return a.section < b.section ? -1 : a.section > b.section ? 1 : 0;
}
const OPAQUE_ALPHA = 255;
const paletteFile = new URL("../../../tools/asset-pipeline/palette.json", import.meta.url);
const shadowLibraryDist = new URL(
  "../../../tools/asset-pipeline/dist/shadow-library/",
  import.meta.url,
);
const shadowLibraryPin = new URL(
  "../../../tools/asset-pipeline/shadow-library.json",
  import.meta.url,
);
const SHADOW_LIBRARY_URL = "https://shadow-library.test/shadow-library";
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
const BRICK_2X4_STUDS = 8;

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
  readonly models: ReadonlyArray<{
    readonly name: string;
    readonly file: string;
    readonly notDrawn?: ReadonlyArray<NotDrawnSection>;
    readonly errata?: ReadonlyArray<ModelErratum>;
  }>;
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
      readonly footing: {
        readonly instance: ReadonlyArray<number>;
        readonly cell: ReadonlyArray<number>;
      };
      readonly partCells?: {
        readonly cell: ReadonlyArray<number>;
        readonly instance: ReadonlyArray<number>;
        readonly boxes: ReadonlyArray<number>;
      };
    } | null;
  };
}

function withBakedErrata(pinned: string, errata: ReadonlyArray<ModelErratum>): string {
  const lines = pinned.split(/(?<=\n)/u);
  for (const { line, from, to } of errata) {
    const original = lines[line - 1] ?? "";
    const content = original.replace(/\r?\n$/u, "");
    expect(content, `the pinned line ${line} the bake corrected`).toBe(from);
    lines[line - 1] = `${to}${original.slice(content.length)}`;
  }
  return lines.join("");
}

async function bundleManifest(): Promise<Manifest> {
  return JSON.parse(await readFile(new URL("manifest.json", bundleRoot), "utf8")) as Manifest;
}

interface SectionVocabulary {
  readonly sizes: SectionVocabularyFile["sizes"];
  readonly lengths: SectionVocabularyFile["lengths"];
}

async function bundleVocabulary(manifest: Manifest): Promise<SectionVocabulary> {
  const vocabularyFile = new URL(manifest.compiler.sectionVocabulary.file, bundleRoot);
  const vocabulary = decodedOrThrow(
    decode(SectionVocabularyFile, JSON.parse(await readFile(vocabularyFile, "utf8"))),
    vocabularyFile.pathname,
  );
  return { sizes: vocabulary.sizes, lengths: vocabulary.lengths };
}

function bundleConnectors(manifest: Manifest): ConnectorRecords {
  return new ConnectorRecords(
    async (path) => JSON.parse(await readFile(new URL(path, bundleRoot), "utf8")),
    { connectivity: manifest.connectivity.file, connectors: manifest.connectors.file },
    manifest.compiler.sectionVocabulary.sha256,
  );
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
    return {
      bake: async (request, library, records) => reactor.bake(request, library, records),
    };
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

interface ImportOptions {
  readonly compiler?: BrickCompiler | undefined;
  readonly helpers?: ReadonlyArray<IBakeHelper>;
  readonly studPrimitives?: ReadonlyArray<string>;
  readonly unofficialAllowlist?: ReadonlyArray<string>;
  readonly shadowLibrary?: IShadowLibrary;
  readonly customFiles?: ReadonlyArray<CustomSource>;
  readonly withoutPrimitiveTable?: boolean;
}

async function importWith(
  fetchUrl: FetchFunction,
  fileName: string,
  text: string,
  {
    compiler,
    helpers = [],
    studPrimitives,
    unofficialAllowlist = [],
    shadowLibrary,
    customFiles = [],
    withoutPrimitiveTable = false,
  }: ImportOptions = {},
): Promise<ImportResult> {
  const manifest = await bundleManifest();
  const partTable = JSON.parse(
    await readFile(new URL(manifest.partTable.file, bundleRoot), "utf8"),
  ) as { readonly parts: ReadonlyArray<{ readonly id: string }> };
  const sectionVocabulary = await bundleVocabulary(manifest);
  const engine = new ModelImportEngine(
    compiler ?? (await bundleCompiler()),
    new LdrawMirror(manifest.source, fetchUrl),
    bundleConnectors(manifest),
    null,
    () => 0,
    helpers,
    shadowLibrary ?? null,
  );
  const job = {
    fileName,
    text,
    lod: "standard" as const,
    source: manifest.source,
    studPrimitives: studPrimitives ?? manifest.studPrimitives.map((primitive) => primitive.name),
    unofficialAllowlist,
    primitives: withoutPrimitiveTable ? null : (manifest.compiler.primitives ?? null),
    sectionVocabulary,
    cavityProbe: manifest.compiler.cavityProbe,
    bundlePartIds: partTable.parts.map((part) => part.id),
    ldconfigCodes: manifest.colors.map((color) => color.code),
    translucentColors: manifest.colors
      .filter((color) => color.alpha < OPAQUE_ALPHA)
      .map((color) => color.code),
    tableDepthLdu: manifest.tablePlane.depthBelowTopLdu,
    vehicles: manifest.compiler.vehicles ?? null,
  };
  return engine.importText(job, undefined, customFiles);
}

async function pinnedShadowLibrary(): Promise<ShadowMirror> {
  const pin = decodedOrThrow(
    decode(ShadowLibraryPin, JSON.parse(await readFile(shadowLibraryPin, "utf8"))),
    shadowLibraryPin.pathname,
  );
  const served: FetchFunction = (url) =>
    readFile(new URL(url.slice(SHADOW_LIBRARY_URL.length + 1), shadowLibraryDist)).then(
      (bytes) => new Response(bytes),
      () => new Response(null, { status: HTTP_NOT_FOUND }),
    );
  return new ShadowMirror(SHADOW_LIBRARY_URL, pin.index, served, NO_BYTE_CACHE);
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

const OMR_WHOLE_LDU_RESIDUAL = 0.05;
const OMR_IDENTIFICATION_REACH_LDU = Math.sqrt(3) * OMR_WHOLE_LDU_RESIDUAL;
const ROTATION_ENTRIES = [0, 1, 2, 4, 5, 6, 8, 9, 10];

function rotations(matrices: ArrayLike<number>): ReadonlyArray<number> {
  return Array.from({ length: matrices.length / MATRIX_FLOATS }, (_, m) =>
    ROTATION_ENTRIES.map((entry) => matrices[m * MATRIX_FLOATS + entry] ?? Number.NaN),
  ).flat();
}

function translationShift(a: ArrayLike<number>, b: ArrayLike<number>, instance: number): number {
  const [ax, ay, az] = translation(a, instance);
  const [bx, by, bz] = translation(b, instance);
  return Math.max(
    Math.abs((ax ?? 0) - (bx ?? 0)),
    Math.abs((ay ?? 0) - (by ?? 0)),
    Math.abs((az ?? 0) - (bz ?? 0)),
  );
}

const nothingFound: FetchFunction = async () => new Response(null, { status: HTTP_NOT_FOUND });

const PART_ID_PREFIX = "ldraw:";
const PART_EXTENSION = ".dat";

class CompiledRecords implements IPartRecords {
  readonly key = "compiled-records";
  private readonly held = new Map<string, Uint8Array>();
  private served = 0;

  async rollingDiagnostics(): Promise<ReadonlyMap<string, ReadonlyArray<UnreadBandDiagnostic>>> {
    return new Map();
  }

  constructor(
    private readonly compiler: BrickCompiler,
    private readonly sectionVocabulary: SectionVocabulary,
    private readonly cavityProbe: string,
  ) {}

  async lookup(
    partIds: ReadonlyArray<string>,
    options: RecordOptions,
  ): Promise<ReadonlyMap<string, LibraryBakePart>> {
    const library = { key: "records", files: new Map<string, string>(), absent: new Set<string>() };
    const request = {
      lod: "standard" as const,
      studPrimitives: options.studPrimitives,
      unofficialAllowlist: options.unofficialAllowlist,
      connectors: {
        primitives: options.primitives,
        sectionVocabulary: this.sectionVocabulary,
        cavityProbe: this.cavityProbe,
        infer: [],
        shadowPatchManifest: null,
      },
      parts: partIds.map((id) => `${id.slice(PART_ID_PREFIX.length)}${PART_EXTENSION}`),
      model: "",
      inlineChecks: [],
      records: true,
    };
    let output = this.compiler.compile(request, library);
    for (;;) {
      const needed = output.parts.flatMap((outcome) =>
        outcome.status === "need" ? outcome.paths : [],
      );
      if (needed.length === 0) break;
      for (const path of needed) {
        const text = await readFile(new URL(path, pinnedLibrary), "utf8").catch(() => null);
        if (text === null) library.absent.add(path);
        else library.files.set(path, text);
      }
      output = this.compiler.compile(request, library);
    }
    const found = new Map<string, LibraryBakePart>();
    for (const [index, outcome] of output.parts.entries()) {
      const id = partIds[index];
      if (id === undefined || outcome.status !== "compiled" || outcome.record === null) continue;
      const part = { record: `records/${id}.bin`, glb: `standard/${id}.glb` };
      this.held.set(part.record, outcome.record);
      this.held.set(part.glb, outcome.glb);
      found.set(id, part);
    }
    return found;
  }

  async bytes(file: string): Promise<Uint8Array> {
    const bytes = this.held.get(file);
    if (bytes === undefined) throw new Error(`${file} was never looked up`);
    this.served++;
    return bytes;
  }

  stats(): RecordStats {
    return { fetched: this.served, cached: 0, bytes: 0 };
  }
}

function comparable(result: ImportResult): unknown {
  return {
    ...result,
    compiled: result.compiled.map((part) => ({ partId: part.partId, glb: part.glb })),
    report: {
      ...result.report,
      compileRounds: null,
      bakeRounds: null,
      fetched: null,
      records: null,
      timings: null,
    },
  };
}

async function importOutsideTheBundle(
  fileName: string,
  text: string,
  records: IPartRecords | null,
  onPlaced?: PlacementListener,
): Promise<ImportResult> {
  const manifest = await bundleManifest();
  const engine = new ModelImportEngine(
    await bundleCompiler(),
    new LdrawMirror(manifest.source, pinnedMirror),
    bundleConnectors(manifest),
    records,
    () => 0,
    await reactorHelpers(2),
    null,
  );
  return engine.importText(
    {
      fileName,
      text,
      lod: "standard",
      source: manifest.source,
      studPrimitives: manifest.studPrimitives.map((primitive) => primitive.name),
      unofficialAllowlist: [],
      primitives: manifest.compiler.primitives ?? null,
      sectionVocabulary: await bundleVocabulary(manifest),
      cavityProbe: manifest.compiler.cavityProbe,
      bundlePartIds: [],
      ldconfigCodes: manifest.colors.map((color) => color.code),
      translucentColors: manifest.colors
        .filter((color) => color.alpha < OPAQUE_ALPHA)
        .map((color) => color.code),
      tableDepthLdu: manifest.tablePlane.depthBelowTopLdu,
      vehicles: manifest.compiler.vehicles ?? null,
    },
    onPlaced,
  );
}

it(
  "announces placement once, before the result, with every field the result has but the stud cover, and listening changes nothing in the result",
  async () => {
    const text = [
      "0 two stacked bricks beside a plate",
      "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
      "1 1 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat",
      "1 2 80 0 0 1 0 0 0 1 0 0 0 1 3023.dat",
      "",
    ].join("\n");
    const announced: Array<{ readonly placed: PlacedImport; readonly afterResult: boolean }> = [];
    let resolved = false;
    const listened = await importOutsideTheBundle("stacked.ldr", text, null, (placed) =>
      announced.push({ placed, afterResult: resolved }),
    ).then((result) => {
      resolved = true;
      return result;
    });
    const quiet = await importOutsideTheBundle("stacked.ldr", text, null);
    const { bake, report, studio: _studio, ...shape } = listened;
    if (!bake) throw new Error("the stacked bricks did not bake");
    const { studCover, ...placement } = bake;

    expect(studCover.covered).toBeGreaterThan(0);
    expect(comparable(listened)).toEqual(comparable(quiet));
    expect(announced).toEqual([
      {
        placed: {
          ...shape,
          sections: report.sections,
          refusedConnectorRecords: report.refusedConnectorRecords,
          bake: placement,
        },
        afterResult: false,
      },
    ]);
  },
  BAKE_TIMEOUT_MS,
);

it(
  "a train whose pinned parts bake and draw from records imports exactly as when they compile",
  async () => {
    const model = paletteModels.find((entry) => entry.file === "10013-1.mpd");
    if (!model) throw new Error("10013-1 is not a palette model");
    const text = await readFile(new URL(model.file, omrRoot), "utf8");

    const manifest = await bundleManifest();
    const compiled = await importOutsideTheBundle(model.file, text, null);
    const recorded = await importOutsideTheBundle(
      model.file,
      text,
      new CompiledRecords(
        await bundleCompiler(),
        await bundleVocabulary(manifest),
        manifest.compiler.cavityProbe,
      ),
    );

    expect(compiled.compiled.length).toBeGreaterThan(0);
    expect(compiled.bake?.vehicles.length).toBeGreaterThan(0);
    expect(recorded.report.records?.bakedFromRecords).toBeGreaterThan(0);
    expect(new Set(compiled.compiled.map((part) => part.source))).toEqual(new Set(["import"]));
    expect(recorded.compiled.some((part) => part.source === "library-bake")).toBe(true);
    expect(recorded.report.fetched.requests).toBeLessThan(compiled.report.fetched.requests);
    expect(recorded.report.compileRounds).toBeLessThan(compiled.report.compileRounds);
    expect(recorded.report.compileRounds + recorded.report.bakeRounds).toBeLessThanOrEqual(
      compiled.report.compileRounds + compiled.report.bakeRounds,
    );
    expect(comparable(recorded)).toEqual(comparable(compiled));
  },
  BAKE_TIMEOUT_MS,
);

const pinnedMirror: FetchFunction = async (url) => {
  const path = /\/ldraw\/(?<path>.+)$/u.exec(url)?.groups?.["path"];
  if (path === undefined) return new Response(null, { status: HTTP_NOT_FOUND });
  return readFile(new URL(path, pinnedLibrary), "utf8").then(
    (text) => new Response(text),
    () => new Response(null, { status: HTTP_NOT_FOUND }),
  );
};

const CA_LICENSE = "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt";

function customHub(name: string, extra: ReadonlyArray<string>): string {
  return [
    `0 Custom round hub ${name}`,
    `0 Name: ${name}`,
    "0 Author: synthetic test fixture",
    CA_LICENSE,
    "0 BFC CERTIFY CCW",
    "1 16 0 20 0 20 0 0 0 -20 0 0 0 20 box5.dat",
    "0 BFC INVERTNEXT",
    "1 16 0 20 0 6 0 0 0 -16 0 0 0 6 4-4cyli.dat",
    "4 16 -6 20 20 -6 20 -20 -20 20 -20 -20 20 20",
    "4 16 20 20 20 20 20 -20 6 20 -20 6 20 20",
    ...extra,
  ].join("\n");
}

const SLIVER = "3 16 0 20 0 40000000000000000 20 0 0 20 1";

const customParts = new Map([
  ["parts/zz-custom-round-hub.dat", customHub("zz-custom-round-hub.dat", [])],
  [
    "parts/zz-custom-nonfinite.dat",
    customHub("zz-custom-nonfinite.dat", [
      "3 16 0 20 0 1e400 20 0 0 20 1",
      "1 16 0 0 0 NaN 0 0 0 1 0 0 0 1 stud.dat",
    ]),
  ],
  [
    "parts/zz-custom-unparsed.dat",
    customHub("zz-custom-unparsed.dat", ["3 16 0 20 0 abc 20 0 0 20 1"]),
  ],
  ["parts/zz-custom-absurd-sliver.dat", customHub("zz-custom-absurd-sliver.dat", [SLIVER])],
  [
    "parts/zz-custom-composed-beyond.dat",
    customHub("zz-custom-composed-beyond.dat", [
      "1 16 3000000000000 0 0 1 0 0 0 1 0 0 0 1 s/zz-custom-far-sliver.dat",
    ]),
  ],
  [
    "parts/s/zz-custom-far-sliver.dat",
    [
      "0 Custom far sliver",
      "0 Name: s/zz-custom-far-sliver.dat",
      CA_LICENSE,
      "0 BFC CERTIFY CCW",
      "3 16 0 0 0 1 0 0 0 0 1",
    ].join("\n"),
  ],
  [
    "parts/zz-custom-recessed-plate.dat",
    [
      "0 Custom plate with a stud recessed in its middle",
      "0 Name: zz-custom-recessed-plate.dat",
      "0 Author: synthetic test fixture",
      CA_LICENSE,
      "0 BFC CERTIFY CCW",
      "1 16 0 -16 -20 30 0 0 0 1 0 0 0 10 rect.dat",
      "1 16 0 -16 20 30 0 0 0 1 0 0 0 10 rect.dat",
      "1 16 -20 -16 0 10 0 0 0 1 0 0 0 10 rect.dat",
      "1 16 20 -16 0 10 0 0 0 1 0 0 0 10 rect.dat",
      "1 16 0 -8 0 10 0 0 0 1 0 0 0 10 rect.dat",
      "1 16 0 -8 0 1 0 0 0 1 0 0 0 1 stud.dat",
      "1 16 0 0 0 30 0 0 0 -8 0 0 0 30 box5.dat",
    ].join("\n"),
  ],
]);

const customMirror: FetchFunction = async (url) => {
  const path = /\/ldraw\/(?<path>.+)$/u.exec(url)?.groups?.["path"];
  const custom = path === undefined ? undefined : customParts.get(path);
  return custom === undefined ? pinnedMirror(url) : new Response(custom);
};

const malformedModel = [
  "0 FILE malformed-custom.ldr",
  "0 Malformed custom parts beside an official brick and a well-formed custom hub",
  "0 Name: malformed-custom.ldr",
  "0 Author: synthetic test fixture",
  CA_LICENSE,
  "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 1 80 0 0 1 0 0 0 1 0 0 0 1 zz-custom-round-hub.dat",
  "1 2 160 0 0 1 0 0 0 1 0 0 0 1 zz-custom-nonfinite.dat",
  "1 2 240 0 0 1 0 0 0 1 0 0 0 1 zz-custom-unparsed.dat",
  "1 2 320 0 0 1 0 0 0 1 0 0 0 1 zz-custom-absurd-sliver.dat",
  "1 2 400 0 0 1 0 0 0 1 0 0 0 1 zz-custom-composed-beyond.dat",
  "1 1 0 0 120 1 0 0 0 1 0 0 0 1 9997-1 - 3001.dat",
  "0 NOFILE",
  "0 FILE 9997-1 - 3001.dat",
  "0 Brick  2 x  4 copy with an absurd sliver",
  "0 Name: 9997-1 - 3001.dat",
  "0 Author: synthetic test fixture",
  CA_LICENSE,
  "1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\3001s01.dat",
  SLIVER,
  "0 NOFILE",
].join("\n");

it(
  "refuses each custom part with malformed geometry before drawing it, and imports and bakes the rest of the model",
  async () => {
    const result = await importWith(customMirror, "malformed-custom.mpd", malformedModel);

    expect(
      result.report.parts.map((part) => [
        part.reference,
        part.kind,
        part.kind === "malformed" ? part.findings : [],
      ]),
    ).toEqual([
      ["3001.dat", "bundle", []],
      ["zz-custom-round-hub.dat", "compiled", []],
      [
        "zz-custom-nonfinite.dat",
        "malformed",
        [{ file: "parts/zz-custom-nonfinite.dat", kind: "nonFinite" }],
      ],
      [
        "zz-custom-unparsed.dat",
        "malformed",
        [{ file: "parts/zz-custom-unparsed.dat", kind: "unparsed" }],
      ],
      [
        "zz-custom-absurd-sliver.dat",
        "malformed",
        [{ file: "parts/zz-custom-absurd-sliver.dat", kind: "unresolvable" }],
      ],
      [
        "zz-custom-composed-beyond.dat",
        "malformed",
        [{ file: "parts/zz-custom-composed-beyond.dat", kind: "unresolvable" }],
      ],
      ["9997-1 - 3001.dat", "malformed", [{ file: "9997-1 - 3001.dat", kind: "unresolvable" }]],
    ]);
    expect(result.partIds).toEqual(["ldraw:3001", "ldraw:zz-custom-round-hub"]);
    expect(result.instanceCount).toBe(2);
    expect(result.compiled.map((part) => part.partId)).toEqual(["ldraw:zz-custom-round-hub"]);
    expect(result.report.bakeIssue).toBeNull();
    expect(result.bake?.studCover.studs).toBe(BRICK_2X4_STUDS);
  },
  BAKE_TIMEOUT_MS,
);

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

it("keeps a user model's authored positions, because the import never applies the OMR authoring identification", async () => {
  const text = [
    "0 FILE dusty.ldr",
    "0 !LDRAW_ORG Model",
    "1 16 40.02 0 0 1 0 0 0 1 0 0 0 1 cab.ldr",
    "1 4 10.02 0 3.13 1 0 0 0 1 0 0 0 1 3001.dat",
    "0 FILE cab.ldr",
    "1 4 0 -24 0.01 1 0 0 0 1 0 0 0 1 3003.dat",
  ].join("\n");

  const { submodels, partTransforms } = await importWith(nothingFound, "dusty.mpd", text);

  expect(translation(submodels.matrices, 0)).toEqual([40.02, 0, 0]);
  expect([0, 1].map((i) => translation(partTransforms, i))).toEqual([
    [40.02, 24, -0.01],
    [10.02, 0, -3.13],
  ]);
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
    Int32Array.from(
      [STUD_CENTRE_LDU, BRICK_LDU, STUD_CENTRE_LDU, STUD_CENTRE_LDU, 0, STUD_CENTRE_LDU],
      (ldu) => ldu * SIXTEENTHS_PER_LDU,
    ),
    Int8Array.of(AXIS_POS_Y, AXIS_NEG_Y),
    new Float64Array(6),
    new Uint16Array(2),
    new Float64Array(6),
    [],
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

    it("decodes every served model file, whose shapes' unread bands each name the rolling diagnostics row at their index for the same part", async () => {
      const raw: unknown = JSON.parse(await readFile(new URL("manifest.json", bundleRoot), "utf8"));
      const manifest = decodedOrThrow(decode(BundleIndex, raw), "manifest.json");
      const ref = manifest.rollingDiagnostics;
      if (ref === undefined) throw new Error("the bundle names no rolling diagnostics");
      const bytes = await readFile(new URL(ref.file, bundleRoot));
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(ref.sha256);
      const diagnostics = decodedOrThrow(
        decode(RollingDiagnosticsFile, JSON.parse(bytes.toString("utf8"))),
        ref.file,
      );
      let named = 0;
      const mismatched: string[] = [];
      for (const entry of manifest.models) {
        const text = await readFile(new URL(entry.file, bundleRoot), "utf8");
        const model = decodedOrThrow(decode(ModelFileSchema, JSON.parse(text)), entry.file);
        for (const shape of model.shapes) {
          const bands = shape.rolling?.unread ?? [];
          if (bands.length === 0) continue;
          if (!rollingDiagnosticsFit(bands, diagnostics.parts[shape.id] ?? [])) {
            mismatched.push(shape.id);
          }
          named += bands.length;
        }
      }
      expect(mismatched).toEqual([]);
      expect(named).toBeGreaterThan(0);
    });

    async function importedAndRecorded(model: (typeof paletteModels)[number]) {
      const manifest = await bundleManifest();
      const entry = manifest.models.find((bundled) => bundled.name === model.name);
      expect(entry).toBeDefined();
      const root = model.origin === "omr" ? omrRoot : fixturesRoot;
      const result = await importWith(
        pinnedMirror,
        model.file,
        withBakedErrata(await readFile(new URL(model.file, root), "utf8"), entry?.errata ?? []),
        { compiler },
      );
      const record = JSON.parse(
        await readFile(new URL(entry?.file ?? "", bundleRoot), "utf8"),
      ) as ModelFile;
      const shipped = Array.from(
        result.partIndex,
        (part) => !isCustomPartId(result.partIds[part] ?? ""),
      );
      const added = Array.from(result.partIndex).flatMap((part, instance) =>
        shipped[instance]
          ? []
          : [{ partId: result.partIds[part] ?? "", color: result.ldrawColor[instance] ?? 0 }],
      );
      const imported = {
        parent: Array.from(result.submodels.parent),
        matrices: Array.from(result.submodels.matrices),
        ofPart: Array.from(result.submodels.ofPart).filter((_, instance) => shipped[instance]),
        partTransforms: Array.from(result.partTransforms).filter(
          (_, at) => shipped[Math.floor(at / MATRIX_FLOATS)],
        ),
      };
      return { imported, record, added, custom: drawnCustomParts(result), entry };
    }

    function expectOnlyTheFilesCustomPartsAdded({
      added,
      custom,
      entry,
    }: Awaited<ReturnType<typeof importedAndRecorded>>): void {
      const notDrawn = (entry?.notDrawn ?? []).flatMap((section) =>
        section.kind === "customPart"
          ? [
              {
                section: section.section.toLowerCase(),
                instances: section.instances ?? 0,
                colors: (section.colors ?? [])
                  .flatMap(({ color, instances }) => Array.from({ length: instances }, () => color))
                  .toSorted(),
              },
            ]
          : [],
      );
      const drawn = custom.map((part) => {
        const colors = added
          .filter(({ partId }) => partId === part.partId)
          .map(({ color }) => color)
          .toSorted();
        return { section: part.reference, instances: colors.length, colors };
      });

      expect(drawn.toSorted(bySection)).toEqual(notDrawn.toSorted(bySection));
      expect(added).toHaveLength(notDrawn.reduce((sum, { instances }) => sum + instances, 0));
      for (const part of custom) {
        expect(part.partId).toMatch(customIdPattern(part.reference));
        expect(["mpd", "inlineDiffers"]).toContain(part.origin);
        expect(drawn.find(({ section }) => section === part.reference)?.instances).toBe(
          part.instances,
        );
      }
    }

    it.each(paletteModels.filter((model) => model.origin !== "omr"))(
      "$name imports with the sub-model tree and part transforms its bake recorded",
      async (model) => {
        const imports = await importedAndRecorded(model);
        const { imported, record } = imports;

        expectOnlyTheFilesCustomPartsAdded(imports);
        expect(record.authoredIdentification).toBeUndefined();
        expect(imported).toEqual({ ...record.submodels, partTransforms: record.partTransforms });
      },
      BUNDLE_MODEL_IMPORT_TIMEOUT_MS,
    );

    it.each(paletteModels.filter((model) => model.origin === "omr"))(
      "$name imports with its bake's sub-model tree and rotations, and positions within the OMR identification's reach of its identified record",
      async (model) => {
        const imports = await importedAndRecorded(model);
        const { imported, record } = imports;
        const depth = (submodel: number): number =>
          submodel === MODEL_ROOT ? 0 : 1 + depth(record.submodels.parent[submodel] ?? MODEL_ROOT);

        expectOnlyTheFilesCustomPartsAdded(imports);
        expect(record.authoredIdentification).toBeDefined();
        expect({ parent: imported.parent, ofPart: imported.ofPart }).toEqual({
          parent: record.submodels.parent,
          ofPart: record.submodels.ofPart,
        });
        expect(rotations(imported.matrices)).toEqual(rotations(record.submodels.matrices));
        expect(rotations(imported.partTransforms)).toEqual(rotations(record.partTransforms));
        expect(
          imported.ofPart.flatMap((holder, instance) =>
            translationShift(imported.partTransforms, record.partTransforms, instance) >
            (depth(holder) + 1) * OMR_IDENTIFICATION_REACH_LDU
              ? [instance]
              : [],
          ),
        ).toEqual([]);
      },
      BUNDLE_MODEL_IMPORT_TIMEOUT_MS,
    );
  },
);

const CC_BY_4 = "Licensed under CC BY 4.0 : see CAreadme.txt";
const NON_CA = "Not redistributable : see NonCAreadme.txt";
const UNOFFICIAL_PART = "0 !LDRAW_ORG Unofficial_Part";
const TRIANGLE = "3 16 0 0 0 20 0 0 0 0 20";
const OTHER_TRIANGLE = "3 16 0 0 0 40 0 0 0 0 40";
const LIBRARY_UNOFFICIAL = "parts/library-unofficial.dat";
const STUD_PITCH_LDU = 20;
const CUSTOM_SPACING_LDU = 4 * STUD_PITCH_LDU;
const GEOMETRY_LINE = /^(?:[1-5] |0 BFC (?!CERTIFY))/u;
const STUD_REFERENCE = / stud\.dat$/u;

type CustomPart = Extract<PartResolution, { kind: "custom" }>;

function customIdPattern(name: string): RegExp {
  return new RegExp(`^custom:[0-9a-f]{12}/${name.replaceAll(".", "\\.")}$`, "u");
}

function customHeader(name: string, license: string | null): string[] {
  return [
    `0 ${name} written for the import tests`,
    `0 Name: ${name}`,
    "0 Author: lug-layout tests [James Jessiman]",
    ...(license === null ? [] : [`0 !LICENSE ${license}`]),
    "0 BFC CERTIFY CCW",
  ];
}

function customFile(name: string, license: string | null, body: ReadonlyArray<string>): string[] {
  return [`0 FILE ${name}`, ...customHeader(name, license), ...body, "0 NOFILE"];
}

function modelOf(references: ReadonlyArray<string>, files: ReadonlyArray<string[]>): string {
  return [
    "0 FILE custom-parts.ldr",
    "0 Custom parts import test",
    "0 Name: custom-parts.ldr",
    "0 Author: lug-layout tests",
    "0 !LDRAW_ORG Model",
    ...references.map(
      (reference, i) => `1 4 ${i * CUSTOM_SPACING_LDU} 0 0 1 0 0 0 1 0 0 0 1 ${reference}`,
    ),
    "0 NOFILE",
    ...files.flat(),
    "",
  ].join("\n");
}

function drawnCustomParts(result: ImportResult): ReadonlyArray<CustomPart> {
  return result.report.parts.flatMap((part) => (part.kind === "custom" ? [part] : []));
}

async function pinnedGeometry(path: string): Promise<ReadonlyArray<string>> {
  const text = await readFile(new URL(path, pinnedLibrary), "utf8");
  return text.split(/\r?\n/u).filter((line) => GEOMETRY_LINE.test(line));
}

it("draws custom parts from the file as custom whatever their LDRAW_ORG, keeps an inline copy's measured difference, reports loose model geometry, and draws a copy whose quads only start elsewhere", async () => {
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
  const custom = drawnCustomParts(result);
  const customIds = ["mycustom.dat", "mycustom2.dat", "9999-1 - 3001.dat"].map((name) =>
    expect.stringMatching(customIdPattern(name)),
  );
  expect(custom.map((part) => part.partId)).toEqual(customIds);
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
  expect(result.partIds).toEqual(["ldraw:3001", ...customIds]);
  expect(result.compiled.map((part) => part.partId)).toEqual(customIds);
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

const mirrorWithAnUnofficialPart: FetchFunction = async (url) =>
  url.endsWith(`/${LIBRARY_UNOFFICIAL}`)
    ? new Response(
        [...customHeader("library-unofficial.dat", CC_BY_4), UNOFFICIAL_PART, TRIANGLE].join("\n"),
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
  const allowed = await importWith(mirrorWithAnUnofficialPart, "custom-parts.mpd", text, {
    unofficialAllowlist: [LIBRARY_UNOFFICIAL],
  });

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

it("draws a custom part whatever licence it names, or none, and whatever licence its own sub-file names", async () => {
  const result = await importWith(
    pinnedMirror,
    "custom-parts.mpd",
    modelOf(
      ["unlicensed.dat", "unofficial-nonca.dat", "licensed-top.dat"],
      [
        customFile("unlicensed.dat", null, [TRIANGLE]),
        customFile("unofficial-nonca.dat", NON_CA, [UNOFFICIAL_PART, TRIANGLE]),
        customFile("licensed-top.dat", CC_BY_4, ["1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\inner.dat"]),
        customFile("s/inner.dat", NON_CA, [TRIANGLE]),
      ],
    ),
  );

  expect(result.report.parts.map((part) => [part.reference, part.kind])).toEqual([
    ["unlicensed.dat", "custom"],
    ["unofficial-nonca.dat", "custom"],
    ["licensed-top.dat", "custom"],
  ]);
  expect(drawnCustomParts(result).map((part) => part.header.license)).toEqual([
    null,
    NON_CA,
    CC_BY_4,
  ]);
  expect(result.instanceCount).toBe(3);
  expect(result.compiled).toHaveLength(3);
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

  const [one] = drawnCustomParts(first);
  const [other] = drawnCustomParts(second);
  expect(first.bake?.studCover.studs).toBe(0);
  expect(one?.partId).toMatch(customIdPattern("shadowing.dat"));
  expect(other?.partId).toMatch(customIdPattern("shadowing.dat"));
  expect(other?.partId).not.toBe(one?.partId);
});

function studioPart(
  name: string,
  license: string | null,
  body: ReadonlyArray<string>,
): CustomSource {
  return { name, text: [...customHeader(name, license), ...body].join("\n") };
}

it("draws a Studio CustomParts file from its own sub-part as custom, under its Studio name even where the library has a part of that name, whatever licence it names", async () => {
  const result = await importWith(
    pinnedMirror,
    "custom-parts.io",
    [
      "1 4 0 0 0 1 0 0 0 1 0 0 0 1 studiobrick.dat",
      "1 2 80 0 0 1 0 0 0 1 0 0 0 1 unlicensed.dat",
      "1 14 160 0 0 1 0 0 0 1 0 0 0 1 3003.dat",
      "1 1 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat",
      "",
    ].join("\n"),
    {
      customFiles: [
        studioPart("studiobrick.dat", CC_BY_4, [
          "1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\studiobricks01.dat",
        ]),
        studioPart("s/studiobricks01.dat", CC_BY_4, [TRIANGLE]),
        studioPart("unlicensed.dat", null, [TRIANGLE]),
        studioPart("3003.dat", CC_BY_4, [OTHER_TRIANGLE]),
      ],
    },
  );

  expect(result.report.parts).toMatchObject([
    { reference: "studiobrick.dat", kind: "custom", origin: "studio" },
    { reference: "unlicensed.dat", kind: "custom", origin: "studio" },
    { reference: "3003.dat", kind: "custom", origin: "studio" },
    { reference: "3001.dat", kind: "bundle" },
  ]);
  expect(result.instanceCount).toBe(4);
});

it("refuses a Studio custom part whose own files refer to each other in a loop, rather than closing the loop with the library part of that name", async () => {
  const result = await importWith(
    pinnedMirror,
    "loop.io",
    "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3003.dat\n",
    {
      customFiles: [
        studioPart("3003.dat", CC_BY_4, ["1 16 0 0 0 1 0 0 0 1 0 0 0 1 s\\loop.dat"]),
        studioPart("s/loop.dat", CC_BY_4, [TRIANGLE, "1 16 0 -24 0 1 0 0 0 1 0 0 0 1 3003.dat"]),
      ],
    },
  );

  expect(result.report.parts).toMatchObject([
    { reference: "3003.dat", kind: "customRefused", origin: "studio", gate: "tooDeep" },
  ]);
  expect(result.instanceCount).toBe(0);
});

async function ownStudBrick(): Promise<ReadonlyArray<string[]>> {
  const [brick, lower, stud] = await Promise.all([
    pinnedGeometry("parts/3001.dat"),
    pinnedGeometry("parts/s/3001s01.dat"),
    pinnedGeometry("p/stud.dat"),
  ]);
  const walls = brick.filter((line) => !line.startsWith("1 "));
  const studs = lower.map((line) => line.replace(STUD_REFERENCE, " own-stud.dat"));
  return [
    customFile("own-stud-brick.dat", CC_BY_4, [...walls, ...studs]),
    customFile("own-stud.dat", CC_BY_4, stud),
  ];
}

const MIXED_STUDS = [
  "stud.dat",
  "stud2a.dat",
  "stud3a.dat",
  "stud10.dat",
  "stud15.dat",
  "stud.dat",
  "stud.dat",
  "stud.dat",
];
const BRICK_STUD_X_LDU = [-30, -10, 10, 30];
const BRICK_STUD_Z_LDU = [-10, 10];
const PLACED_X_TOKEN = 2;
const PLACED_Z_TOKEN = 4;

interface MixedStudBrick {
  readonly file: string[];
  readonly studs: ReadonlyArray<{ readonly primitive: string; readonly slot: string }>;
}

async function mixedStudBrick(): Promise<MixedStudBrick> {
  const [brick, lower] = await Promise.all([
    pinnedGeometry("parts/3001.dat"),
    pinnedGeometry("parts/s/3001s01.dat"),
  ]);
  const walls = brick.filter((line) => !line.startsWith("1 "));
  const studs: Array<{ readonly primitive: string; readonly slot: string }> = [];
  const body = lower.map((line) => {
    if (!STUD_REFERENCE.test(line)) return line;
    const primitive = MIXED_STUDS[studs.length] ?? "stud.dat";
    const tokens = line.split(" ");
    studs.push({
      primitive,
      slot: upwardStud(Number(tokens[PLACED_X_TOKEN]), Number(tokens[PLACED_Z_TOKEN])),
    });
    return line.replace(STUD_REFERENCE, ` ${primitive}`);
  });
  return { file: customFile("mixed-stud-brick.dat", CC_BY_4, [...walls, ...body]), studs };
}

async function customBricks(): Promise<string> {
  return modelOf(
    ["stud-brick.dat", "own-stud-brick.dat", "mixed-stud-brick.dat", "nonca-brick.dat"],
    [
      customFile("stud-brick.dat", CC_BY_4, await pinnedGeometry("parts/3001.dat")),
      ...(await ownStudBrick()),
      (await mixedStudBrick()).file,
      customFile("nonca-brick.dat", NON_CA, await pinnedGeometry("parts/3001.dat")),
    ],
  );
}

function upwardStud(ldrawX: number, ldrawZ: number): string {
  return `${ldrawX * SIXTEENTHS_PER_LDU} 0 ${-ldrawZ * SIXTEENTHS_PER_LDU} ${AXIS_POS_Y}`;
}

const BRICK_STUDS = BRICK_STUD_X_LDU.flatMap((x) =>
  BRICK_STUD_Z_LDU.map((z) => upwardStud(x, z)),
).toSorted();

function maleSlots(connectors: PartConnectors, source: number): ReadonlyArray<string> {
  const slots: string[] = [];
  for (let face = 0; face < connectors.count; face++) {
    if (connectors.gender[face] !== GENDER_MALE || connectors.source[face] !== source) continue;
    const at = face * 3;
    slots.push(
      `${[0, 1, 2].map((k) => connectors.origin[at + k]).join(" ")} ${connectors.axis[face]}`,
    );
  }
  return slots.toSorted();
}

function connectorsOf(result: ImportResult, part: CustomPart | undefined): PartConnectors {
  const connectors = part && result.connectors[result.partIds.indexOf(part.partId)];
  if (!connectors) throw new Error(`${part?.reference ?? "a custom part"} has no connector table`);
  return connectors;
}

const STUD_SOURCE: Readonly<Record<string, number>> = {
  "stud.dat": CONNECTOR_SOURCE.shadow,
  "stud2a.dat": CONNECTOR_SOURCE.shadow,
  "stud10.dat": CONNECTOR_SOURCE.shadow,
  "stud15.dat": CONNECTOR_SOURCE.shadow,
  "stud3a.dat": CONNECTOR_SOURCE.primitive,
};

it("reads custom parts' connectors at import in tier order, each stud from the shadow library where it has a snap, else the primitive table, else geometry, all flagged unverified, whatever licence the part names", async () => {
  const result = await importWith(pinnedMirror, "custom-bricks.mpd", await customBricks(), {
    shadowLibrary: await pinnedShadowLibrary(),
  });
  const [studBrick, ownStuds, mixedStuds, nonCaBrick] = drawnCustomParts(result);
  const shadow = connectorsOf(result, studBrick);
  const nonCa = connectorsOf(result, nonCaBrick);
  const inferred = connectorsOf(result, ownStuds);
  const mixed = connectorsOf(result, mixedStuds);
  const { studs } = await mixedStudBrick();
  const mixedFrom = (source: number) =>
    studs
      .filter(({ primitive }) => STUD_SOURCE[primitive] === source)
      .map(({ slot }) => slot)
      .toSorted();

  expect(result.report.parts.map((part) => [part.reference, part.kind])).toEqual([
    ["stud-brick.dat", "custom"],
    ["own-stud-brick.dat", "custom"],
    ["mixed-stud-brick.dat", "custom"],
    ["nonca-brick.dat", "custom"],
  ]);
  expect(maleSlots(shadow, CONNECTOR_SOURCE.shadow)).toEqual(BRICK_STUDS);
  expect(maleSlots(nonCa, CONNECTOR_SOURCE.shadow)).toEqual(BRICK_STUDS);
  expect(maleSlots(inferred, CONNECTOR_SOURCE.shadow)).toEqual([]);
  expect(maleSlots(inferred, CONNECTOR_SOURCE.inferred)).toEqual(BRICK_STUDS);
  for (const source of [
    CONNECTOR_SOURCE.shadow,
    CONNECTOR_SOURCE.primitive,
    CONNECTOR_SOURCE.inferred,
  ]) {
    expect(maleSlots(mixed, source)).toEqual(mixedFrom(source));
  }
  expect(mixedStuds?.connectors?.bySource.primitive).toBe(
    mixedFrom(CONNECTOR_SOURCE.primitive).length,
  );
  for (const table of [shadow, inferred, mixed, nonCa]) {
    expect(new Set(table.status)).toEqual(new Set([CONNECTOR_STATUS.unverified]));
  }
  expect(result.report.refusedConnectorRecords).toEqual([]);
  expect(result.report.withoutConnectorRecords).toEqual([]);
});

const UNREADABLE_SHADOW_LIBRARY: IShadowLibrary = {
  manifest: async () => {
    throw new Error("GET shadow-library.json failed with 503");
  },
  probe: async () => {
    throw new Error("the import probed an unreadable shadow library");
  },
  stats: () => ({ fetched: 0, cached: 0, bytes: 0 }),
};
const UNREADABLE_REASON =
  "the pinned shadow library could not be read: GET shadow-library.json failed with 503";

const CUSTOM_BRICK_IDS = [
  "stud-brick.dat",
  "own-stud-brick.dat",
  "mixed-stud-brick.dat",
  "nonca-brick.dat",
].map((name) => expect.stringMatching(customIdPattern(name)));

interface WithoutTables {
  readonly when: string;
  readonly shadowLibrary: "none" | "pinned" | "unreadable";
  readonly withoutPrimitiveTable: boolean;
  readonly refused: boolean;
}

it.each<WithoutTables>([
  {
    when: "without a shadow library, listing them as without records",
    shadowLibrary: "none",
    withoutPrimitiveTable: false,
    refused: false,
  },
  {
    when: "without a primitive table, listing them as without records",
    shadowLibrary: "pinned",
    withoutPrimitiveTable: true,
    refused: false,
  },
  {
    when: "when the shadow library cannot be read, saying why",
    shadowLibrary: "unreadable",
    withoutPrimitiveTable: false,
    refused: true,
  },
])("draws custom parts with no connector table $when", async (setup) => {
  const shadowLibrary = {
    none: undefined,
    pinned: await pinnedShadowLibrary(),
    unreadable: UNREADABLE_SHADOW_LIBRARY,
  }[setup.shadowLibrary];
  const result = await importWith(pinnedMirror, "custom-bricks.mpd", await customBricks(), {
    ...(shadowLibrary === undefined ? {} : { shadowLibrary }),
    withoutPrimitiveTable: setup.withoutPrimitiveTable,
  });

  expect(drawnCustomParts(result).map((part) => part.connectors)).toEqual([null, null, null, null]);
  expect(result.partIds).toEqual(CUSTOM_BRICK_IDS);
  expect(result.connectors).toEqual([null, null, null, null]);
  expect(result.report.withoutConnectorRecords).toEqual(setup.refused ? [] : CUSTOM_BRICK_IDS);
  expect(result.report.refusedConnectorRecords).toEqual(
    setup.refused ? CUSTOM_BRICK_IDS.map((partId) => ({ partId, reason: UNREADABLE_REASON })) : [],
  );
});

type Layout = ReadonlyArray<readonly [string, number, number]>;

function seatedOn(references: Layout): string {
  return references
    .map(([reference, x, y]) => `1 4 ${x} ${y} 0 1 0 0 0 1 0 0 0 1 ${reference}`)
    .join("\n");
}

async function matesIn(result: ImportResult): Promise<number> {
  const shapes = new SnapShapes();
  const tables = result.connectors.map((connectors, index) =>
    connectors === null
      ? null
      : ConnectorTable.fromColumns(connectors, shapes, result.partIds[index] ?? ""),
  );
  return ModelConnectors.fromParts(
    tables,
    {
      count: result.instanceCount,
      partIndex: result.partIndex,
      matrices: result.partTransforms,
      submodels: result.submodels,
    },
    new SnapMating(shapes),
  ).internalMates;
}

function onBaseplate(brick: string): Layout {
  return [
    ["3867.dat", 0, 0],
    [brick, 0, -BRICK_LDU],
  ];
}

function underABrick(brick: string): Layout {
  return [
    [brick, 0, 0],
    ["3001.dat", 0, -BRICK_LDU],
  ];
}

it("seats custom bricks, whatever licence they name, on a bundle baseplate and takes a brick on their inferred studs exactly as official 3001 does", async () => {
  const shadowLibrary = await pinnedShadowLibrary();
  const custom = async (layout: Layout) =>
    importWith(
      pinnedMirror,
      "seated.mpd",
      [
        "0 FILE seated.ldr",
        "0 !LDRAW_ORG Model",
        seatedOn(layout),
        "0 NOFILE",
        ...customFile("stud-brick.dat", CC_BY_4, await pinnedGeometry("parts/3001.dat")),
        ...customFile("nonca-brick.dat", NON_CA, await pinnedGeometry("parts/3001.dat")),
        ...(await ownStudBrick()).flat(),
        "",
      ].join("\n"),
      { shadowLibrary },
    );
  const official = await matesIn(await custom(onBaseplate("3001.dat")));
  const stacked = await matesIn(await custom(underABrick("3001.dat")));

  expect(official).toBeGreaterThan(0);
  expect(stacked).toBeGreaterThan(0);
  expect(await matesIn(await custom(onBaseplate("stud-brick.dat")))).toBe(official);
  expect(await matesIn(await custom(onBaseplate("nonca-brick.dat")))).toBe(official);
  expect(await matesIn(await custom(underABrick("own-stud-brick.dat")))).toBe(stacked);
});

const CUSTOM_JUMPER_BENCH = [
  "0 Bench of two jumpers under a tile, built for the lattice test",
  "0 Name: custom-jumper-bench.ldr",
  "0 Author: lug-layout tests",
  "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
  "1 4 -30 0 0 1 0 0 0 1 0 0 0 1 3794b.dat",
  "1 4 10 0 0 1 0 0 0 1 0 0 0 1 3794b.dat",
  "1 15 0 -8 0 1 0 0 0 1 0 0 0 1 2431.dat",
];

const CUSTOM_TABLE_ON_ROUND_PLATES = [
  "0 Table standing on four 1 x 1 round plates, built for the lattice test",
  "0 Name: custom-table-on-round-plates.ldr",
  "0 Author: lug-layout tests",
  "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
  "1 4 -10 0 -10 1 0 0 0 1 0 0 0 1 6141.dat",
  "1 4 10 0 -10 1 0 0 0 1 0 0 0 1 6141.dat",
  "1 4 -10 0 10 1 0 0 0 1 0 0 0 1 6141.dat",
  "1 4 10 0 10 1 0 0 0 1 0 0 0 1 6141.dat",
  "1 15 0 -8 0 1 0 0 0 1 0 0 0 1 3022.dat",
];

const CUSTOM_JUMPER_BESIDE_A_PLATE = [
  "0 Jumper beside a 1 x 1 plate, whose two studs tie, built for the lattice test",
  "0 Name: custom-jumper-beside-a-plate.ldr",
  "0 Author: lug-layout tests",
  "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
  "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3794b.dat",
  "1 15 10 0 20 1 0 0 0 1 0 0 0 1 3024.dat",
];

async function importedPhase(name: string, lines: ReadonlyArray<string>) {
  const { bake } = await importWith(pinnedMirror, name, [...lines, ""].join("\n"));
  return bake?.lattice ? [bake.lattice.phaseX, bake.lattice.phaseZ] : null;
}

it(
  "phases a model by its studs where they seat on a stud field and by the receptors it stands on where only those do: a round plate and a custom table on round plates keep their studs; a studless tile, a jumper, a custom bench of jumpers and a custom jumper beside a plate, whose studs tie, take their receptors",
  async () => {
    expect({
      roundPlate: await importedPhase("round-plate.ldr", ["1 4 0 0 0 1 0 0 0 1 0 0 0 1 6141.dat"]),
      table: await importedPhase("custom-table-on-round-plates.ldr", CUSTOM_TABLE_ON_ROUND_PLATES),
      tile: await importedPhase("tile.ldr", ["1 15 0 0 0 1 0 0 0 1 0 0 0 1 3069b.dat"]),
      jumper: await importedPhase("jumper.ldr", ["1 4 0 0 0 1 0 0 0 1 0 0 0 1 3794b.dat"]),
      bench: await importedPhase("custom-jumper-bench.ldr", CUSTOM_JUMPER_BENCH),
      jumperBesideAPlate: await importedPhase(
        "custom-jumper-beside-a-plate.ldr",
        CUSTOM_JUMPER_BESIDE_A_PLATE,
      ),
    }).toEqual({
      roundPlate: [0, 0],
      table: [10, 10],
      tile: [10, 0],
      jumper: [10, 0],
      bench: [0, 0],
      jumperBesideAPlate: [10, 0],
    });
  },
  BAKE_TIMEOUT_MS,
);

const CUSTOM_BENCH_BESIDE_A_CURVED_WEDGE = [
  "0 Bench of two jumpers under a tile, beside a 4 x 4 curved wedge, built for the lattice test",
  "0 Name: custom-bench-beside-a-curved-wedge.ldr",
  "0 Author: lug-layout tests",
  "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
  ...CUSTOM_JUMPER_BENCH.slice(4),
  "1 1 90 -8 0 1 0 0 0 1 0 0 0 1 45677.dat",
];

const CUSTOM_BENCH_BESIDE_A_NOTCHED_CORNER = [
  "0 Bench of two jumpers under a tile, beside a corner round brick with a stud notch, built for the lattice test",
  "0 Name: custom-bench-beside-a-notched-corner.ldr",
  "0 Author: lug-layout tests",
  "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
  ...CUSTOM_JUMPER_BENCH.slice(4),
  "1 1 100 -16 0 1 0 0 0 1 0 0 0 1 3063b.dat",
];

it(
  "seats a stud by the connector records of the receptor it enters where the drawn cavity is tighter than the stud: a studless corner panel and a custom bench beside a curved wedge take their receptor frames, as the pipeline bakes them, while a bench beside a stud notch drawn inside the stud still falls back",
  async () => {
    expect({
      cornerPanel: await importedPhase("corner-panel.ldr", [
        "1 4 0 0 0 1 0 0 0 1 0 0 0 1 91501.dat",
      ]),
      besideACurvedWedge: await importedPhase(
        "custom-bench-beside-a-curved-wedge.ldr",
        CUSTOM_BENCH_BESIDE_A_CURVED_WEDGE,
      ),
      besideANotchedCorner: await importedPhase(
        "custom-bench-beside-a-notched-corner.ldr",
        CUSTOM_BENCH_BESIDE_A_NOTCHED_CORNER,
      ),
    }).toEqual({
      cornerPanel: [0, 0],
      besideACurvedWedge: [0, 0],
      besideANotchedCorner: [10, 0],
    });
  },
  BAKE_TIMEOUT_MS,
);

it(
  "bakes a generated jumper to the lattice the pipeline baked for it, framed on both paths by the anti-studs it stands on rather than its centre stud",
  async () => {
    const manifest = JSON.parse(
      await readFile(new URL("manifest.json", fixtureBundleRoot), "utf8"),
    ) as Manifest;
    const entry = manifest.models.find((model) => model.name === JUMPER_FIXTURE_MODEL);
    if (!entry) throw new Error(`the fixture bundle has no ${JUMPER_FIXTURE_MODEL}`);
    const bundled = JSON.parse(
      await readFile(new URL(entry.file, fixtureBundleRoot), "utf8"),
    ) as BundledModel;

    const { bake } = await importWith(
      pinnedMirror,
      "jumper.ldr",
      await readFile(jumperScene, "utf8"),
    );

    expect(bundled.lattice?.phase).toEqual([10, 0]);
    expect(bake?.lattice).toEqual({
      phaseX: bundled.lattice?.phase[0],
      phaseZ: bundled.lattice?.phase[1],
      aabbMin: bundled.lattice?.aabb.min,
      aabbMax: bundled.lattice?.aabb.max,
    });
  },
  BAKE_TIMEOUT_MS,
);

it.each([0, 2])(
  "bakes an imported file to the same lattice, stud cover, footprint, columns and instance footing as the bundle's own bake of that file, with %i helper reactors",
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
      { helpers: await reactorHelpers(helperReactors) },
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
    if (cells === null) throw new Error("the bundled model has no cells");
    const { partCells, ...columns } = cells;
    expect(
      bake?.cells && {
        origin: [bake.cells.originX, bake.cells.originZ],
        size: [bake.cells.width, bake.cells.depth],
        bottomY: bake.cells.restY,
        footprint: [...bake.cells.footprint],
        flat: [...bake.cells.flat],
        columnBottom: [...bake.cells.columnBottom],
        columnTop: [...bake.cells.columnTop],
        footing: {
          instance: [...bake.cells.footing.instance],
          cell: [...bake.cells.footing.cell],
        },
      },
    ).toEqual(columns);
    expect(bake?.cells?.partCells).toEqual(
      partCells &&
        modelPartCells(
          partCells.cell,
          partCells.instance,
          partCells.boxes,
          cells.size[0] * cells.size[1],
          "the bundled model",
        ),
    );
  },
  BAKE_TIMEOUT_MS,
);

it(
  "bakes a custom file the same when helpers crash, never answer or ask for files the primary holds, with the primary baking their slices",
  async () => {
    const text = await readFile(customPileFile, "utf8");
    const alone = await importWith(pinnedMirror, "custom-pile.ldr", text);
    const failing = await importWith(pinnedMirror, "custom-pile.ldr", text, {
      helpers: [...(await reactorHelpers(1)), crashingHelper, silentHelper, outOfSyncHelper],
    });

    expect(alone.bake?.studCover.covered).toBeGreaterThan(0);
    expect(alone.bake?.studCover.covered).toBeLessThan(alone.bake?.studCover.studs ?? 0);
    expect(alone.report.bakeHelpersFailed).toBe(0);
    expect(failing.report.bakeHelpersFailed).toBe(3);
    expect(failing.bake).toEqual(alone.bake);
  },
  BAKE_TIMEOUT_MS,
);

it(
  "bakes footing for each of an imported file's own instances, so a wall keeps the cell a track end's joiner also reaches",
  async () => {
    const result = await importWith(
      pinnedMirror,
      "custom-run-and-wall.ldr",
      [
        "0 Custom run with a wall at its far end",
        "0 Name: custom-run-and-wall.ldr",
        "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
        "1 16 0 0 0 1 0 0 0 1 0 0 0 1 74746.dat",
        "1 16 320 0 0 1 0 0 0 1 0 0 0 1 74746.dat",
        "1 4 490 -16 50 1 0 0 0 1 0 0 0 1 3005.dat",
        "1 4 580 -16 0 1 0 0 0 1 0 0 0 1 3001.dat",
        "1 4 580 -40 0 1 0 0 0 1 0 0 0 1 3001.dat",
        "",
      ].join("\n"),
    );
    const footing = result.bake?.cells?.footing;
    if (!footing) throw new Error("the run and wall bake no cells");
    const cellsOf = (instance: number) =>
      [...footing.cell].filter((_, k) => footing.instance[k] === instance);
    const partOf = (instance: number) => result.partIds[result.partIndex[instance] ?? -1];

    expect([0, 1, 2, 3, 4].map(partOf)).toEqual([
      "ldraw:74746",
      "ldraw:74746",
      "ldraw:3005",
      "ldraw:3001",
      "ldraw:3001",
    ]);
    const [wall] = cellsOf(2);
    expect(cellsOf(2)).toHaveLength(1);
    expect(cellsOf(1)).toContain(wall);
    expect(cellsOf(3)).toHaveLength(8);
    expect(cellsOf(4)).toEqual([]);
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

it(
  "reads the top surface of a part the bundle doesn't hold when the import compiles it",
  async () => {
    const result = await importWith(
      customMirror,
      "recessed.ldr",
      "0 A plate with a recessed stud\n1 16 0 0 0 1 0 0 0 1 0 0 0 1 zz-custom-recessed-plate.dat\n",
    );

    const [compiled] = result.compiled;
    if (!compiled) throw new Error("the import compiled no part");
    const { topSurface } = parseGlb(compiled.glb.slice().buffer, compiled.partId).document.extras;
    expect(topSurface).toEqual({
      stepsPerLdu: SIXTEENTHS_PER_LDU,
      top: 16 * SIXTEENTHS_PER_LDU,
      origin: [-30 * SIXTEENTHS_PER_LDU, -30 * SIXTEENTHS_PER_LDU],
      size: [3, 3],
      cells: ["fff", "fpf", "fff"],
    });
  },
  BAKE_TIMEOUT_MS,
);

it("reports, without drawing, a part when the stud primitives draw no ring to measure roundness by", async () => {
  const result = await importWith(
    pinnedMirror,
    "wheelset.ldr",
    "1 0 0 0 0 1 0 0 0 1 0 0 0 1 70720c01.dat\n",
    { studPrimitives: ["not-a-stud.dat"] },
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

const HUB_FAR_APART_LDU = 10_000_000;
const FACET_HALF_LDU = 1_000_000;
const VAST_SIDE_LDU = 171_798_691_840;
const SIDE_JUST_BEYOND_WASM32_LDU = 231_700;
const SIDE_JUST_WITHIN_WASM32_LDU = 231_680;
const BRICKS_APART_LDU = 1_000_000;
const STUD_LDU = 20;
const HALF_BRICK_2X4_LDU = 40;
const HALF_BRICK_2X2_LDU = 20;
const HALF_BRICK_DEPTH_LDU = 20;

function square(side: number): ReadonlyArray<string> {
  return [`4 16 0 0 0 ${side} 0 0 ${side} 0 ${side} 0 0 ${side}`];
}

function customPart(name: string, lines: ReadonlyArray<string>): string {
  return [`0 Custom ${name}`, `0 Name: ${name}`, CA_LICENSE, "0 BFC CERTIFY CCW", ...lines].join(
    "\n",
  );
}

const largeCustomParts = new Map([
  [
    "parts/zz-custom-oversized-facet.dat",
    customHub("zz-custom-oversized-facet.dat", [
      `3 16 -${FACET_HALF_LDU} 40 -${FACET_HALF_LDU} 0 40 ${FACET_HALF_LDU} ${FACET_HALF_LDU} 40 -${FACET_HALF_LDU}`,
    ]),
  ],
  [
    "parts/zz-custom-far-hubs.dat",
    customPart("zz-custom-far-hubs.dat", [
      "1 16 0 0 0 1 0 0 0 1 0 0 0 1 zz-custom-round-hub.dat",
      `1 16 ${HUB_FAR_APART_LDU} 0 ${HUB_FAR_APART_LDU} 1 0 0 0 1 0 0 0 1 zz-custom-round-hub.dat`,
    ]),
  ],
  [
    "parts/zz-custom-vast-square.dat",
    customPart("zz-custom-vast-square.dat", square(VAST_SIDE_LDU)),
  ],
  [
    "parts/zz-custom-square-within-wasm32.dat",
    customPart("zz-custom-square-within-wasm32.dat", square(SIDE_JUST_WITHIN_WASM32_LDU)),
  ],
  ["parts/square.dat", customPart("square.dat", square(SIDE_JUST_BEYOND_WASM32_LDU))],
]);

const largeCustomMirror: FetchFunction = async (url) => {
  const path = /\/ldraw\/(?<path>.+)$/u.exec(url)?.groups?.["path"];
  const custom = path === undefined ? undefined : largeCustomParts.get(path);
  return custom === undefined ? customMirror(url) : new Response(custom);
};

function tooLarge(
  name: string,
  extentLdu: number,
  cause: "beyondAddressSpace" | "memoryUnavailable",
  because: string,
) {
  const cells = Math.floor(extentLdu / STUD_LDU) + 1;
  return {
    kind: "tooLarge",
    reference: name,
    official: name,
    instances: 1,
    cause,
    message: `parts/${name} spans ${extentLdu} × ${extentLdu} LDU, and a stud cover of ${cells} × ${cells} cells ${because}`,
  };
}

const BEYOND_WASM32 = "needs more memory than the 32-bit WASM compiler can address";
const MEMORY_UNAVAILABLE = "needs more memory than this machine could reserve";

it(
  "reports, without drawing, custom parts whose stud cover a 32-bit compiler cannot address, and imports the rest exactly as without them",
  async () => {
    const kept = [
      "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
      "1 1 80 0 0 1 0 0 0 1 0 0 0 1 zz-custom-round-hub.dat",
    ];
    const large = [
      "1 2 160 0 0 1 0 0 0 1 0 0 0 1 zz-custom-oversized-facet.dat",
      "1 2 240 0 0 1 0 0 0 1 0 0 0 1 zz-custom-far-hubs.dat",
      "1 2 320 0 0 1 0 0 0 1 0 0 0 1 zz-custom-vast-square.dat",
      "1 2 400 0 0 1 0 0 0 1 0 0 0 1 zz-custom-square-within-wasm32.dat",
    ];

    const control = await importWith(largeCustomMirror, "control.ldr", kept.join("\n"));
    const result = await importWith(largeCustomMirror, "large.ldr", [...kept, ...large].join("\n"));

    expect(result.report.parts.slice(2)).toEqual([
      tooLarge(
        "zz-custom-oversized-facet.dat",
        2 * FACET_HALF_LDU,
        "beyondAddressSpace",
        BEYOND_WASM32,
      ),
      tooLarge(
        "zz-custom-far-hubs.dat",
        HUB_FAR_APART_LDU + 2 * HALF_BRICK_2X2_LDU,
        "beyondAddressSpace",
        BEYOND_WASM32,
      ),
      tooLarge("zz-custom-vast-square.dat", VAST_SIDE_LDU, "beyondAddressSpace", BEYOND_WASM32),
      tooLarge(
        "zz-custom-square-within-wasm32.dat",
        SIDE_JUST_WITHIN_WASM32_LDU,
        "memoryUnavailable",
        MEMORY_UNAVAILABLE,
      ),
    ]);
    expect(result.report.parts.slice(0, 2)).toEqual(control.report.parts);
    expect(result.partIds).toEqual(control.partIds);
    expect(result.instanceCount).toBe(control.instanceCount);
    expect(result.report.bakeIssue).toBeNull();
    expect(result.bake).toEqual(control.bake);
  },
  BAKE_TIMEOUT_MS,
);

it("refuses a part whose stud cover the 32-bit WASM compiler cannot address with the message the native compiler gives", async () => {
  const result = await importWith(
    largeCustomMirror,
    "square.ldr",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 square.dat\n",
  );

  expect(result.report.parts).toEqual([
    {
      kind: "tooLarge",
      reference: "square.dat",
      official: "square.dat",
      instances: 1,
      cause: "beyondAddressSpace",
      message:
        "parts/square.dat spans 231700 × 231700 LDU, and a stud cover of 11586 × 11586 cells needs more memory than the 32-bit WASM compiler can address",
    },
  ]);
});

it(
  "fails the bake softly, naming both parts and how far apart they are, when their stud cover a 32-bit compiler cannot address",
  async () => {
    const text = [
      "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
      `1 4 ${BRICKS_APART_LDU} 0 ${BRICKS_APART_LDU} 1 0 0 0 1 0 0 0 1 3003.dat`,
    ].join("\n");
    const cellsApart = BRICKS_APART_LDU / STUD_LDU;

    const result = await importWith(pinnedMirror, "far-apart.ldr", text);

    expect(result.instanceCount).toBe(2);
    expect(result.bake).toBeNull();
    expect(result.report.bakeIssue).toBe(
      `the drawn parts span ${BRICKS_APART_LDU + HALF_BRICK_2X4_LDU + HALF_BRICK_2X2_LDU} LDU from 3001.dat to 3003.dat along x and ${BRICKS_APART_LDU + HALF_BRICK_DEPTH_LDU + HALF_BRICK_2X2_LDU} LDU from 3003.dat to 3001.dat along z, and a stud cover of ${cellsApart + 3} × ${cellsApart + 2} cells ${BEYOND_WASM32}`,
    );
  },
  BAKE_TIMEOUT_MS,
);

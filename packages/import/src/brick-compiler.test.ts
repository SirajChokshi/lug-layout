import {
  decodePlanGlyph,
  SectionVocabularyFile,
  type CompilerGlyphInputs,
  type PlanGlyph,
} from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  BrickCompiler,
  type BakedModel,
  type BakeInputs,
  type BakeRequest,
  type CompileLod,
  type CompileOutput,
  type CompileRequest,
  type LibraryFiles,
  type PlacementBakeRequest,
  type RecordFiles,
  type VisibilityBakeRequest,
} from "./brick-compiler.ts";
import { bakeReceptors } from "./bake-receptors.ts";

const bundleRoot = new URL("../../../tools/asset-pipeline/dist/bundle/standard/", import.meta.url);
const pinnedLibrary = fileURLToPath(new URL("../../../.cache/ldraw/", import.meta.url));
const RECORD_MAGIC = "BRRBAKE1";
const PARTS = ["3001.dat", "3040b.dat", "3626c.dat"];
const COMPILE_TIMEOUT_MS = 60_000;
const STACKED_BESIDE_A_SLOPE = [
  "0 two stacked bricks beside a slope",
  "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 1 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 2 80 0 0 1 0 0 0 1 0 0 0 1 3040b.dat",
  "",
].join("\n");
const BRICK_ON_SLOPE = [
  "0 a slope on a brick",
  "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 1 0 -24 0 1 0 0 0 1 0 0 0 1 3040b.dat",
  "",
].join("\n");

interface Manifest {
  readonly studPrimitives: ReadonlyArray<{ readonly name: string }>;
  readonly compiler: {
    readonly file: string;
    readonly primitives?: CompileRequest["connectors"]["primitives"];
    readonly sectionVocabulary: { readonly file: string };
    readonly cavityProbe: string;
  };
  readonly tablePlane: { readonly depthBelowTopLdu: number };
}

async function libraryPaths(): Promise<Map<string, string>> {
  const paths = new Map<string, string>();
  for (const entry of await readdir(pinnedLibrary, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    paths.set(relative(pinnedLibrary, path).replaceAll("\\", "/").toLowerCase(), path);
  }
  return paths;
}

async function bundleCompiler(): Promise<{
  manifest: Manifest;
  compiler: BrickCompiler;
  vocabulary: SectionVocabularyFile;
}> {
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", bundleRoot), "utf8"),
  ) as Manifest;
  const compiler = new BrickCompiler(
    new WebAssembly.Module(await readFile(new URL(manifest.compiler.file, bundleRoot))),
  );
  const vocabularyFile = new URL(manifest.compiler.sectionVocabulary.file, bundleRoot);
  const vocabulary = decodedOrThrow(
    decode(SectionVocabularyFile, JSON.parse(await readFile(vocabularyFile, "utf8"))),
    vocabularyFile.pathname,
  );
  return { manifest, compiler, vocabulary };
}

interface HeldLibrary extends LibraryFiles {
  readonly files: Map<string, string>;
  readonly absent: Set<string>;
}

async function hold(
  library: HeldLibrary,
  paths: ReadonlyMap<string, string>,
  requested: ReadonlyArray<string>,
): Promise<void> {
  for (const path of requested) {
    const file = paths.get(path);
    if (file === undefined) library.absent.add(path);
    else library.files.set(path, await readFile(file, "utf8"));
  }
}

async function compileAll(
  lod: CompileLod,
  records: boolean,
  glyphs: CompilerGlyphInputs | null = null,
): Promise<CompileOutput> {
  const { manifest, compiler, vocabulary } = await bundleCompiler();
  const paths = await libraryPaths();
  const library: HeldLibrary = { key: "records", files: new Map(), absent: new Set() };
  const request = {
    lod,
    studPrimitives: manifest.studPrimitives.map((primitive) => primitive.name),
    unofficialAllowlist: [],
    connectors: {
      primitives: manifest.compiler.primitives ?? null,
      sectionVocabulary: { sizes: vocabulary.sizes, lengths: vocabulary.lengths },
      cavityProbe: manifest.compiler.cavityProbe,
      infer: [],
      shadowPatchManifest: null,
    },
    parts: PARTS,
    model: "",
    inlineChecks: [],
    records,
    ...(glyphs === null ? {} : { glyphs }),
  };
  let output = compiler.compile(request, library);
  for (;;) {
    const requested = output.parts.flatMap((outcome) =>
      outcome.status === "need" ? outcome.paths : [],
    );
    if (requested.length === 0) return output;
    await hold(library, paths, requested);
    output = compiler.compile(request, library);
  }
}

it(
  "a standard compile asked for records returns each part's bake record beside its GLB",
  async () => {
    const [withRecords, without] = await Promise.all([
      compileAll("standard", true),
      compileAll("standard", false),
    ]);
    for (const [index, outcome] of withRecords.parts.entries()) {
      const plain = without.parts[index];
      if (outcome.status !== "compiled" || plain?.status !== "compiled") {
        throw new Error(`${PARTS[index]} did not compile`);
      }
      expect(new TextDecoder().decode(outcome.record?.subarray(0, RECORD_MAGIC.length))).toBe(
        RECORD_MAGIC,
      );
      expect(outcome.glb).toEqual(plain.glb);
      expect(plain.record).toBeNull();
    }
  },
  COMPILE_TIMEOUT_MS,
);

it(
  "records are refused at any LOD but the standard one the bake reads",
  async () => {
    await expect(compileAll("low", true)).rejects.toThrow("standard LOD");
  },
  COMPILE_TIMEOUT_MS,
);

async function baked(
  compiler: BrickCompiler,
  request: BakeRequest,
  library: HeldLibrary,
  paths: ReadonlyMap<string, string>,
  records: RecordFiles | null,
): Promise<BakedModel> {
  for (;;) {
    const outcome = compiler.bake(request, library, records);
    if (outcome.status === "baked") return outcome;
    if (outcome.status === "failed") throw new Error(outcome.message);
    await hold(library, paths, outcome.paths);
  }
}

it(
  "a placement bake keeps its parts for the cover bake that follows, which frees them, and the two make the whole bake",
  async () => {
    const recorded = await compileAll("standard", true);
    const recordOf = (part: string): Uint8Array => {
      const outcome = recorded.parts[PARTS.indexOf(part)];
      if (outcome?.status !== "compiled" || outcome.record === null) {
        throw new Error(`${part} has no record`);
      }
      return outcome.record;
    };
    const both: RecordFiles = {
      key: "pinned",
      files: new Map([
        ["3001.dat", recordOf("3001.dat")],
        ["3040b.dat", recordOf("3040b.dat")],
      ]),
    };
    const brickOnly: RecordFiles = {
      key: "pinned",
      files: new Map([["3001.dat", recordOf("3001.dat")]]),
    };
    const { manifest, compiler } = await bundleCompiler();
    const paths = await libraryPaths();
    const library: HeldLibrary = { key: "split", files: new Map(), absent: new Set() };
    const inputs: BakeInputs = {
      source: STACKED_BESIDE_A_SLOPE,
      drawn: new Uint8Array([1, 1, 1]),
      studPrimitives: manifest.studPrimitives.map((primitive) => primitive.name),
      unofficialAllowlist: [],
      translucentColors: [],
      tableDepthLdu: manifest.tablePlane.depthBelowTopLdu,
      vehicles: null,
    };
    const request: PlacementBakeRequest = {
      ...inputs,
      receptors: bakeReceptors(new Uint32Array(3), [null]),
    };
    const placementRequest: PlacementBakeRequest = {
      ...request,
      shard: { from: 0, to: 0, of: 1, visibilityOnly: false },
      keepParts: true,
    };
    const coverRequest: VisibilityBakeRequest = {
      ...inputs,
      shard: { from: 0, to: 1, of: 1, visibilityOnly: true },
    };

    const whole = await baked(compiler, request, library, paths, both);
    const placement = await baked(compiler, placementRequest, library, paths, both);
    const cover = await baked(compiler, coverRequest, library, paths, both);
    const again = await baked(compiler, coverRequest, library, paths, both);
    await baked(compiler, coverRequest, library, paths, brickOnly);
    await baked(compiler, placementRequest, library, paths, both);
    const narrower = await baked(compiler, coverRequest, library, paths, brickOnly);

    expect(whole.studCover.covered).toBeGreaterThan(0);
    expect([placement, cover, again, narrower].map((bake) => bake.resumedParts)).toEqual([
      0, 2, 0, 0,
    ]);
    expect(placement.studCover.covered).toBe(0);
    expect(cover.studCover).toEqual(whole.studCover);
    expect({ ...placement, studCover: cover.studCover }).toEqual({
      ...whole,
      phases: placement.phases,
    });
  },
  COMPILE_TIMEOUT_MS,
);

it(
  "bakes a placement request that carries no receptor segments, as an app from before receptors sends it, exactly like one whose parts have no receptors",
  async () => {
    const { manifest, compiler } = await bundleCompiler();
    const paths = await libraryPaths();
    const library: HeldLibrary = { key: "earlier-app", files: new Map(), absent: new Set() };
    const inputs: BakeInputs = {
      source: STACKED_BESIDE_A_SLOPE,
      drawn: new Uint8Array([1, 1, 1]),
      studPrimitives: manifest.studPrimitives.map((primitive) => primitive.name),
      unofficialAllowlist: [],
      translucentColors: [],
      tableDepthLdu: manifest.tablePlane.depthBelowTopLdu,
      vehicles: null,
    };
    const fromAnEarlierApp: Omit<PlacementBakeRequest, "receptors"> = inputs;
    const withoutReceptors: PlacementBakeRequest = {
      ...inputs,
      receptors: bakeReceptors(new Uint32Array(3), [null]),
    };

    const sent = await baked(compiler, withoutReceptors, library, paths, null);
    const unsent = await baked(
      compiler,
      fromAnEarlierApp as PlacementBakeRequest,
      library,
      paths,
      null,
    );

    expect(sent.lattice).not.toBeNull();
    expect({ ...unsent, phases: sent.phases }).toEqual(sent);
  },
  COMPILE_TIMEOUT_MS,
);

it(
  "records shape only the bake that carries them, and a narrower set drops the rest until it is sent again",
  async () => {
    const recorded = await compileAll("standard", true);
    const recordOf = (part: string): Uint8Array => {
      const outcome = recorded.parts[PARTS.indexOf(part)];
      if (outcome?.status !== "compiled" || outcome.record === null) {
        throw new Error(`${part} has no record`);
      }
      return outcome.record;
    };
    const both: RecordFiles = {
      key: "pinned",
      files: new Map([
        ["3001.dat", recordOf("3001.dat")],
        ["3040b.dat", recordOf("3040b.dat")],
      ]),
    };
    const brickOnly: RecordFiles = {
      key: "pinned",
      files: new Map([["3001.dat", recordOf("3001.dat")]]),
    };
    const { manifest, compiler } = await bundleCompiler();
    const paths = await libraryPaths();
    const library: HeldLibrary = { key: "bake", files: new Map(), absent: new Set() };
    const request: BakeRequest = {
      source: BRICK_ON_SLOPE,
      drawn: new Uint8Array([1, 1]),
      receptors: bakeReceptors(new Uint32Array(2), [null]),
      studPrimitives: manifest.studPrimitives.map((primitive) => primitive.name),
      unofficialAllowlist: [],
      translucentColors: [],
      tableDepthLdu: manifest.tablePlane.depthBelowTopLdu,
      vehicles: null,
    };

    const bakes: BakedModel[] = [];
    for (const records of [both, null, brickOnly, both]) {
      bakes.push(await baked(compiler, request, library, paths, records));
    }

    expect(bakes.map((bake) => bake.recordedParts)).toEqual([2, 0, 1, 2]);
    for (const bake of bakes) {
      expect(bake).toEqual({ ...bakes[0], recordedParts: bake.recordedParts, phases: bake.phases });
    }
  },
  COMPILE_TIMEOUT_MS,
);

function readGlyph(bytes: Uint8Array | null): PlanGlyph {
  if (bytes === null) throw new Error("no plan glyph came back");
  const decoded = decodePlanGlyph(bytes);
  if (!decoded.ok) throw new Error(decoded.issues.map((issue) => issue.message).join("; "));
  return decoded.value;
}

it(
  "a compile and a bake asked for plan glyphs return glyphs the schema reads, and a bake from records draws the glyph a compile draws",
  async () => {
    const compiled = await compileAll("standard", true, { translucentColors: [] });
    const outcomeOf = (
      part: string,
    ): { readonly glyph: Uint8Array | null; readonly record: Uint8Array } => {
      const outcome = compiled.parts[PARTS.indexOf(part)];
      if (outcome?.status !== "compiled" || outcome.record === null) {
        throw new Error(`${part} did not compile`);
      }
      return { glyph: outcome.glyph, record: outcome.record };
    };
    const brick = readGlyph(outcomeOf("3001.dat").glyph);
    expect([brick.originX, brick.originZ, brick.width, brick.depth]).toEqual([-16, -8, 32, 16]);
    expect([...brick.colors]).toEqual([16]);
    expect(brick.coverage.every((count) => count === 16)).toBe(true);
    expect([...brick.vertices]).toEqual([0, 0, 128, 0, 128, 64, 0, 64]);

    const records: RecordFiles = {
      key: "pinned",
      files: new Map(["3001.dat", "3040b.dat"].map((part) => [part, outcomeOf(part).record])),
    };
    const { manifest, compiler } = await bundleCompiler();
    const paths = await libraryPaths();
    const library: HeldLibrary = { key: "glyph", files: new Map(), absent: new Set() };
    const request: PlacementBakeRequest = {
      source: STACKED_BESIDE_A_SLOPE,
      drawn: new Uint8Array([1, 1, 1]),
      receptors: bakeReceptors(new Uint32Array(3), [null]),
      studPrimitives: manifest.studPrimitives.map((primitive) => primitive.name),
      unofficialAllowlist: [],
      translucentColors: [],
      tableDepthLdu: manifest.tablePlane.depthBelowTopLdu,
      vehicles: null,
      glyph: true,
    };
    const fromRecords = await baked(compiler, request, library, paths, records);
    const fromCompiles = await baked(compiler, request, library, paths, null);
    expect(fromRecords.recordedParts).toBe(2);
    expect(fromRecords.glyph).toEqual(fromCompiles.glyph);
    expect([...readGlyph(fromRecords.glyph).colors]).toEqual([1, 2]);
  },
  COMPILE_TIMEOUT_MS,
);

it(
  "plan glyphs are refused at any LOD but the standard one",
  async () => {
    await expect(compileAll("low", false, { translucentColors: [] })).rejects.toThrow(
      "standard LOD",
    );
  },
  COMPILE_TIMEOUT_MS,
);

const blueBrickFixtures = new URL("../../test-fixtures/bluebrick/", import.meta.url);

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

it("every BlueBrick map in the fixtures comes back through the compiler in the strict BlueBrick schema", async () => {
  const { compiler } = await bundleCompiler();
  const files = (await readdir(blueBrickFixtures)).filter((file) => file.endsWith(".bbm"));
  expect(files.toSorted()).toEqual([
    "fordyce-2026.bbm",
    "queue.bbm",
    "sample_track01.bbm",
    "synthetic-yard.bbm",
    "tight-corner.bbm",
  ]);
  for (const file of files) {
    const read = compiler.readBlueBrick(await readFile(new URL(file, blueBrickFixtures)));
    if (read.status !== "read") throw new Error(`${file}: ${read.message}`);
    expect({ file, issues: read.map.issues }).toEqual({ file, issues: [] });
  }
  const yard = compiler.readBlueBrick(
    await readFile(new URL("synthetic-yard.bbm", blueBrickFixtures)),
  );
  if (yard.status !== "read") throw new Error(yard.message);
  const track = yard.map.layers[2];
  expect(track?.kind === "brick" && track.bricks[1]?.connections).toEqual([
    { id: "102", link: { layer: 2, brick: 0, connection: 1 } },
    { id: "103", link: { layer: 2, brick: 2, connection: 0 } },
  ]);
});

it("a file the reader refuses comes back with the reader's reason", async () => {
  const { compiler } = await bundleCompiler();
  const yard = await readFile(new URL("synthetic-yard.bbm", blueBrickFixtures), "utf8");
  expect(compiler.readBlueBrick(encode(yard.replace("<Version>9", "<Version>10")))).toEqual({
    status: "rejected",
    kind: "newerVersion",
    message:
      "this map was saved by a newer BlueBrick (data version 10); this reader knows versions up to 9",
  });
  expect(
    compiler.readBlueBrick(encode(yard.replace("<Radius>12</Radius>", "<Radius>twelve</Radius>"))),
  ).toEqual({
    status: "rejected",
    kind: "malformed",
    message:
      'the BlueBrick file is damaged: Map/Layers/Layer[6]/RulerItems/CircularRuler[1]/Radius "twelve" isn\'t a finite decimal',
  });
});

it("a budget saved by BlueBrick comes back through the compiler, and a map read as a budget is refused", async () => {
  const { compiler } = await bundleCompiler();
  expect(
    compiler.readBlueBrickBudget(await readFile(new URL("budget.bbb", blueBrickFixtures))),
  ).toEqual({
    status: "read",
    budget: {
      version: 1,
      parts: [
        { id: "2865.8", count: 12 },
        { id: "3811.1", count: 0 },
        { id: "TS_OLDNAME_TEST", count: 3 },
      ],
    },
  });
  expect(
    compiler.readBlueBrickBudget(await readFile(new URL("synthetic-yard.bbm", blueBrickFixtures))),
  ).toEqual({
    status: "rejected",
    kind: "notBudget",
    message: "not a BlueBrick budget: its root element is <Map>, not <Budget>",
  });
});

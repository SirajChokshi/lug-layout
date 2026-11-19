import { SectionVocabularyFile } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  BrickCompiler,
  type BakedModel,
  type BakeRequest,
  type CompileLod,
  type CompileOutput,
  type CompileRequest,
  type LibraryFiles,
  type RecordFiles,
} from "./brick-compiler.ts";

const bundleRoot = new URL("../../../tools/asset-pipeline/dist/bundle/standard/", import.meta.url);
const pinnedLibrary = fileURLToPath(new URL("../../../.cache/ldraw/", import.meta.url));
const RECORD_MAGIC = "BRRBAKE1";
const PARTS = ["3001.dat", "3040b.dat", "3626c.dat"];
const COMPILE_TIMEOUT_MS = 60_000;
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

async function compileAll(lod: CompileLod, records: boolean): Promise<CompileOutput> {
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
    },
    parts: PARTS,
    model: "",
    inlineChecks: [],
    records,
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

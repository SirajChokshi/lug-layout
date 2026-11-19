import { SectionVocabularyFile } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  BrickCompiler,
  type CompileLod,
  type CompileOutput,
  type CompileRequest,
} from "./brick-compiler.ts";

const bundleRoot = new URL("../../../tools/asset-pipeline/dist/bundle/standard/", import.meta.url);
const pinnedLibrary = fileURLToPath(new URL("../../../.cache/ldraw/", import.meta.url));
const RECORD_MAGIC = "BRRBAKE1";
const PARTS = ["3001.dat", "3040b.dat", "3626c.dat"];
const COMPILE_TIMEOUT_MS = 60_000;

interface Manifest {
  readonly studPrimitives: ReadonlyArray<{ readonly name: string }>;
  readonly compiler: {
    readonly file: string;
    readonly primitives?: CompileRequest["connectors"]["primitives"];
    readonly sectionVocabulary: { readonly file: string };
    readonly cavityProbe: string;
  };
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

async function compileAll(lod: CompileLod, records: boolean): Promise<CompileOutput> {
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
  const paths = await libraryPaths();
  const library = { key: "records", files: new Map<string, string>(), absent: new Set<string>() };
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
    for (const path of requested) {
      const file = paths.get(path);
      if (file === undefined) library.absent.add(path);
      else library.files.set(path, await readFile(file, "utf8"));
    }
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

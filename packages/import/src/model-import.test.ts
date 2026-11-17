import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { BrickCompiler } from "./brick-compiler.ts";
import { LdrawMirror, type FetchFunction } from "./ldraw-mirror.ts";
import { ModelImportEngine, type ImportResult } from "./model-import.ts";

const bundleRoot = new URL("../../../tools/asset-pipeline/dist/bundle/standard/", import.meta.url);
const pinnedLibrary = new URL("../../../.cache/ldraw/", import.meta.url);
const probeFile = new URL("../test-data/critic-gap.mpd", import.meta.url);
const HTTP_NOT_FOUND = 404;
const COLOR_NOT_IN_LDCONFIG = 99_999;
const MAIN_COLOUR = 16;
const RED = 4;
const YELLOW = 14;

interface Manifest {
  readonly source: { readonly repo: string; readonly commit: string; readonly root: string };
  readonly parts: ReadonlyArray<{ readonly id: string }>;
  readonly studPrimitives: ReadonlyArray<{ readonly name: string }>;
  readonly colors: ReadonlyArray<{ readonly code: number }>;
  readonly compiler: { readonly file: string };
}

async function importWith(
  fetchUrl: FetchFunction,
  fileName: string,
  text: string,
): Promise<ImportResult> {
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", bundleRoot), "utf8"),
  ) as Manifest;
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
    bundlePartIds: manifest.parts.map((part) => part.id),
    ldconfigCodes: manifest.colors.map((color) => color.code),
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

it("reports a headerless custom part, loose model geometry and a recoloured inline copy, and draws none of them", async () => {
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
  ]);
  expect(parts[3]).toMatchObject({
    official: "3001.dat",
    colorsMatch: false,
    inlineColors: [RED, YELLOW],
    officialColors: [MAIN_COLOUR],
  });
  expect(result.report.looseGeometry).toEqual([
    { section: "critic-gap.ldr", triangles: 0, quads: 1, occurrences: 1 },
  ]);
  expect(result.instanceCount).toBe(1);
  expect(result.partIds).toEqual(["ldraw:3001"]);
  expect(result.compiled).toEqual([]);
});

import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { BrickCompiler } from "./brick-compiler.ts";
import { LdrawMirror } from "./ldraw-mirror.ts";
import { ModelImportEngine } from "./model-import.ts";

const bundleRoot = new URL("../../../tools/asset-pipeline/dist/bundle/standard/", import.meta.url);
const HTTP_NOT_FOUND = 404;
const COLOR_NOT_IN_LDCONFIG = 99_999;

interface Manifest {
  readonly source: { readonly repo: string; readonly commit: string; readonly root: string };
  readonly parts: ReadonlyArray<{ readonly id: string }>;
  readonly studPrimitives: ReadonlyArray<{ readonly name: string }>;
  readonly colors: ReadonlyArray<{ readonly code: number }>;
  readonly compiler: { readonly file: string };
}

it("draws bundle parts and reports, without drawing, a part the library lacks and a colour LDConfig lacks", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("manifest.json", bundleRoot), "utf8"),
  ) as Manifest;
  const compiler = new BrickCompiler(
    new WebAssembly.Module(await readFile(new URL(manifest.compiler.file, bundleRoot))),
  );
  const requested: string[] = [];
  const mirror = new LdrawMirror(manifest.source, async (url) => {
    requested.push(url);
    return new Response(null, { status: HTTP_NOT_FOUND });
  });
  const engine = new ModelImportEngine(compiler, mirror, () => 0);
  const text = [
    "0 Import contract",
    "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 4 0 -24 0 1 0 0 0 1 0 0 0 1 not-an-ldraw-part.dat",
    `1 ${COLOR_NOT_IN_LDCONFIG} 0 -48 0 1 0 0 0 1 0 0 0 1 3001.dat`,
  ].join("\n");

  const result = await engine.importText({
    fileName: "contract.ldr",
    text,
    lod: "standard",
    source: manifest.source,
    studPrimitives: manifest.studPrimitives.map((primitive) => primitive.name),
    unofficialAllowlist: [],
    bundlePartIds: manifest.parts.map((part) => part.id),
    ldconfigCodes: manifest.colors.map((color) => color.code),
  });

  expect(result.report.parts).toEqual([
    { kind: "bundle", reference: "3001.dat", instances: 2, partId: "ldraw:3001" },
    {
      kind: "notInLibrary",
      reference: "not-an-ldraw-part.dat",
      instances: 1,
      definedInline: false,
    },
  ]);
  expect(result.report.unknownColors).toEqual([{ code: COLOR_NOT_IN_LDCONFIG, instances: 1 }]);
  expect(result.instanceCount).toBe(1);
  expect(result.partIds).toEqual(["ldraw:3001"]);
  expect(requested.every((url) => url.includes(manifest.source.commit))).toBe(true);
});

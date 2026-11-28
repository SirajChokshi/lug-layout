import { readFile } from "node:fs/promises";
import { beforeAll, expect, it } from "vitest";
import { BrickCompiler, type ModelRead } from "./brick-compiler.ts";
import { mpdSections } from "./custom-parts.ts";
import { layoutParts } from "./layout-parts.ts";

const bundleRoot = new URL("../../../tools/asset-pipeline/dist/bundle/standard/", import.meta.url);
const MATRIX_FLOATS = 12;

const BLUEBRICK_STYLE_LAYOUT = [
  "0 FILE My Layout.ldr",
  "0 My layout",
  "0 Name: My Layout.ldr",
  "0 Author: lug-layout test",
  "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 15 -40 0 -40 1 0 0 0 1 0 0 0 1 tile.dat",
  "1 1 0 0 0 1 0 0 0 1 0 0 0 1 Grid.ldr",
  "1 16 80 0 0 0 0 1 0 1 0 -1 0 0 Station.ldr",
  "1 2 -80 -24 40 1 0 0 0 1 0 0 0 1 Shed.ldr",
  "0 MLCAD HIDE 1 1 0 0 0 1 0 0 0 1 0 0 0 1 Hidden.ldr",
  "1 2 0 0 -80 1 0 0 0 1 0 0 0 1 Shed.ldr",
  "0 FILE Station.ldr",
  "0 Station",
  "0 !LDRAW_ORG Unofficial_Model",
  "1 1 0 0 0 1 0 0 0 1 0 0 0 1 3003.dat",
  "1 16 0 -24 0 1 0 0 0 1 0 0 0 1 Roof.ldr",
  "1 14 20 0 20 1 0 0 0 1 0 0 0 1 tile.dat",
  "0 FILE Roof.ldr",
  "1 16 0 0 0 1 0 0 0 1 0 0 0 1 3039.dat",
  "0 FILE Shed.ldr",
  "1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
  "0 FILE Grid.ldr",
  "0 // Grid layer not implemented yet",
  "0 FILE Hidden.ldr",
  "1 0 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
  "0 FILE tile.dat",
  "0 Custom tile",
  "0 !LDRAW_ORG Unofficial_Part",
  "4 16 -10 0 -10 10 0 -10 10 0 10 -10 0 10",
  "0 FILE Unused.ldr",
  "1 0 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
  "",
].join("\n");

let compiler: BrickCompiler;

beforeAll(async () => {
  const manifest = JSON.parse(await readFile(new URL("manifest.json", bundleRoot), "utf8")) as {
    readonly compiler: { readonly file: string };
  };
  compiler = new BrickCompiler(
    new WebAssembly.Module(await readFile(new URL(manifest.compiler.file, bundleRoot))),
  );
});

function drawnInstances(read: ModelRead): ReadonlyArray<string> {
  return Array.from(read.instancePart, (part, i) => {
    const matrix = read.instanceTransform.subarray(i * MATRIX_FLOATS, (i + 1) * MATRIX_FLOATS);
    return `${read.parts[part]} ${read.instanceColor[i]} ${matrix.join(" ")}`;
  });
}

it("splits a layout into one file per top-level submodel line and one for the main model's own lines, each holding only the sections it reaches, so every instance the layout draws is drawn by exactly one of them, unchanged", () => {
  const parts = layoutParts(compiler, "my-layout.mpd", BLUEBRICK_STYLE_LAYOUT);

  expect(
    parts.map(({ name, text }) => ({ name, sections: [...mpdSections(text).keys()] })),
  ).toEqual([
    { name: "my-layout.mpd", sections: ["my layout.ldr", "tile.dat"] },
    { name: "Grid.ldr", sections: ["my layout.ldr", "grid.ldr"] },
    { name: "Station.ldr", sections: ["my layout.ldr", "station.ldr", "roof.ldr", "tile.dat"] },
    { name: "Shed.ldr", sections: ["my layout.ldr", "shed.ldr"] },
    { name: "Shed.ldr", sections: ["my layout.ldr", "shed.ldr"] },
  ]);
  expect(parts.flatMap(({ text }) => drawnInstances(compiler.readModel(text))).toSorted()).toEqual(
    drawnInstances(compiler.readModel(BLUEBRICK_STYLE_LAYOUT)).toSorted(),
  );
});

it("keeps a file without submodels whole, as one part named after the file", () => {
  const plain = [
    "0 Two bricks",
    "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 1 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "",
  ].join("\n");

  expect(layoutParts(compiler, "two-bricks.ldr", plain)).toEqual([
    { name: "two-bricks.ldr", text: plain },
  ]);
});

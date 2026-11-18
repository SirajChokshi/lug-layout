import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EditorPage, byPosition, type LatticePoint } from "./editor-page.ts";

const PALETTE_TEMPLATE = "generated:mils-road-straight";
const TEMPLATE_FILE = fileURLToPath(
  new URL("../../../docs/verified-facts/scenes/mils-road-straight.ldr", import.meta.url),
);
const IMPORT_REF = /^import:[0-9a-f]{64}$/u;
const AIM: LatticePoint = { x: 380, z: 420 };
const WEST_NEIGHBOUR: LatticePoint = { x: -320, z: 420 };

function customModule(): string {
  return [
    "0 Custom module built for the model import test",
    "0 Name: custom-module.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
    "1 4 -280 -24 -280 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 1 0 -24 0 1 0 0 0 1 0 0 0 1 3003.dat",
    "1 14 260 -24 290 1 0 0 0 1 0 0 0 1 3700.dat",
    "1 15 0 -48 0 1 0 0 0 1 0 0 0 1 3003.dat",
    "",
  ].join("\n");
}

const FAR_BASEPLATE_X = 20_480;
const AUTHORING_DUST_LDU = 0.0009;
const STRAIGHT_LENGTH_LDU = 320;
const SINGLE_PRECISION_RESIDUAL_LIMIT_LDU = 8192;

function farLayout(): string {
  return [
    "0 Layout with track on a baseplate far from the first",
    "0 Name: far-layout.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
    `1 2 ${FAR_BASEPLATE_X} 0 0 1 0 0 0 1 0 0 0 1 3811.dat`,
    "1 16 0 0 0 1 0 0 0 1 0 0 0 1 74746.dat",
    `1 16 ${FAR_BASEPLATE_X} 0 -160 1 0 0 0 1 0 0 0 1 74746.dat`,
    `1 16 ${FAR_BASEPLATE_X + AUTHORING_DUST_LDU} 0 160 1 0 0 0 1 0 0 0 1 74746.dat`,
    "",
  ].join("\n");
}

test("the palette's MILS template imported as a file bakes to the palette item's lattice, footprint and columns", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();

  const imported = await editor.importModel(TEMPLATE_FILE);

  expect(imported.status, imported.text).toBe("placeable");
  expect(imported.item).toMatch(IMPORT_REF);

  await editor.zoom(400);
  await editor.escape();
  const aim = await editor.screenOf(AIM);
  const west = await editor.screenOf(WEST_NEIGHBOUR);
  await editor.choose(PALETTE_TEMPLATE);
  await page.mouse.click(aim.sx, aim.sy);
  await editor.escape();
  await editor.choose(imported.item);
  await page.mouse.click(west.sx, west.sy);
  await editor.escape();
  const bakes = await editor.bakes();
  const palette = bakes.find((bake) => bake.id === PALETTE_TEMPLATE);
  const file = bakes.find((bake) => bake.id === imported.item);
  expect(palette, `${PALETTE_TEMPLATE} is baked once placed`).toBeDefined();
  expect(file?.lattice).toEqual(palette?.lattice);
  expect(file?.cells).toEqual(palette?.cells);
  const poses = await editor.poses();
  test.info().annotations.push({
    type: "poses of the palette item and the same file imported",
    description: JSON.stringify(poses),
  });
  await page.screenshot({ path: test.info().outputPath("template-and-template-file.png") });
});

test("a custom model file is placed in the editor through the UI and comes back with the world after a reload", async ({
  page,
}) => {
  const file = test.info().outputPath("custom-module.ldr");
  await writeFile(file, customModule());
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();

  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  await editor.zoom(400);
  await editor.placeAt(imported.item, { x: 0, z: 0 });
  const placed = await editor.poses();
  expect(placed).toEqual(
    [{ item: imported.item, x: 0, z: 0, yPlates: 0, rot: 0 }].toSorted(byPosition),
  );
  await editor.escape();
  await page.screenshot({ path: test.info().outputPath("custom-module-placed.png") });
  await expect(page.locator(".world-name")).toHaveAttribute("data-save", "saved");

  const reopened = await EditorPage.open(page);
  await expect
    .poll(() => reopened.poses(), { timeout: 180_000, message: "the import comes back" })
    .toEqual(placed);
});

test("track far from an imported layout's centre is identified from its double-precision transforms, and dust beyond the residual is not", async ({
  page,
}) => {
  const file = test.info().outputPath("far-layout.ldr");
  await writeFile(file, farLayout());
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();

  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  await editor.zoom(400);
  await editor.placeAt(imported.item, { x: 0, z: 0 });
  await editor.escape();

  const ends = (await editor.trackEnds()).toSorted((a, b) => a.xLdu - b.xLdu);
  expect(ends).toHaveLength(4);
  const [, , west, east] = ends;
  expect(west?.xLdu ?? 0).toBeGreaterThan(SINGLE_PRECISION_RESIDUAL_LIMIT_LDU);
  expect((east?.xLdu ?? 0) - (west?.xLdu ?? 0)).toBe(STRAIGHT_LENGTH_LDU);
  expect(east?.zLdu).toBe(west?.zLdu);
});

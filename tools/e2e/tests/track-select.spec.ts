import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, TRACK_ITEM, type LatticePoint } from "./editor-page.ts";

const STRAIGHT_PIECE = "track-piece:ldraw:74746";
const IMPORT_REF = /^import:[0-9a-f]{64}$/u;
const LAYOUT_NAME = "custom-siding-plate.ldr";
const LAYOUT_AT: LatticePoint = { x: 0, z: 800 };

function customLayout(): string {
  return [
    "0 Custom baseplate with two straights, built for the track selection test",
    `0 Name: ${LAYOUT_NAME}`,
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
    "1 16 -160 0 0 1 0 0 0 1 0 0 0 1 74746.dat",
    "1 16 160 0 0 1 0 0 0 1 0 0 0 1 74746.dat",
    "",
  ].join("\n");
}

test("clicking a laid track piece selects it, Delete removes it, undo puts it back, and an imported layout's own track stays part of its model", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const file = test.info().outputPath(LAYOUT_NAME);
  await writeFile(file, customLayout());
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  await editor.zoom(700);
  await editor.placeAt(imported.item, LAYOUT_AT);
  await editor.escape();

  await editor.choose(TRACK_ITEM);
  const laid = await editor.dragTrack({ x: -400, z: 0 }, { x: 400, z: 0 });
  expect(laid.pieces).toBeGreaterThan(1);
  await editor.escape();

  expect(await editor.select({ x: -240, z: 0 })).toBe(STRAIGHT_PIECE);
  await editor.press("Delete");
  const deleted = await editor.trackCounts();
  expect(deleted.pieces).toBe(laid.pieces - 1);
  expect(await editor.root.getAttribute("data-selection")).toBe("");

  await editor.undo();
  expect(await editor.trackCounts()).toMatchObject({
    pieces: laid.pieces,
    openEnds: laid.openEnds,
    joins: laid.joins,
  });
  expect(await editor.root.getAttribute("data-selection")).toBe(STRAIGHT_PIECE);

  expect(await editor.select(LAYOUT_AT)).toMatch(IMPORT_REF);
  expect((await editor.trackCounts()).pieces).toBe(laid.pieces);

  await editor.select({ x: -240, z: 0 });
  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("track-piece-selected.png") });
});

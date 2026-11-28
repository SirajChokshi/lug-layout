import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { EditorPage, TRACK_ITEM, type LatticePoint, type TrackEnd } from "./editor-page.ts";

const STRAIGHT_PIECE = "track-piece:ldraw:74746";
const IMPORT_REF = /^import:[0-9a-f]{64}$/u;
const LAYOUT_NAME = "custom-siding-plate.ldr";
const LAYOUT_AT: LatticePoint = { x: 0, z: 800 };
const JUNCTION_NAME = "custom-junction.ldr";
const JUNCTION_SCENE = new URL(
  "../../../docs/verified-facts/scenes/switch-then-reversed-curve.ldr",
  import.meta.url,
);
const WEST = 8;
const EAST = 0;
const STRAIGHT_LDU = 320;
const RUN_STRAIGHTS = 3;

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

async function customJunction(): Promise<string> {
  const scene = await readFile(JUNCTION_SCENE, "utf8");
  return [
    "0 Custom junction: a 9V switch, a reversed curve and straights, built for the path select test",
    `0 Name: ${JUNCTION_NAME}`,
    "0 Author: lug-layout e2e (generated at test time from docs/verified-facts/scenes)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    ...scene.split(/\r?\n/u).filter((line) => line.startsWith("1 ")),
    "",
  ].join("\n");
}

function along(end: TrackEnd, ldu: number): LatticePoint {
  const direction = end.heading === WEST ? -1 : 1;
  return { x: end.xLdu + direction * ldu, z: end.zLdu };
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

test("double-clicking a laid piece selects its run up to the switch in a user's own track file, Shift-double-click selects all the track joined to it, and double-clicking the file's model still frames it", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const file = test.info().outputPath(JUNCTION_NAME);
  await writeFile(file, await customJunction());
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  await editor.zoom(1200);
  await editor.placeAt(imported.item, { x: 0, z: 0 });
  await editor.escape();

  const ends = await editor.trackEnds();
  const points = ends.find((end) => end.heading === WEST);
  const [main] = ends.filter((end) => end.heading === EAST).toSorted((a, b) => b.zLdu - a.zLdu);
  if (!points || !main) throw new Error(`the junction has no points end and main exit`);
  await editor.choose(TRACK_ITEM);
  const runLdu = RUN_STRAIGHTS * STRAIGHT_LDU;
  const west = await editor.dragTrack(along(points, 0), along(points, runLdu));
  const east = await editor.dragTrack(along(main, 0), along(main, runLdu));
  await editor.escape();
  await editor.escape();
  const counts = { west: west.pieces, east: east.pieces - west.pieces };
  await editor.waitForFarTierAndMeshesSettled();

  const camera = await editor.cameraView();
  const selected = async () => ({
    count: await editor.selectionCount(),
    primary: await editor.root.getAttribute("data-selection"),
    cameraMoved: (await editor.cameraView()) !== camera,
  });
  await editor.doubleClickAt(along(points, STRAIGHT_LDU / 2));
  const westRun = await selected();
  await page.screenshot({ path: test.info().outputPath("run-selected.png") });
  await editor.doubleClickAt(along(main, STRAIGHT_LDU / 2));
  const eastRun = await selected();
  await page.screenshot({ path: test.info().outputPath("run-through-model-selected.png") });
  await editor.doubleClickAt(along(points, STRAIGHT_LDU / 2), "Shift");
  const network = await selected();
  await page.screenshot({ path: test.info().outputPath("network-selected.png") });
  await editor.doubleClickAt(along(main, -STRAIGHT_LDU / 2));
  const model = await selected();

  expect(counts).toEqual({ west: RUN_STRAIGHTS, east: RUN_STRAIGHTS });
  expect({ westRun, eastRun, network, model }).toEqual({
    westRun: { count: counts.west, primary: STRAIGHT_PIECE, cameraMoved: false },
    eastRun: { count: counts.east + 1, primary: STRAIGHT_PIECE, cameraMoved: false },
    network: { count: counts.west + counts.east + 1, primary: STRAIGHT_PIECE, cameraMoved: false },
    model: { count: 1, primary: imported.item, cameraMoved: true },
  });
});

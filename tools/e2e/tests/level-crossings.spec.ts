import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, TRACK_ITEM } from "./editor-page.ts";

const ROAD_STRAIGHT = "ldraw:44336p04@72";
const RAISED_ROAD = "ldraw:69958@72";
const CURVE = "track-piece:ldraw:74747";
const ROAD_HALF_WIDTH = 200;
const LICENSE = "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt";

const USER_STRAIGHTS = [
  "0 My level crossing run",
  "0 Name: my-crossing-run.ldr",
  "0 Author: lug-layout e2e, three 9V straights in a row",
  LICENSE,
  "1 72 -320 0 0 1 0 0 0 1 0 0 0 1 74746.dat",
  "1 72 0 0 0 1 0 0 0 1 0 0 0 1 74746.dat",
  "1 72 320 0 0 1 0 0 0 1 0 0 0 1 74746.dat",
  "",
].join("\n");

const USER_COTTAGE = [
  "0 Custom cottage built from official parts",
  "0 Name: my-cottage.ldr",
  "0 Author: lug-layout e2e, after the experience audit's custom cottage",
  LICENSE,
  "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3867.dat",
  "1 15 -40 -24 -60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 15 -40 -24 60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 15 40 -24 -60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 15 40 -24 60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 15 -60 -24 0 0 0 1 0 1 0 -1 0 0 3001.dat",
  "1 15 60 -24 0 0 0 1 0 1 0 -1 0 0 3001.dat",
  "1 4 -40 -48 -60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 4 -40 -48 60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 4 40 -48 -60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 4 40 -48 60 1 0 0 0 1 0 0 0 1 3001.dat",
  "",
].join("\n");

async function importUserModel(editor: EditorPage, name: string, text: string): Promise<string> {
  const file = test.info().outputPath(name);
  await writeFile(file, text);
  await editor.serveLdrawLibrary();
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  await editor.escape();
  return imported.item;
}

test("9V track laid across a road plate is a level crossing whose ramps sit on the verge studs", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(500);
  await editor.placeAt(ROAD_STRAIGHT, { x: 0, z: 0 });
  await editor.choose(TRACK_ITEM);
  const run = await editor.dragTrack({ x: -480, z: 0 }, { x: 480, z: 0 });
  expect(run.lastCommit).toBe("laid");

  const crossings = await editor.crossings();
  expect(crossings).toHaveLength(1);
  const ramps = crossings[0]?.ramps ?? [];
  expect(ramps.length).toBeGreaterThan(0);
  for (const ramp of ramps) {
    expect(ramp.studMates, `${ramp.part} at ${ramp.x}, ${ramp.z}`).toBeGreaterThan(0);
    expect(Math.sign(ramp.z), "ramps stand beside the track, not on it").not.toBe(0);
  }
  expect(new Set(ramps.map((ramp) => Math.sign(ramp.z)))).toEqual(new Set([-1, 1]));
  await page.screenshot({ path: test.info().outputPath("level-crossing.png") });
});

test("a curve laid over the roadway is a crossing, not a refusal", async ({ page }) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(500);
  await editor.placeAt(ROAD_STRAIGHT, { x: 0, z: 0 });
  await editor.placeAt(CURVE, { x: -ROAD_HALF_WIDTH + 40, z: 0 });
  const counts = await editor.trackCounts();
  expect(counts.pieces).toBe(1);
  expect(counts.lastCommit).toMatch(/^(laid|joined)$/u);
  expect(await editor.crossings()).toHaveLength(1);
  await page.screenshot({ path: test.info().outputPath("curve-crossing.png") });
});

test("a user's own file of 9V straights placed across a road plate is a crossing with ramps on the verge studs", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  const run = await importUserModel(editor, "my-crossing-run.ldr", USER_STRAIGHTS);
  await editor.zoom(500);
  await editor.placeAt(ROAD_STRAIGHT, { x: 0, z: 0 });
  await editor.placeAt(run, { x: 0, z: 0 });
  await editor.escape();

  const crossings = await editor.crossings();
  expect(crossings).toHaveLength(1);
  const ramps = crossings[0]?.ramps ?? [];
  expect(ramps.length).toBeGreaterThan(0);
  for (const ramp of ramps) expect(ramp.studMates).toBeGreaterThan(0);
  await page.screenshot({ path: test.info().outputPath("user-run-crossing.png") });
});

test("track can't run through a raised road plate, and the plate can't be dropped onto track", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(500);
  await editor.placeAt(RAISED_ROAD, { x: 0, z: 0 });
  await editor.choose(TRACK_ITEM);
  const through = await editor.dragTrack({ x: -480, z: 0 }, { x: 480, z: 0 });
  expect(through).toMatchObject({ pieces: 0, lastCommit: "refused-collision" });
  expect(await editor.trackRefusal()).toContain("69958");
  await page.screenshot({ path: test.info().outputPath("raised-plate-refused.png") });

  await editor.escape();
  await editor.undo();
  expect(await editor.poses()).toEqual([]);
  await editor.choose(TRACK_ITEM);
  const laid = await editor.dragTrack({ x: -480, z: 0 }, { x: 480, z: 0 });
  expect(laid.lastCommit).toBe("laid");
  const before = await editor.counter("refused");
  await editor.placeAt(RAISED_ROAD, { x: 0, z: 0 });
  expect(await editor.counter("refused")).toBe(before + 1);
  expect(await editor.poses()).toEqual([]);
});

test("a run drawn through a user's building or across track it doesn't join is refused and names what it hits", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  const cottage = await importUserModel(editor, "my-cottage.ldr", USER_COTTAGE);
  await editor.zoom(500);
  await editor.placeAt(cottage, { x: 0, z: 0 });
  await editor.choose(TRACK_ITEM);

  const throughBuilding = await editor.dragTrack({ x: -480, z: 0 }, { x: 480, z: 0 });
  expect(throughBuilding).toMatchObject({ pieces: 0, lastCommit: "refused-collision" });
  expect(await editor.trackRefusal()).toMatch(/would run into 3001 of /u);
  await page.screenshot({ path: test.info().outputPath("run-through-building-refused.png") });

  const beside = await editor.dragTrack({ x: -480, z: 400 }, { x: 480, z: 400 });
  expect(beside.lastCommit).toBe("laid");
  const acrossTrack = await editor.dragTrack({ x: -320, z: 160 }, { x: -320, z: 720 });
  expect(acrossTrack).toMatchObject({ pieces: beside.pieces, lastCommit: "refused-collision" });
  expect(await editor.trackRefusal()).toMatch(
    /would cross Train Track .* #\d+, which it doesn't join/u,
  );
  await page.screenshot({ path: test.info().outputPath("run-across-track-refused.png") });
});

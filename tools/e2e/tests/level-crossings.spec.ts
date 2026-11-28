import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, TRACK_ITEM } from "./editor-page.ts";

const ROAD_STRAIGHT = "ldraw:44336p04@72";
const RAISED_ROAD = "ldraw:69958@72";
const CURVE = "track-piece:ldraw:74747";
const STRAIGHT = "track-piece:ldraw:74746";
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

test("9V track drawn across a road plate is a level crossing, reported unsupported, whose ramps sit on the verge studs", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(500);
  await editor.placeAt(ROAD_STRAIGHT, { x: 0, z: 0 });
  await editor.choose(TRACK_ITEM);
  const run = await editor.dragTrack({ x: -480, z: 0 }, { x: 480, z: 0 });
  expect(run.lastCommit).toBe("laid");
  expect(await editor.unsupportedTrack()).toBeGreaterThan(0);
  expect(await editor.toolHint()).toMatch(/44336p04 .*where it has no studs/u);

  const crossings = await editor.crossings();
  expect(crossings).toHaveLength(1);
  const ramps = crossings[0]?.ramps ?? [];
  expect(ramps.length).toBeGreaterThan(0);
  for (const ramp of ramps) {
    expect(ramp.studMates, `${ramp.part} at ${ramp.x}, ${ramp.z}`).toBeGreaterThan(0);
    expect(Math.sign(ramp.z), "ramps stand beside the track, not on it").not.toBe(0);
  }
  expect(new Set(ramps.map((ramp) => Math.sign(ramp.z)))).toEqual(new Set([-1, 1]));
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
});

test("runs join both open ends of a user's own file of 9V straights, and a run across it stops short", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  const run = await importUserModel(editor, "my-crossing-run.ldr", USER_STRAIGHTS);
  await editor.zoom(500);
  await editor.placeAt(run, { x: 0, z: 0 });
  await editor.escape();
  await editor.choose(TRACK_ITEM);

  const onto = await editor.dragTrack({ x: 800, z: 0 }, { x: 480, z: 0 });
  const from = await editor.dragTrack({ x: -480, z: 0 }, { x: -800, z: 0 });
  const across = await editor.dragTrack({ x: 0, z: -720 }, { x: 0, z: 320 });

  expect(onto.lastCommit).toBe("joined");
  expect(from).toMatchObject({ lastCommit: "laid", joins: 4, openEnds: 2 });
  expect(across.pieces).toBe(from.pieces + 1);
  expect(await editor.toolHint()).toContain("cross the track laid there");
});

test("a run stops short at a raised road plate, and the plate can't be dropped onto track", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(500);
  await editor.placeAt(RAISED_ROAD, { x: 0, z: 0 });
  await editor.choose(TRACK_ITEM);
  const through = await editor.dragTrack({ x: -800, z: 0 }, { x: 480, z: 0 });
  expect(through.pieces).toBeLessThan(3);
  expect(await editor.toolHint()).toContain("run into 69958");

  await editor.escape();
  await editor.undo();
  await editor.undo();
  await editor.escape();
  expect(await editor.poses()).toEqual([]);
  await editor.choose(TRACK_ITEM);
  const laid = await editor.dragTrack({ x: -480, z: 0 }, { x: 480, z: 0 });
  expect(laid.lastCommit).toBe("laid");
  await editor.escape();
  const before = await editor.counter("refused");
  await editor.placeAt(RAISED_ROAD, { x: 0, z: 0 });
  expect(await editor.counter("refused")).toBe(before + 1);
  expect(await editor.hud("Last refusal")).toMatch(/69958 .*would cross the track laid there\./u);
  expect(await editor.poses()).toEqual([]);
});

test("a run stops short at a user's building or at track it doesn't join, and a held piece or the building dropped onto track is refused, naming what it hits", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  const cottage = await importUserModel(editor, "my-cottage.ldr", USER_COTTAGE);
  await editor.zoom(500);
  await editor.placeAt(cottage, { x: 0, z: 0 });
  await editor.choose(TRACK_ITEM);

  await editor.dragTrack({ x: -480, z: 0 }, { x: 480, z: 0 });
  expect(await editor.toolHint()).toContain("run into my-cottage.ldr");

  const beside = await editor.dragTrack({ x: -480, z: 400 }, { x: 480, z: 400 });
  expect(beside.lastCommit).toBe("laid");
  const acrossTrack = await editor.dragTrack({ x: 440, z: -240 }, { x: 440, z: 720 });
  expect(acrossTrack.pieces).toBe(beside.pieces + 1);
  expect(await editor.toolHint()).toContain("cross the track laid there");

  await editor.escape();
  const before = await editor.counter("refused");
  await editor.placeAt(STRAIGHT, { x: 0, z: 0 });
  expect(await editor.counter("refused")).toBe(before + 1);
  expect(await editor.hud("Last refusal")).toBe(
    "Train Track 9V Straight would run into my-cottage.ldr. Move it clear or turn it.",
  );
  await editor.escape();
  await editor.placeAt(cottage, { x: 0, z: 400 });
  expect(await editor.counter("refused")).toBe(before + 2);
  expect(await editor.hud("Last refusal")).toBe(
    "my-cottage.ldr would cross the track laid there. Move it clear or turn it.",
  );
});

test("a fill of a user's own my-crossing-run.ldr across a road plate lays the tiles, reports the one on the roadway unsupported, and skips the tiles whose track would cross laid track", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  const run = await importUserModel(editor, "my-crossing-run.ldr", USER_STRAIGHTS);
  await editor.zoom(500);
  await editor.placeAt(ROAD_STRAIGHT, { x: 0, z: 0 });
  await editor.escape();

  await editor.choose(run);
  await editor.dragFrom({ x: -500, z: -80 }, { x: 1600, z: -60 });
  const filled = await editor.toolHint();
  await editor.escape();
  await editor.choose(TRACK_ITEM);
  await expect.poll(() => editor.unsupportedTrack()).toBeGreaterThan(0);
  expect(filled).toMatch(/Filled [2-9] × /u);
  expect((await editor.crossings()).length).toBeGreaterThan(0);

  await editor.dragTrack({ x: 0, z: 1200 }, { x: 0, z: 2400 });
  await editor.escape();
  await editor.choose(run);
  await editor.dragFrom({ x: -1440, z: 1800 }, { x: 1440, z: 1820 });
  expect(await editor.toolHint()).toMatch(
    /skipped \d+ refused: my-crossing-run\.ldr would cross the track laid there\./u,
  );
});

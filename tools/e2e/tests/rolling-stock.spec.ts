import { expect, test } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { EditorPage, TRACK_ITEM, nearestLattice } from "./editor-page.ts";

const LOCOMOTIVE = "omr:10133-1";
const OFFICIAL_CABOOSE = new URL("../../../.cache/omr/10014-1.mpd", import.meta.url);
const HEADINGS = 16;
const EAST = 0;
const WEST = HEADINGS / 2;
const THROTTLE_PRESSES = 4;
const RUN_DEADLINE_MS = 30_000;
const SAMPLE_MS = 200;

async function writeMyBlueCaboose(path: string): Promise<void> {
  const official = await readFile(OFFICIAL_CABOOSE, "utf8");
  const custom = official
    .replaceAll("10014 - ", "my blue caboose - ")
    .split("\n")
    .map((line) => line.replace(/^1 0 /u, "1 1 "))
    .join("\n");
  await writeFile(path, custom);
}

test("trains set by hand on a hand-drawn oval, an imported one included, run from where they stand and are still on the rails after a reload", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  await editor.zoom(700);
  await editor.choose(TRACK_ITEM);
  await editor.dragTrack({ x: -400, z: 0 }, { x: 400, z: 0 });
  const ends = await editor.trackEnds();
  const east = ends.find((end) => end.heading === EAST);
  const west = ends.find((end) => end.heading === WEST);
  if (!east || !west) throw new Error(`a straight run has two ends: ${JSON.stringify(ends)}`);
  const oval = await editor.dragTrack(nearestLattice(east), nearestLattice(west));
  expect(oval.openEnds).toBe(0);
  await editor.escape();

  const file = test.info().outputPath("my-blue-caboose.mpd");
  await writeMyBlueCaboose(file);
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  await editor.placeAt(LOCOMOTIVE, { x: 0, z: 0 });
  await editor.placeAt(imported.item, { x: -100, z: 1600 });
  await editor.escape();

  expect(await editor.trainsOnRails()).toBe(2);
  expect(await editor.poses()).toEqual([]);

  await editor.startPlay();
  const started = await editor.playState();
  expect(started).toMatchObject({ status: "running", bogiesOff: 0, derailSpeed: 0 });
  for (let press = 0; press < THROTTLE_PRESSES; press++) await editor.press("]");
  await expect
    .poll(async () => (await editor.playState()).xLdu, {
      timeout: RUN_DEADLINE_MS,
      intervals: [SAMPLE_MS],
    })
    .not.toBe(started.xLdu);
  await editor.press("Shift+P");

  const reopened = await EditorPage.open(page);
  expect(await reopened.trainsOnRails()).toBe(2);
  await page.screenshot({ path: test.info().outputPath("rolling-stock.png") });
});

import { expect, test } from "@playwright/test";
import { EditorPage, STUD, TRACK_ITEM } from "./editor-page.ts";

const SIX_STUD_STRAIGHT = "ldraw:44336p04@72";
const MILS_CROSSING = "generated:mils-level-crossing";
const MILS_RAIL = "generated:mils-rail-straight";
const MILS_ROAD = "generated:mils-road-straight";
const RAMP_BED_OFFSET = 24;
const SIDES_PER_SEAM = 2;

test("9V track laid straight across a road plate gets the real 4515 ramps exactly, and track along the road is refused", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(500);
  await editor.placeAt(SIX_STUD_STRAIGHT, { x: 0, z: 0 });
  await editor.choose(TRACK_ITEM);

  const across = await editor.dragTrack({ x: -560, z: -60 }, { x: 560, z: -60 });
  expect(across).toMatchObject({ lastCommit: "laid", crossings: 1, crossingConflicts: 0 });
  expect(await editor.crossingRamps()).toEqual([
    { x: -80, y: RAMP_BED_OFFSET, z: -200, rot: 2 },
    { x: 80, y: RAMP_BED_OFFSET, z: -200, rot: 2 },
    { x: -80, y: RAMP_BED_OFFSET, z: 80, rot: 0 },
    { x: 80, y: RAMP_BED_OFFSET, z: 80, rot: 0 },
  ]);
  await page.screenshot({ path: test.info().outputPath("level-crossing-on-road-plate.png") });

  const along = await editor.dragTrack({ x: 200, z: -280 }, { x: 200, z: 300 });
  expect(along).toMatchObject({
    lastCommit: "refused-road",
    pieces: across.pieces,
    crossings: 1,
    crossingConflicts: 0,
  });
  await expect(page.locator("section.track-panel")).toContainText(
    "the track would run along the road instead of across it",
  );
});

test("a road plate turned along laid track is refused, and turned across it makes the crossing", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(500);
  await editor.choose(TRACK_ITEM);
  const laid = await editor.dragTrack({ x: -560, z: 40 }, { x: 560, z: 40 });
  expect(laid).toMatchObject({ lastCommit: "laid", crossings: 0 });

  const refusedBefore = await editor.counter("refused");
  await editor.placeAt(SIX_STUD_STRAIGHT, { x: 0, z: 0 }, 1);
  expect(await editor.counter("refused")).toBe(refusedBefore + 1);
  expect(await editor.poses()).toEqual([]);
  await expect(editor.root).toContainText("crosses laid track");

  await editor.placeAt(SIX_STUD_STRAIGHT, { x: 0, z: 0 }, 0);
  expect(await editor.poses()).toEqual([
    { item: SIX_STUD_STRAIGHT, x: 0, z: 0, yPlates: 0, rot: 0 },
  ]);
  expect(await editor.trackCounts()).toMatchObject({ crossings: 1, crossingConflicts: 0 });
  expect((await editor.crossingRamps()).map(({ x, z }) => [x, z])).toEqual([
    [-80, -100],
    [80, -100],
    [-80, 180],
    [80, 180],
  ]);
});

test("the MILS level crossing module joins rail modules on its rail edges and road modules on its road edges", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(400);
  const { wide } = await editor.itemStuds(MILS_CROSSING);
  const half = (wide * STUD) / 2;
  await editor.placeAt(MILS_CROSSING, { x: -half, z: -half }, 0);
  await editor.placeAt(MILS_RAIL, { x: half, z: -half }, 0);
  await editor.placeAt(MILS_ROAD, { x: -half, z: half }, 1);
  expect(await editor.counter("refused")).toBe(0);
  expect(await editor.counter("module-mismatch")).toBe(0);
  expect(await editor.counter("module-joined"), "both seams join, counted from each side").toBe(
    SIDES_PER_SEAM * 2,
  );
  await page.screenshot({ path: test.info().outputPath("mils-level-crossing.png") });
});

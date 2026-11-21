import { expect, test } from "@playwright/test";
import { EditorPage, STUD, TRACK_ITEM, isStudAligned, nearestLattice } from "./editor-page.ts";

const HEADINGS = 16;
const EAST = 0;
const WEST = HEADINGS / 2;
const QUARTER_TURN = HEADINGS / 4;
const SWITCH_PIECE = /^track-piece:ldraw:7554[12]-/u;
const SWITCH_STRAIGHT_ENDS = 2;

test("a straight run closed into an oval joins every end exactly", async ({ page }) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(700);
  await editor.choose(TRACK_ITEM);

  const start = { x: -400, z: 0 };
  const run = await editor.dragTrack(start, { x: 400, z: 0 });
  expect(run.lastCommit).toBe("laid");
  expect(run.pieces).toBeGreaterThan(0);
  expect(run.openEnds).toBe(2);
  expect(run.joins).toBe(run.pieces - 1);

  const ends = await editor.trackEnds();
  const west = ends.find((end) => end.heading === WEST);
  const east = ends.find((end) => end.heading === EAST);
  expect(west).toMatchObject({ xLdu: start.x, zLdu: start.z, heading: WEST });
  if (!east || !west)
    throw new Error(`a straight run has ends facing east and west: ${JSON.stringify(ends)}`);
  expect(east.zLdu).toBe(0);
  expect(east.xLdu % STUD).toBe(0);
  expect(east.xLdu).toBeGreaterThan(start.x);

  const oval = await editor.dragTrack(nearestLattice(east), nearestLattice(west));
  expect(oval.lastCommit).toBe("joined");
  expect(oval.pieces).toBeGreaterThan(run.pieces);
  expect(oval.openEnds).toBe(0);
  expect(oval.joins).toBe(oval.pieces);
  expect(await editor.trackEnds()).toEqual([]);

  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("track-oval.png") });
});

test("track laid on open ground sits on the studs: a shallow drag and a switch held by its branch end", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(700);
  await editor.choose(TRACK_ITEM);

  const start = { x: -400, z: -200 };
  const run = await editor.dragTrack(start, { x: 400, z: 60 });
  expect(run.lastCommit).toBe("laid");
  const startEnd = (await editor.trackEnds()).find(
    (end) => end.xLdu === start.x && end.zLdu === start.z,
  );
  expect(startEnd).toMatchObject({ xLdu: start.x, zLdu: start.z, heading: WEST });

  const switchItem = (await editor.catalog()).find((entry) => SWITCH_PIECE.test(entry.id));
  if (!switchItem) throw new Error("the palette offers no 9V switch");
  const before = new Set((await editor.trackEnds()).map((end) => JSON.stringify(end)));
  await editor.escape();
  await editor.choose(switchItem.id);
  const cursor = await editor.screenOf({ x: 0, z: 400 });
  await page.mouse.move(cursor.sx, cursor.sy);
  await editor.press("q");
  await editor.press("q");
  await editor.press("r");
  await page.mouse.click(cursor.sx, cursor.sy);
  await editor.escape();

  const laid = (await editor.trackEnds()).filter((end) => !before.has(JSON.stringify(end)));
  const straightEnds = laid.filter((end) => end.heading % QUARTER_TURN === 0);
  expect(straightEnds).toHaveLength(SWITCH_STRAIGHT_ENDS);
  for (const end of straightEnds) {
    expect(isStudAligned(end.xLdu) && isStudAligned(end.zLdu), JSON.stringify(end)).toBe(true);
  }

  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("track-on-studs.png") });
});

const HALF_TURN_CURVES = 8;

test("an oval laid piece by piece from the keyboard closes through the join it suggests, and Ctrl+Z walks it back one step at a time", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(700);
  await editor.choose(TRACK_ITEM);
  const run = await editor.dragTrack({ x: -320, z: 0 }, { x: 320, z: 0 });
  const keys = [
    ...Array<string>(HALF_TURN_CURVES).fill("a"),
    ...Array<string>(run.pieces).fill("w"),
    ...Array<string>(HALF_TURN_CURVES / 2).fill("a"),
  ];
  for (const key of keys) await editor.press(key);
  const suggested = await editor.trackChoice();
  await editor.press("Enter");
  const closed = await editor.trackCounts();
  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("oval-by-extending.png") });
  const left: number[] = [];
  for (let step = 0; step <= keys.length; step++) {
    await editor.undo();
    left.push((await editor.laidTrack()).length);
  }

  const loop = run.pieces + keys.length + HALF_TURN_CURVES / 2;
  expect(run).toMatchObject({ lastCommit: "laid", openEnds: 2 });
  expect(suggested).toEqual({ kind: "join", pieces: HALF_TURN_CURVES / 2, joins: true });
  expect(closed).toEqual({ lastCommit: "joined", pieces: loop, openEnds: 0, joins: loop });
  expect(left).toEqual([loop - HALF_TURN_CURVES / 2, ...keys.map((_, i) => loop - 5 - i)]);
});

test("an end that can't be joined, a refused drag and a blocked piece each say why", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(700);
  await editor.choose(TRACK_ITEM);
  const end = { x: -320, z: 0 };
  const offset = { x: -260, z: 40 };
  await editor.dragTrack({ x: -960, z: 0 }, end);
  await editor.dragTrack(offset, { x: 380, z: 40 });
  await editor.escape();
  const laid = (await editor.laidTrack()).length;

  await editor.hoverAt(await editor.screenOf(end));
  const pointed = await editor.toolHint();
  const released = await editor.dragTrack(end, offset);
  const releasedHint = await editor.toolHint();
  await editor.hoverAt(await editor.screenOf(end));
  await editor.press("w");
  const pressed = await editor.toolHint();

  expect(pointed).toContain("Next piece: straight (blocked)");
  expect(pointed).toContain("can't be joined: no exact join reaches it");
  expect(released.lastCommit).toBe("refused-impossible");
  expect(releasedHint).toContain("Nothing laid");
  expect(releasedHint).toContain("no exact join reaches that end");
  expect(pressed).toContain("Nothing laid");
  expect(pressed).toContain("the next piece would cross the track laid there");
  expect(await editor.laidTrack()).toHaveLength(laid);
});

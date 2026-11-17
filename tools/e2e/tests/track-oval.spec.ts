import { expect, test } from "@playwright/test";
import { EditorPage, STUD, TRACK_ITEM, nearestLattice } from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const HEADINGS = 16;
const EAST = 0;
const WEST = HEADINGS / 2;

test("a straight run on baseplates closed into an oval joins every end exactly", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(1400);
  const { wide } = await editor.itemStuds(BASEPLATE);
  const side = wide * STUD;
  const columns = [-2.5, -1.5, -0.5, 0.5, 1.5].map((k) => k * side);
  const rows = [-2.5, -1.5, -0.5, 0.5, 1.5, 2.5].map((k) => k * side);
  for (const x of columns) for (const z of rows) await editor.placeAt(BASEPLATE, { x, z });
  expect(await editor.poses()).toHaveLength(columns.length * rows.length);
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

  await page.screenshot({ path: test.info().outputPath("track-oval.png") });
});

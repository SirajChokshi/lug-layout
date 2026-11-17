import { expect, test } from "@playwright/test";
import { EditorPage, TRACK_ITEM, nearestLattice, type TrackEnd } from "./editor-page.ts";

const HEADINGS = 16;
const EAST = 0;
const WEST = HEADINGS / 2;

function endFacing(ends: ReadonlyArray<TrackEnd>, heading: number): TrackEnd {
  const end = ends.find((candidate) => candidate.heading === heading);
  if (!end) throw new Error(`no open end faces heading ${heading}: ${JSON.stringify(ends)}`);
  return end;
}

test("an oval through a right switch closes exactly, keeps its siding end open and throws without breaking a join", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(700);
  const rightSwitch = (await editor.catalog()).find(
    (entry) => entry.id.startsWith("track-piece:") && /switch right/iu.test(entry.label),
  );
  if (!rightSwitch) throw new Error("the Track palette has no right switch");

  const entry = { x: -400, z: 0 };
  await editor.placeAt(rightSwitch.id, entry);
  const laid = await editor.trackCounts();
  expect(laid.pieces).toBe(1);
  expect(laid.openEnds).toBe(3);
  const ends = await editor.trackEnds();
  const west = endFacing(ends, WEST);
  const east = endFacing(ends, EAST);
  const diverging = ends.find((end) => end !== west && end !== east);
  if (!diverging) throw new Error(`a switch has a diverging end: ${JSON.stringify(ends)}`);
  expect(west).toEqual({ xLdu: entry.x, zLdu: entry.z, heading: WEST });
  expect(east.zLdu).toBe(0);

  await editor.escape();
  await editor.choose(TRACK_ITEM);
  const oval = await editor.dragTrack(nearestLattice(east), nearestLattice(west));
  expect(oval.lastCommit).toBe("joined");
  expect(oval.openEnds).toBe(1);
  expect(oval.joins).toBe(oval.pieces);
  expect(await editor.trackEnds()).toEqual([diverging]);
  await expect(page.locator("section.track-panel")).toHaveAttribute("data-switches", "straight");
  await expect(page.locator("section.track-panel")).toHaveAttribute("data-gaps", "0");

  const switchBody = nearestLattice({
    xLdu: (west.xLdu + east.xLdu) / 2,
    zLdu: (west.zLdu + east.zLdu) / 2,
    heading: EAST,
  });
  await editor.escape();
  await editor.clickAt(switchBody);
  await expect(page.locator("section.track-panel")).toHaveAttribute("data-switches", "branching");
  const thrown = await editor.trackCounts();
  expect(thrown).toMatchObject({ pieces: oval.pieces, joins: oval.joins, openEnds: 1 });
  expect(await editor.trackEnds()).toEqual([diverging]);

  await page.screenshot({ path: test.info().outputPath("switch-oval.png") });
});

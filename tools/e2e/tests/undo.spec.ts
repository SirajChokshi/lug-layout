import { expect, test } from "@playwright/test";
import { EditorPage, TRACK_ITEM, type Pose } from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const PLAIN_MODULE = "generated:mils-plain";
const GROCER = "omr:10185-1";

test("undo walks every edit back to the exact earlier poses and redo replays them", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(400);
  const undoButton = page.locator('[data-action="undo"]');
  const redoButton = page.locator('[data-action="redo"]');
  const states: Array<ReadonlyArray<Pose>> = [await editor.poses()];
  const record = async (): Promise<void> => {
    states.push(await editor.poses());
  };

  await editor.placeAt(BASEPLATE, { x: 0, z: 0 });
  await record();
  await editor.placeAt(PLAIN_MODULE, { x: 960, z: 320 });
  await record();
  await editor.placeAt(GROCER, { x: -640, z: 0 });
  await record();
  expect(await editor.select({ x: 960, z: 320 })).toBe(PLAIN_MODULE);
  await editor.press("r");
  await record();
  expect(await editor.select({ x: 0, z: -160 })).toBe(BASEPLATE);
  await editor.press("Delete");
  await record();

  expect(states.map((poses) => poses.length)).toEqual([0, 1, 2, 3, 3, 2]);
  expect(states[4]?.find((pose) => pose.item === PLAIN_MODULE)?.rot).toBe(1);
  await expect(redoButton).toBeDisabled();

  for (let step = states.length - 1; step > 0; step--) {
    await editor.undo();
    expect(await editor.poses(), `after undoing edit ${step}`).toEqual(states[step - 1]);
  }
  await expect(undoButton).toBeDisabled();

  for (let step = 1; step < states.length; step++) {
    await editor.redo();
    expect(await editor.poses(), `after redoing edit ${step}`).toEqual(states[step]);
  }
  await expect(redoButton).toBeDisabled();
  await expect(undoButton).toBeEnabled();

  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("undo-redo.png") });
});

test("Ctrl+Z straight after drawing track lifts the track and keeps the baseplate placed before it, and Ctrl+Shift+Z lays it again", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(400);
  const undoButton = page.locator('[data-action="undo"]');
  await editor.placeAt(BASEPLATE, { x: 0, z: 0 });
  const placed = await editor.poses();
  await editor.escape();
  await editor.choose(TRACK_ITEM);

  const run = await editor.dragTrack({ x: -320, z: 0 }, { x: 320, z: 0 });
  const laid = await editor.laidTrack();
  const ends = await editor.trackEnds();
  expect(run).toMatchObject({ lastCommit: "laid", pieces: laid.length, openEnds: 2 });
  await expect(undoButton).toContainText(`Undo lay ${laid.length} pieces`);

  await editor.undo();
  expect(await editor.poses()).toEqual(placed);
  expect(await editor.laidTrack()).toEqual([]);
  expect(await editor.trackEnds()).toEqual([]);
  await expect(undoButton).toContainText("Undo place");

  await editor.redo();
  expect(await editor.poses()).toEqual(placed);
  expect(await editor.laidTrack()).toEqual(laid);
  expect(await editor.trackEnds()).toEqual(ends);
  expect(laid.length).toBeGreaterThan(0);

  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("undo-track-redone.png") });
});

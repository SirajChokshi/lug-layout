import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, STUD, type LatticePoint, type Pose } from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const BASEPLATE_HALF = 320;
const START: LatticePoint = { x: 800, z: 0 };
const GROUP_SHIFT = 640;

function customCottage(): string {
  return [
    "0 Custom cottage built for the multi-select test",
    "0 Name: custom-cottage.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3867.dat",
    "1 15 -40 -24 -60 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 15 40 -24 -60 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 15 -40 -24 60 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 15 40 -24 60 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 4 -40 -48 -60 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 4 40 -48 60 1 0 0 0 1 0 0 0 1 3001.dat",
    "",
  ].join("\n");
}

test("an imported model drags flush beside a baseplate and is refused one stud in, the arrows nudge it, and a box-selected group moves, turns, pastes and deletes, each one undo step", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const file = test.info().outputPath("custom-cottage.ldr");
  await writeFile(file, customCottage());
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  const cottage = imported.item;
  await editor.zoom(400);
  const states: Array<ReadonlyArray<Pose>> = [];
  const record = async (): Promise<void> => {
    states.push(await editor.poses());
  };
  const cottagePose = async (): Promise<Pose | undefined> =>
    (await editor.poses()).find((pose) => pose.item === cottage);

  await editor.placeAt(BASEPLATE, { x: 0, z: 0 });
  await editor.placeAt(cottage, START);
  await record();
  const footprint = (await editor.footprints()).find((entry) => entry.ref === cottage)?.box;
  if (!footprint) throw new Error("the cottage has no footprint");
  const flush: LatticePoint = { x: BASEPLATE_HALF + START.x - footprint.minX, z: 0 };
  const oneIn: LatticePoint = { x: flush.x - STUD, z: 0 };

  expect(await editor.select(START)).toBe(cottage);
  await editor.dragFrom(START, flush);
  expect(await cottagePose()).toMatchObject({ x: flush.x, z: flush.z });
  await record();
  const refusedBefore = await editor.counter("refused");
  await editor.dragFrom(flush, START, oneIn);
  expect(await cottagePose()).toMatchObject({ x: flush.x, z: flush.z });
  expect(await editor.counter("refused")).toBe(refusedBefore + 1);
  await expect(page.locator(".tool-hud")).toContainText("Can't move it there.");

  await editor.press("ArrowRight");
  expect(await cottagePose()).toMatchObject({ x: flush.x + STUD, z: 0 });
  await record();
  await editor.press("ArrowLeft");
  expect(await cottagePose()).toMatchObject({ x: flush.x, z: flush.z });
  await record();
  await editor.press("ArrowLeft");
  expect(await cottagePose()).toMatchObject({ x: flush.x, z: flush.z });
  expect(await editor.counter("refused")).toBe(refusedBefore + 2);

  await editor.escape();
  await editor.dragFrom({ x: -560, z: -480 }, { x: flush.x + 400, z: 480 });
  expect(await editor.selectionCount()).toBe(2);
  await editor.shiftClickAt({ x: 0, z: -200 });
  expect(await editor.selectionCount()).toBe(1);
  await editor.shiftClickAt({ x: 0, z: -200 });
  expect(await editor.selectionCount()).toBe(2);

  await editor.dragFrom({ x: 0, z: 0 }, { x: 0, z: GROUP_SHIFT });
  const shifted = await editor.poses();
  expect(shifted.map((pose) => pose.z)).toEqual([GROUP_SHIFT, GROUP_SHIFT]);
  await record();
  await editor.press("r");
  expect((await editor.poses()).map((pose) => pose.rot)).toEqual([1, 1]);
  await record();
  await editor.press("Control+c");
  await editor.press("Control+v");
  await expect(editor.root).toHaveAttribute("data-gesture", "paste");
  await editor.clickAt({ x: 160, z: -720 });
  expect(await editor.poses()).toHaveLength(4);
  expect(await editor.selectionCount()).toBe(2);
  await record();
  await editor.press("Delete");
  expect(await editor.poses()).toEqual(states.at(-2));
  await record();

  for (let step = states.length - 1; step > 0; step--) {
    await editor.undo();
    expect(await editor.poses(), `after undoing step ${step}`).toEqual(states[step - 1]);
  }

  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("multi-select.png") });
});

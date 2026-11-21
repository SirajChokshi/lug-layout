import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, STUD, type LatticePoint, type Pose } from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const BASEPLATE_HALF = 320;
const START: LatticePoint = { x: 800, z: 0 };
const CLEAR_X_STUDS = 60;
const GROUP_Z_STUDS = 20;

function customShed(): string {
  return [
    "0 Custom shed built for the properties panel test, a brick overhanging one edge by a stud",
    "0 Name: custom-shed.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3867.dat",
    "1 4 -60 -24 -60 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 14 -60 -48 -60 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 1 140 -24 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "",
  ].join("\n");
}

test("the properties panel moves an imported model by its position in studs and turns it in place about its origin through placement, refuses a collision, moves and turns a group, and Ctrl+Z walks every edit back", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const file = test.info().outputPath("custom-shed.ldr");
  await writeFile(file, customShed());
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  const shed = imported.item;
  await editor.zoom(400);
  const panel = page.getByRole("region", { name: "Selection" });
  const xField = panel.getByLabel("X studs");
  const zField = panel.getByLabel("Z studs");
  const states: Array<ReadonlyArray<Pose>> = [];
  const record = async (): Promise<void> => {
    states.push(await editor.poses());
  };
  const shedPose = async (): Promise<Pose | undefined> =>
    (await editor.poses()).find((pose) => pose.item === shed);
  const typeStuds = async (field: typeof xField, studs: number): Promise<void> => {
    await field.fill(String(studs));
    await field.press("Enter");
  };

  await editor.placeAt(BASEPLATE, { x: 0, z: 0 });
  await editor.placeAt(shed, START);
  await record();
  const footprint = (await editor.footprints()).find((entry) => entry.ref === shed)?.box;
  if (!footprint) throw new Error("the shed has no footprint");
  const flushX = BASEPLATE_HALF + START.x - footprint.minX;

  expect(await editor.select(START)).toBe(shed);
  await expect(panel).toContainText("17 × 16 studs");
  await expect(xField).toHaveValue(String(START.x / STUD));
  await expect(zField).toHaveValue(String(START.z / STUD));
  await expect(panel.getByRole("button", { name: "0°", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  await typeStuds(xField, flushX / STUD);
  expect(await shedPose()).toMatchObject({ x: flushX, z: 0, rot: 0 });
  await record();
  const refusedBefore = await editor.counter("refused");
  await typeStuds(xField, flushX / STUD - 1);
  expect(await shedPose()).toMatchObject({ x: flushX, z: 0, rot: 0 });
  expect(await editor.counter("refused")).toBe(refusedBefore + 1);
  await expect(xField).toHaveValue(String(flushX / STUD));
  await expect(page.locator(".tool-hud")).toContainText("Can't move it there.");

  await xField.fill(String(CLEAR_X_STUDS));
  await zField.focus();
  const clearX = CLEAR_X_STUDS * STUD;
  expect(await shedPose()).toMatchObject({ x: clearX, z: 0, rot: 0 });
  await record();
  await panel.getByRole("button", { name: "180°", exact: true }).click();
  expect(await shedPose()).toMatchObject({ x: clearX, z: 0, rot: 2 });
  await expect(xField).toHaveValue(String(CLEAR_X_STUDS));
  await record();
  await panel.getByRole("button", { name: "0°", exact: true }).click();
  expect(await shedPose()).toMatchObject({ x: clearX, z: 0, rot: 0 });
  await record();

  await editor.escape();
  await editor.dragFrom({ x: -560, z: -480 }, { x: clearX + 520, z: 480 });
  expect(await editor.selectionCount()).toBe(2);
  await expect(panel).toContainText("2 models");
  await expect(zField).toHaveValue("0");
  await typeStuds(zField, GROUP_Z_STUDS);
  expect((await editor.poses()).map((pose) => pose.z)).toEqual([
    GROUP_Z_STUDS * STUD,
    GROUP_Z_STUDS * STUD,
  ]);
  await expect(zField).toHaveValue(String(GROUP_Z_STUDS));
  await record();
  await panel.getByRole("button", { name: /^Turn(?! back)/u }).click();
  expect((await editor.poses()).map((pose) => pose.rot)).toEqual([1, 1]);
  await record();

  for (let step = states.length - 1; step > 0; step--) {
    await editor.undo();
    expect(await editor.poses(), `after undoing step ${step}`).toEqual(states[step - 1]);
  }
});

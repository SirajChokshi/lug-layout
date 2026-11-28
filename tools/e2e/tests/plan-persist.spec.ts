import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, byPosition, type LatticePoint, type Pose } from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const STATION_FILE = "my-signal-box.ldr";
const TABLE_ONE: readonly [LatticePoint, LatticePoint] = [
  { x: -1600, z: -640 },
  { x: 0, z: 640 },
];
const TABLE_TWO: readonly [LatticePoint, LatticePoint] = [
  { x: 1440, z: 640 },
  { x: 0, z: -640 },
];

const USER_SIGNAL_BOX = [
  `0 ${STATION_FILE}, a user's own model of official parts`,
  `0 Name: ${STATION_FILE}`,
  "0 Author: lug-layout e2e",
  "1 72 0 0 0 1 0 0 0 1 0 0 0 1 3031.dat",
  "1 4 -20 -24 0 0 0 1 0 1 0 -1 0 0 3001.dat",
  "1 4 20 -24 0 0 0 1 0 1 0 -1 0 0 3001.dat",
  "1 15 0 -32 0 1 0 0 0 1 0 0 0 1 3031.dat",
  "",
].join("\n");

function byPositionThenItem(a: Pose, b: Pose): number {
  return byPosition(a, b) || a.item.localeCompare(b.item);
}

async function planOf(editor: EditorPage) {
  return {
    poses: (await editor.poses()).toSorted(byPositionThenItem),
    plans: (await editor.plans()).map(({ id: _plan, footprint, ...plan }) => ({
      ...plan,
      room: [footprint.roomWidthMm, footprint.roomDepthMm],
      tables: footprint.tables.map(({ id: _table, ...table }) => table),
      obstacles: footprint.obstacles.map(({ id: _obstacle, ...obstacle }) => obstacle),
    })),
    rows: await editor.planRows(),
  };
}

test("tables drawn in a world, the plan's reach limit and a user's own model on them are still there after a reload, and another tab shows them without letting it edit the plan", async ({
  page,
}) => {
  const signalBoxFile = test.info().outputPath(STATION_FILE);
  await writeFile(signalBoxFile, USER_SIGNAL_BOX);
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const signalBox = await editor.importModel(signalBoxFile);
  expect(signalBox.status, signalBox.text).toBe("placeable");
  await editor.escape();
  await editor.zoom(500);

  await editor.drawTable(...TABLE_ONE);
  await editor.drawTable(...TABLE_TWO);
  await editor.placeAt(BASEPLATE, { x: -480, z: 0 });
  await editor.placeAt(signalBox.item, { x: -480, z: 0 });
  await editor.escape();
  const reach = page.locator('.plan-panel input[name="max-reach"]');
  await reach.fill("900");
  await reach.press("Enter");
  await editor.saved();
  await expect(page.locator(".plan-panel [data-unmeasured]")).toHaveCount(0);
  const drawn = await planOf(editor);
  expect(drawn.poses).toHaveLength(2);
  expect(drawn.plans.map((plan) => [plan.maxReachMm, plan.tables.length])).toEqual([[900, 2]]);
  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("tables-drawn.png") });

  await editor.reload();
  await expect(page.locator(".welcome")).toHaveCount(0);
  await expect.poll(() => planOf(editor)).toEqual(drawn);
  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("tables-reloaded.png") });

  const otherTab = await page.context().newPage();
  const other = await EditorPage.open(otherTab);
  await expect.poll(() => planOf(other)).toEqual(drawn);
  const panel = otherTab.locator(".plan-panel");
  for (const control of [
    panel.locator('input[name="max-reach"]'),
    panel.locator('[data-action="draw-table"]'),
    panel.locator('[data-action="add-table"]'),
    panel.locator('[data-action="new-plan"]'),
    panel.getByRole("button", { name: "Delete plan" }),
  ]) {
    await expect(control).toBeDisabled();
  }
  await expect(panel.locator('[data-action="download-sheets"]')).toBeEnabled();
  await other.press("b");
  await expect(other.root).toHaveAttribute("data-mode", "select");
  await otherTab.screenshot({ path: test.info().outputPath("tables-read-only.png") });
  await otherTab.close();
});

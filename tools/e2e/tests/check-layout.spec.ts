import { CHUNK_LDU, lduFromMm } from "@brr/math";
import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, STUD, startEmpty, type PlanRegion } from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const COTTAGE_FILE = "my-cottage.ldr";
const TABLE_GRID_LDU = 8 * STUD;
const PLATE_HALF_LDU = 16 * STUD;
const TRACK_Z_LDU = 2 * PLATE_HALF_LDU;
const STRAIGHT_LDU = 16 * STUD;

const USER_COTTAGE = [
  `0 ${COTTAGE_FILE}, a user's own cottage of official parts on a 6 x 8 plate`,
  `0 Name: ${COTTAGE_FILE}`,
  "0 Author: lug-layout e2e",
  "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3036.dat",
  "1 15 -20 -24 -40 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 15 -20 -24 40 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 4 -20 -48 0 0 0 1 0 1 0 -1 0 0 3001.dat",
  "",
].join("\n");

interface Rect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

function tablesInWorld(plan: PlanRegion): ReadonlyArray<Rect> {
  const x0 = plan.originChunkX * CHUNK_LDU;
  const z0 = plan.originChunkZ * CHUNK_LDU;
  return plan.footprint.tables.map(({ rect }) => ({
    minX: x0 + lduFromMm(rect.x),
    minZ: z0 + lduFromMm(rect.z),
    maxX: x0 + lduFromMm(rect.x + rect.width),
    maxZ: z0 + lduFromMm(rect.z + rect.depth),
  }));
}

function gridDown(ldu: number): number {
  return Math.floor(ldu / TABLE_GRID_LDU) * TABLE_GRID_LDU;
}

function gridUp(ldu: number): number {
  return Math.ceil(ldu / TABLE_GRID_LDU) * TABLE_GRID_LDU;
}

function onGridAround(boxes: ReadonlyArray<Rect>): Rect {
  return {
    minX: gridDown(Math.min(...boxes.map((box) => box.minX))),
    minZ: gridDown(Math.min(...boxes.map((box) => box.minZ))),
    maxX: gridUp(Math.max(...boxes.map((box) => box.maxX))),
    maxZ: gridUp(Math.max(...boxes.map((box) => box.maxZ))),
  };
}

async function planOf(editor: EditorPage) {
  return {
    tables: (await editor.plans()).map(tablesInWorld),
    rows: await editor.planRows(),
  };
}

async function worldMenu(page: Page) {
  const menu = page.locator(".world-menu");
  if ((await menu.getAttribute("open")) === null) await menu.locator("> summary").click();
  return menu;
}

test("Check this layout plans what's laid, a user's own model over a baseplate edge and a straight beside it, on one table round it all on the 8-stud grid, and the plan stays with its world", async ({
  page,
}) => {
  const cottageFile = test.info().outputPath(COTTAGE_FILE);
  await writeFile(cottageFile, USER_COTTAGE);
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const cottage = await editor.importModel(cottageFile);
  expect(cottage.status, cottage.text).toBe("placeable");
  await editor.escape();
  await editor.zoom(400);
  const panel = page.locator(".plan-panel");
  const check = panel.locator('[data-action="check-layout"]');
  await panel.locator("> summary").click();
  await expect(check).toBeDisabled();

  await editor.placeAt(BASEPLATE, { x: 0, z: 0 });
  await editor.placeAt(cottage.item, { x: PLATE_HALF_LDU, z: 0 });
  await editor.press("t");
  await editor.dragTrack({ x: -STRAIGHT_LDU, z: TRACK_Z_LDU }, { x: STRAIGHT_LDU, z: TRACK_Z_LDU });
  await editor.escape();
  const laid = await editor.footprints();
  const plate = laid.find((entry) => entry.ref === BASEPLATE)?.box;
  const own = laid.find((entry) => entry.ref === cottage.item)?.box;
  expect(own && plate && own.maxX > plate.maxX, "the cottage hangs over the plate's edge").toBe(
    true,
  );
  await page.screenshot({ path: test.info().outputPath("laid-without-a-plan.png") });

  await check.click();
  await expect(panel.locator("[data-unmeasured]")).toHaveCount(0);
  await editor.saved();
  const checked = await planOf(editor);
  await page.screenshot({ path: test.info().outputPath("checked.png") });

  expect(checked.tables).toEqual([[onGridAround(laid.map((entry) => entry.box))]]);
  expect(checked.rows.map((row) => [row.rule, row.severity])).toEqual([
    ["trackOpenEnd", "error"],
    ["trackOpenEnd", "error"],
  ]);
  await expect(panel.locator(".plan-meta", { hasText: "in the sandbox" })).toContainText(
    `${laid.length} placements in this plan · 0 in the sandbox`,
  );

  const worldOne = await page.locator(".world-name").getAttribute("data-world-id");
  const menu = await worldMenu(page);
  await menu.getByLabel("New world name").fill("Elsewhere");
  await menu.getByRole("button", { name: "New", exact: true }).click();
  await expect(page.locator(".world-glance strong")).toHaveText("Elsewhere");
  await startEmpty(page);
  await expect(page.locator(".plan-glance")).toHaveText("No plan yet");
  expect(await editor.plans()).toEqual([]);

  await (
    await worldMenu(page)
  )
    .locator(`[data-world-row="${worldOne}"]`)
    .getByRole("button", { name: "Open" })
    .click();
  await expect(page.locator(".world-glance strong")).not.toHaveText("Elsewhere");
  await expect.poll(() => planOf(editor)).toEqual(checked);
});

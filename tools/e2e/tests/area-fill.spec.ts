import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, type LatticePoint, type Pose } from "./editor-page.ts";

const GREEN_BASEPLATE = "ldraw:3811@2";
const DRAG_STEPS = 8;
const GRID_16_LDU = 16 * 20;
const FILLING = /Filling (\d+) ×/u;

function customShed(): string {
  return [
    "0 Custom shed built for the area fill test",
    "0 Name: fill-shed.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 4 0 0 40 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 14 -20 -24 20 1 0 0 0 1 0 0 0 1 3003.dat",
    "",
  ].join("\n");
}

async function frames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  await testInfo.attach(name, { body: await page.screenshot(), contentType: "image/png" });
}

async function dragFill(
  editor: EditorPage,
  testInfo: TestInfo,
  name: string,
  from: LatticePoint,
  to: LatticePoint,
): Promise<string> {
  const { page } = editor;
  const a = await editor.screenOf(from);
  const b = await editor.screenOf(to);
  await page.mouse.move(a.sx, a.sy);
  await frames(page);
  await page.mouse.down();
  for (let step = 1; step <= DRAG_STEPS; step++) {
    const t = step / DRAG_STEPS;
    await page.mouse.move(a.sx + (b.sx - a.sx) * t, a.sy + (b.sy - a.sy) * t);
  }
  await frames(page);
  const preview = await editor.toolHint();
  await screenshot(page, testInfo, `${name}-preview`);
  await page.mouse.up();
  await frames(page);
  await screenshot(page, testInfo, `${name}-placed`);
  return preview;
}

function heldPoses(poses: ReadonlyArray<Pose>, item: string): ReadonlyArray<Pose> {
  return poses.filter((pose) => pose.item === item);
}

test("drags a fill of baseplates across a seated one, skips the refused tile, and one undo takes the fill back", async ({
  page,
}, testInfo) => {
  const editor = await EditorPage.open(page);
  await editor.goTo({ x: 960, z: 320 });
  await editor.zoom(400);
  await editor.placeAt(GREEN_BASEPLATE, { x: 960, z: 320 });
  await editor.press("Shift+G");
  await editor.press("Shift+G");
  expect(await editor.toolHint()).toContain("32-stud grid");

  const preview = await dragFill(
    editor,
    testInfo,
    "baseplates",
    { x: 0, z: 0 },
    { x: 1900, z: 20 },
  );
  const filled = await editor.toolHint();
  const placed = heldPoses(await editor.poses(), GREEN_BASEPLATE).map((pose) => pose.x);
  await editor.undo();
  const undone = (await editor.poses()).length;
  await editor.redo();

  expect(preview).toContain("2 to place, 1 refused and skipped");
  expect(filled).toContain("skipped 1 refused");
  expect(filled).toContain("would hit Baseplate 32 x 32 in 3811 Baseplate 32 x 32, Green");
  expect(placed).toEqual([320, 960, 1600]);
  expect(undone).toBe(1);
  expect((await editor.poses()).length).toBe(3);
});

test("fills a dragged area and the plan's table with a user's own model, at its footprint rounded up to the 16-stud grid", async ({
  page,
}, testInfo) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  await editor.goTo({ x: 640, z: 320 });
  await editor.zoom(400);
  const shedFile = testInfo.outputPath("fill-shed.ldr");
  await writeFile(shedFile, customShed());
  const shed = await editor.importModel(shedFile);
  expect(shed.status, shed.text).toBe("placeable");
  await editor.choose(shed.item);
  await editor.press("Shift+G");

  const preview = await dragFill(editor, testInfo, "custom", { x: 0, z: 0 }, { x: 1260, z: 600 });
  const dragged = heldPoses(await editor.poses(), shed.item);
  await page.locator(".plan-panel > summary").click();
  await page.locator('[data-action="new-plan"]').click();
  await page.locator('[data-action="add-table"]').click();
  await page.locator('[data-action="fill-tables"]').click();
  await frames(page);
  await screenshot(page, testInfo, "tables-filled");
  const total = heldPoses(await editor.poses(), shed.item).length;

  expect(Number(FILLING.exec(preview)?.[1])).toBe(dragged.length);
  expect(dragged.length).toBeGreaterThan(1);
  for (const pose of dragged) {
    expect([Math.abs((pose.x - (dragged[0]?.x ?? 0)) % GRID_16_LDU), pose.yPlates]).toEqual([0, 0]);
  }
  expect(await editor.toolHint()).toContain(`Filled ${total - dragged.length} ×`);
  expect(total).toBeGreaterThan(dragged.length);
});

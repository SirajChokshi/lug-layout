import { expect, test } from "@playwright/test";
import { EditorPage } from "./editor-page.ts";

const GROCER = "omr:10185-1";

test("the cursor says a picked set is loading, and a click made meanwhile places it there once it has loaded", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(400);
  const point = await editor.screenOf({ x: -640, z: 0 });
  const release = await editor.holdModelRecords();

  await editor.pick(GROCER);
  await page.mouse.move(point.sx, point.sy);
  await expect(page.locator(".placement-chip")).toContainText("Loading 10185-1 Green Grocer");
  await page.mouse.click(point.sx, point.sy);
  await expect(page.locator(".tool-hud")).toContainText(
    "Queued: placing at stud -32, 0 when ready",
  );
  const whileLoading = { tables: await editor.heldTables(), poses: await editor.poses() };
  release();

  expect(whileLoading).toEqual({ tables: "loading", poses: [] });
  await expect
    .poll(() => editor.poses())
    .toEqual([{ item: GROCER, x: -640, z: 0, yPlates: 0, rot: 0 }]);
  expect(await editor.heldTables()).toBe("ready");
});

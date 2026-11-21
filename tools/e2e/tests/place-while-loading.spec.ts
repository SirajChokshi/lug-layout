import { expect, test } from "@playwright/test";
import { EditorPage } from "./editor-page.ts";

const GROCER = "omr:10185-1";

test("a click made while a set's connectors load places it there once they load", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(400);
  const point = await editor.screenOf({ x: -640, z: 0 });
  const release = await editor.holdConnectorRecords();

  await editor.pick(GROCER);
  await page.mouse.click(point.sx, point.sy);
  await expect(page.locator(".tool-hud")).toContainText("Queued: placing at -640, 0 when ready");
  const whileLoading = { tables: await editor.heldTables(), poses: await editor.poses() };
  release();

  expect(whileLoading).toEqual({ tables: "loading", poses: [] });
  await expect
    .poll(() => editor.poses())
    .toEqual([{ item: GROCER, x: -640, z: 0, yPlates: 0, rot: 0 }]);
  expect(await editor.heldTables()).toBe("ready");
});

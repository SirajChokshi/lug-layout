import { expect, test, type Locator, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, STUD, TRACK_ITEM } from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const STRAIGHT_LDU = 16 * STUD;
const SIGNAL_BOX_AT = { x: 2 * STRAIGHT_LDU, z: 20 * STUD };
const NEW_BASEPLATE_AT = { x: STRAIGHT_LDU, z: -40 * STUD };
const NUDGES = 6;

function mySignalBox(): string {
  return [
    "0 My signal box, a user's own model built from official parts",
    "0 Name: my-signal-box.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 7 0 0 0 1 0 0 0 1 0 0 0 1 3036.dat",
    "1 4 -20 -24 -40 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 4 -20 -48 -40 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 1 20 -24 40 1 0 0 0 1 0 0 0 1 3003.dat",
    "",
  ].join("\n");
}

async function worldMenu(page: Page): Promise<Locator> {
  const menu = page.locator(".world-menu");
  if ((await menu.getAttribute("open")) === null) await menu.locator("> summary").click();
  return menu;
}

test("a named version compared with later edits outlines in the 2D plan a user's own model moved, a track piece removed and a baseplate added, and Stop clears them", async ({
  page,
}) => {
  const file = test.info().outputPath("my-signal-box.ldr");
  await writeFile(file, mySignalBox());
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const signalBox = await editor.importModel(file);
  expect(signalBox.status, signalBox.text).toBe("placeable");
  await page.getByRole("button", { name: "2D plan" }).click();
  await editor.zoom(400);
  await editor.choose(TRACK_ITEM);
  await editor.dragTrack({ x: 0, z: 0 }, { x: 4 * STRAIGHT_LDU, z: 0 });
  await editor.placeAt(signalBox.item, SIGNAL_BOX_AT);
  await editor.escape();

  const menu = await worldMenu(page);
  await menu.getByLabel("Version name").fill("BW 2027 v1");
  await menu.getByRole("button", { name: "Save version" }).click();
  await expect(menu.locator("[data-version]")).toHaveText([/^BW 2027 v1 /u]);

  expect(await editor.select(SIGNAL_BOX_AT)).toBe(signalBox.item);
  for (let nudge = 0; nudge < NUDGES; nudge++) await editor.press("ArrowRight");
  await editor.select({ x: STRAIGHT_LDU / 2, z: 0 });
  await editor.press("Delete");
  await editor.placeAt(BASEPLATE, NEW_BASEPLATE_AT);
  await editor.escape();
  await expect(page.locator(".world-name")).toHaveAttribute("data-save", "saved");
  await page.screenshot({ path: test.info().outputPath("edited-since-the-version.png") });

  await menu.getByRole("button", { name: "Compare" }).click();
  const legend = menu.locator(".version-diff");
  await expect(legend).toHaveAttribute("data-moved", "1");
  const counts = {
    added: await legend.getAttribute("data-added"),
    removed: await legend.getAttribute("data-removed"),
    moved: await legend.getAttribute("data-moved"),
  };
  await page.screenshot({ path: test.info().outputPath("compared-with-the-version.png") });
  await editor.undo();
  await expect(legend).toHaveAttribute("data-added", "0");
  await menu.getByRole("button", { name: "Stop" }).click();

  expect(counts).toEqual({ added: "1", removed: "1", moved: "1" });
  await expect(legend).toHaveCount(0);
});

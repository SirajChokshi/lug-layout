import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, TRACK_ITEM } from "./editor-page.ts";

const GREEN_BASEPLATE = "ldraw:3811@2";
const IMPORT_REF = /^import:[0-9a-f]{64}$/u;
const YARD_STUDS = "16×16";

function customYard(): string {
  return [
    "0 Custom yard built for the hotbar test",
    "0 Name: hotbar-yard.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 7 0 0 0 1 0 0 0 1 0 0 0 1 3867.dat",
    "1 4 -100 -24 -100 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 14 60 -24 80 1 0 0 0 1 0 0 0 1 3003.dat",
    "",
  ].join("\n");
}

test("an imported model takes the next hotbar slot by its footprint, and digits and clicks pick each slot again", async ({
  page,
}, testInfo) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const yardFile = testInfo.outputPath("hotbar-yard.ldr");
  await writeFile(yardFile, customYard());

  await editor.choose(GREEN_BASEPLATE);
  await editor.choose(TRACK_ITEM);
  const yard = await editor.importModel(yardFile);
  expect(yard.status, yard.text).toBe("placeable");
  expect(yard.item).toMatch(IMPORT_REF);
  await editor.escape();

  const slots = page.locator(".hotbar .hotbar-slot");
  const slotItems = () => slots.evaluateAll((buttons) => buttons.map((b) => b.dataset["item"]));
  const pressed = page.locator('.hotbar .hotbar-slot[aria-pressed="true"]');
  expect(await slotItems()).toEqual([GREEN_BASEPLATE, TRACK_ITEM, yard.item]);
  await expect(slots.nth(2).locator(".hotbar-size")).toHaveText(YARD_STUDS);
  await expect(pressed).toHaveCount(0);

  await editor.press("3");
  await expect(pressed).toHaveAttribute("data-item", yard.item);
  await editor.press("1");
  await expect(pressed).toHaveAttribute("data-item", GREEN_BASEPLATE);
  await slots.nth(1).click();
  await expect(pressed).toHaveAttribute("data-item", TRACK_ITEM);

  await editor.press("?");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(sheet).toBeVisible();
  await editor.press("3");
  await editor.escape();
  await expect(sheet).toHaveCount(0);
  await expect(pressed).toHaveAttribute("data-item", TRACK_ITEM);
  expect(await slotItems()).toEqual([GREEN_BASEPLATE, TRACK_ITEM, yard.item]);
});

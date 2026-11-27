import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  COTTAGE_NAME,
  EditorPage,
  TRACK_ITEM,
  usersCottage,
  type LatticePoint,
} from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const FIRST: LatticePoint = { x: 0, z: 0 };
const SECOND: LatticePoint = { x: 200, z: 0 };
const ON_THE_LINE: LatticePoint = { x: 0, z: 800 };
const STRAIGHT = "ldraw:74746";

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

async function inventoryParts(page: Page, name: string): Promise<string | null> {
  const panel = page.locator(".contributors-panel");
  if ((await panel.getAttribute("open")) === null) await panel.locator("> summary").click();
  await panel.locator(".contributor-row", { hasText: name }).locator(".layer-name").click();
  return panel.getByRole("group", { name: `Inventory of "${name}"` }).getAttribute("data-parts");
}

test("contributors bring inventories from a collection CSV or counts of the selection, own vs buy compares a layout holding a user's own model with their sum, and the inventories survive a reload and an exported world", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const file = test.info().outputPath(COTTAGE_NAME);
  await writeFile(file, usersCottage());
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  await editor.zoom(700);
  await editor.placeAt(BASEPLATE, FIRST);
  await editor.placeAt(imported.item, FIRST);
  await editor.placeAt(imported.item, SECOND);
  await editor.escape();
  await editor.choose(TRACK_ITEM);
  const laid = await editor.dragTrack({ x: -400, z: ON_THE_LINE.z }, { x: 400, z: ON_THE_LINE.z });
  expect(laid.pieces).toBeGreaterThan(1);
  await editor.escape();

  const panel = page.locator(".contributors-panel");
  await panel.locator("summary").click();
  for (const name of ["Ada", "Linus"]) {
    await panel.getByRole("button", { name: "New contributor" }).click();
    const naming = panel.getByRole("textbox", { name: /^Rename contributor/u });
    await naming.fill(name);
    await naming.press("Enter");
  }

  await panel.locator(".contributor-row", { hasText: "Ada" }).locator(".layer-name").click();
  const adas = panel.getByRole("group", { name: 'Inventory of "Ada"' });
  const collection = test.info().outputPath("ada-collection.csv");
  await writeFile(collection, "Part,Color,Quantity\n3001,4,2\n3811,2,1\nnot a part row\n");
  await adas.locator('input[type="file"]').setInputFiles(collection);
  await expect(adas).toHaveAttribute("data-parts", "3");
  await expect(adas).toContainText("Read 3 parts from ada-collection.csv.");
  await expect(adas).toContainText("line 4");

  await panel.locator(".contributor-row", { hasText: "Linus" }).locator(".layer-name").click();
  const linus = panel.getByRole("group", { name: 'Inventory of "Linus"' });
  await editor.select(ON_THE_LINE);
  expect(await editor.selectionCount()).toBe(1);
  await linus.getByRole("button", { name: "Count the selection" }).click();
  const straights = linus.getByLabel(`Count of ${STRAIGHT} colour 0`);
  await expect(straights).toHaveValue("1");
  await straights.fill(String(laid.pieces - 1));
  await straights.blur();
  await expect(linus).toHaveAttribute("data-parts", String(laid.pieces - 1));
  await editor.escape();

  await page.getByRole("button", { name: "Build parts list" }).click();
  const ownVsBuy = page.locator(".own-vs-buy");
  await ownVsBuy.getByLabel("Compare with").selectOption("event");
  await expect(ownVsBuy).toHaveAttribute("data-budget-parts", String(laid.pieces + 2));
  await expect(ownVsBuy).toHaveAttribute("data-buy", "1");
  await expect(ownVsBuy).toHaveAttribute("data-own", String(laid.pieces + 2));
  await shot(page, "inventories-event-budget");
  await expect(page.locator(".world-name")).toHaveAttribute("data-save", "saved");

  const menu = page.locator(".world-menu");
  if ((await menu.getAttribute("open")) === null) await menu.locator("> summary").click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    menu.getByRole("button", { name: "Export .brr.zip" }).click(),
  ]);
  const exported = test.info().outputPath("show.brr.zip");
  await download.saveAs(exported);

  const reopened = await EditorPage.open(page);
  const reloaded = {
    ada: await inventoryParts(page, "Ada"),
    linus: await inventoryParts(page, "Linus"),
  };
  const first = await reopened.root.getAttribute("data-world");
  await page.getByLabel("Import a .brr.zip world").setInputFiles(exported);
  await expect(reopened.root).not.toHaveAttribute("data-world", first ?? "");
  await expect(reopened.root).toHaveAttribute("data-status", "ready");
  const reimported = {
    ada: await inventoryParts(page, "Ada"),
    linus: await inventoryParts(page, "Linus"),
  };
  await shot(page, "inventories-reimported");

  const expected = { ada: "3", linus: String(laid.pieces - 1) };
  expect({ reloaded, reimported }).toEqual({ reloaded: expected, reimported: expected });
});

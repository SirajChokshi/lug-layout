import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, TRACK_ITEM, type LatticePoint } from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const COTTAGE_NAME = "my-cottage.mpd";
const FIRST: LatticePoint = { x: 0, z: 0 };
const SECOND: LatticePoint = { x: 200, z: 0 };
const ON_THE_LINE: LatticePoint = { x: 0, z: 800 };
const PLACEMENTS_ROW = /^Placements(\d+)/u;

function usersCottage(): string {
  return [
    `0 FILE ${COTTAGE_NAME}`,
    "0 My cottage, a user's own model with a part of its own, built for the layers test",
    `0 Name: ${COTTAGE_NAME}`,
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 1 0 -24 0 1 0 0 0 1 0 0 0 1 my-brick.dat",
    "0 NOFILE",
    "0 FILE my-brick.dat",
    "0 My brick, the user's own part",
    "0 Name: my-brick.dat",
    "0 Author: lug-layout e2e (generated at test time) [James Jessiman]",
    "0 !LDRAW_ORG Unofficial_Part",
    "1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "0 NOFILE",
    "",
  ].join("\n");
}

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

async function partsListPlacements(page: Page, includeHidden: boolean): Promise<number> {
  const list = page.locator("section.bom");
  await list.getByLabel(/^Include hidden layers/u).setChecked(includeHidden);
  await list.getByRole("button", { name: "Build parts list" }).click();
  const row = list.locator("dl > div").filter({ hasText: /^Placements/u });
  await expect(row).toContainText(includeHidden ? /^Placements\d+$/u : /hidden layers left out/u);
  const match = PLACEMENTS_ROW.exec((await row.textContent()) ?? "");
  return Number(match?.[1]);
}

test("a user's own models and laid track move to a new layer from the Selection panel, the hidden layer is picked through and left out of the parts list, and the layer is removed only once emptied", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const file = test.info().outputPath(COTTAGE_NAME);
  await writeFile(file, usersCottage());
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  const cottage = imported.item;
  await editor.zoom(700);
  await editor.placeAt(BASEPLATE, FIRST);
  await editor.placeAt(cottage, FIRST);
  await editor.placeAt(cottage, SECOND);
  await editor.escape();
  await editor.choose(TRACK_ITEM);
  const laid = await editor.dragTrack({ x: -400, z: ON_THE_LINE.z }, { x: 400, z: ON_THE_LINE.z });
  expect(laid.pieces).toBeGreaterThan(1);
  await editor.escape();
  const before = await editor.layered();

  const panel = page.locator(".layers-panel");
  await panel.locator("summary").click();
  await panel.getByRole("button", { name: "New layer" }).click();
  const naming = panel.getByRole("textbox", { name: /^Rename layer/u });
  await naming.fill("Scenery");
  await naming.press("Enter");
  const row = panel.locator(".layer-row", { hasText: "Scenery" });
  await expect(row).toHaveAttribute("data-active", "");
  const scenery = Number(await row.getAttribute("data-layer"));

  expect(await editor.select(FIRST)).toBe(cottage);
  await editor.shiftClickAt(SECOND);
  await editor.shiftClickAt(ON_THE_LINE);
  expect(await editor.selectionCount()).toBe(3);
  const layerField = page.locator(".selection-panel").getByLabel("Layer");
  await expect(layerField).toHaveValue("0");
  await layerField.selectOption({ label: "Scenery" });
  await expect(layerField).toHaveValue(String(scenery));
  const moved = await editor.layered();
  await expect(row.locator(".layer-count")).toHaveText("3");
  await editor.waitForFarTierAndMeshesSettled();
  await shot(page, "layers-moved");

  await row.getByRole("button", { name: 'Show "Scenery"' }).click();
  expect(await editor.select(FIRST)).toBe(BASEPLATE);
  const shownOnly = await partsListPlacements(page, false);
  const everything = await partsListPlacements(page, true);
  await shot(page, "layers-hidden");
  await row.getByRole("button", { name: 'Show "Scenery"' }).click();

  await panel.getByRole("button", { name: "Remove" }).click();
  await expect(panel.getByRole("alert")).toHaveText(
    '"Scenery" holds 2 models and 1 track piece; move them to another layer or delete them first.',
  );
  await shot(page, "layers-remove-refused");
  await panel.getByRole("button", { name: "Select all" }).click();
  expect(await editor.selectionCount()).toBe(3);
  await layerField.selectOption({ label: "Parts" });
  await panel.getByRole("button", { name: "Remove" }).click();
  await expect(panel.locator(".layer-row")).toHaveCount(1);
  const emptied = await editor.layered();
  await shot(page, "layers-removed");
  await editor.undo();
  await editor.undo();
  await expect(row).toHaveCount(1);

  expect({
    moved,
    emptied,
    restored: await editor.layered(),
    hidden: everything - shownOnly,
  }).toEqual({
    moved: {
      placements: [
        `${BASEPLATE} on 0`,
        `${cottage} on ${scenery}`,
        `${cottage} on ${scenery}`,
      ].toSorted(),
      track: [...before.track.slice(1), scenery],
    },
    emptied: before,
    restored: moved,
    hidden: 3,
  });
});

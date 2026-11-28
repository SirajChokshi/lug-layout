import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, TRACK_ITEM, type LatticePoint } from "./editor-page.ts";

const NINE_VOLT_STRAIGHT = "track-piece:ldraw:74746";
const PLASTIC_STRAIGHT = "track-piece:ldraw:53401";
const NINE_VOLT_CURVE = "track-piece:ldraw:74747";
const LAYOUT_NAME = "custom-track-plate.ldr";
const LAYOUT_AT: LatticePoint = { x: 0, z: 800 };
const STRAIGHT_LDU = 320;
const RUN_STRAIGHTS = 4;

function customLayout(): string {
  return [
    "0 Custom baseplate with two straights, built for the track replace test",
    `0 Name: ${LAYOUT_NAME}`,
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
    "1 16 -160 0 0 1 0 0 0 1 0 0 0 1 74746.dat",
    "1 16 160 0 0 1 0 0 0 1 0 0 0 1 74746.dat",
    "",
  ].join("\n");
}

test("replacing every laid 9V straight with a plastic straight keeps each join, including the one to an imported layout's own track, lists the pieces a curve can't replace, and undo puts the 9V straights back", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const file = test.info().outputPath(LAYOUT_NAME);
  await writeFile(file, customLayout());
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  await editor.zoom(700);
  await editor.placeAt(imported.item, LAYOUT_AT);
  await editor.escape();
  const [end] = (await editor.trackEnds()).filter((open) => open.heading === 0);
  if (!end) throw new Error("the imported layout's track has no open end facing +x");

  await editor.choose(TRACK_ITEM);
  const laid = await editor.dragTrack(
    { x: end.xLdu, z: end.zLdu },
    { x: end.xLdu + RUN_STRAIGHTS * STRAIGHT_LDU, z: end.zLdu },
  );
  await editor.escape();
  const refs = async () => (await editor.laidTrack()).map((piece) => piece.ref);
  const nineVolt = await refs();
  expect(new Set(nineVolt)).toEqual(new Set(["ldraw:74746"]));

  expect(await editor.select({ x: end.xLdu + STRAIGHT_LDU / 2, z: end.zLdu })).toBe(
    NINE_VOLT_STRAIGHT,
  );
  const panel = page.locator("section.selection-panel");
  const replace = panel.locator(".selection-replace");
  await replace.locator("select").selectOption(PLASTIC_STRAIGHT);
  await replace.getByRole("button", { name: "Replace all" }).click();

  await expect(replace).toHaveAttribute("data-swapped", String(laid.pieces));
  await expect(replace).toHaveAttribute("data-kept", "0");
  expect(await refs()).toEqual(nineVolt.map(() => "ldraw:53401"));
  expect(await editor.trackCounts()).toEqual(laid);
  expect(await editor.root.getAttribute("data-selection")).toBe(PLASTIC_STRAIGHT);
  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("replaced-with-plastic.png") });

  await replace.locator("select").selectOption(NINE_VOLT_CURVE);
  await replace.getByRole("button", { name: "Replace all" }).click();
  await expect(replace).toHaveAttribute("data-swapped", "0");
  await expect(replace).toHaveAttribute("data-kept", String(laid.pieces));
  await expect(replace.getByRole("list", { name: "Pieces not swapped" })).toContainText(
    "has no pose whose ends land exactly on this piece's ends",
  );
  expect(await refs()).toEqual(nineVolt.map(() => "ldraw:53401"));
  await page.screenshot({ path: test.info().outputPath("curve-not-swapped.png") });

  await editor.undo();
  expect(await refs()).toEqual(nineVolt);
  expect(await editor.trackCounts()).toEqual(laid);
});

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
const NOBODY = -1;

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

test("a user's own models and laid track are assigned to contributors from the Selection panel, drawn in their colours, moved onto a contributor's own layer, and kept with the roster through a reload", async ({
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
  const unassigned = await editor.tagged("owner");
  const unlayered = await editor.tagged("layer");

  const panel = page.locator(".contributors-panel");
  await panel.locator("summary").click();
  for (const name of ["Ada", "Grace"]) {
    await panel.getByRole("button", { name: "New contributor" }).click();
    const naming = panel.getByRole("textbox", { name: /^Rename contributor/u });
    await naming.fill(name);
    await naming.press("Enter");
  }
  const row = (name: string) => panel.locator(".contributor-row", { hasText: name });
  const ada = Number(await row("Ada").getAttribute("data-contributor"));
  const grace = Number(await row("Grace").getAttribute("data-contributor"));

  const field = page.locator(".selection-panel").getByLabel("Contributor");
  expect(await editor.select(FIRST)).toBe(cottage);
  await editor.shiftClickAt(ON_THE_LINE);
  await expect(field).toHaveValue(String(NOBODY));
  await field.selectOption({ label: "Ada" });
  await expect(field).toHaveValue(String(ada));
  expect(await editor.select(SECOND)).toBe(cottage);
  await field.selectOption({ label: "Grace" });
  await expect(row("Ada").locator(".layer-count")).toHaveText("2");
  await expect(row("Grace").locator(".layer-count")).toHaveText("1");
  const assigned = await editor.tagged("owner");
  await editor.escape();
  await editor.waitForFarTierAndMeshesSettled();
  await shot(page, "contributors-assigned");

  await panel.getByLabel("Colour by contributor").check();
  await editor.waitForFarTierAndMeshesSettled();
  await shot(page, "contributors-coloured");

  await row("Ada").locator(".layer-name").click();
  await panel.getByRole("button", { name: "Own layer" }).click();
  const adaLayer = Number(
    await page.locator(".layers-panel .layer-row", { hasText: "Ada" }).getAttribute("data-layer"),
  );
  const layered = await editor.tagged("layer");
  await editor.waitForFarTierAndMeshesSettled();
  await expect(page.locator(".world-name")).toHaveAttribute("data-save", "saved");

  const reopened = await EditorPage.open(page);
  await expect
    .poll(() => reopened.tagged("owner"), { timeout: 180_000, message: "the owners come back" })
    .toEqual(assigned);
  const roster = page.locator(".contributors-panel .contributor-row .layer-name-text");

  expect({ assigned, layered, roster: await roster.allTextContents() }).toEqual({
    assigned: {
      placements: [
        `${BASEPLATE} owner ${NOBODY}`,
        `${cottage} owner ${ada}`,
        `${cottage} owner ${grace}`,
      ].toSorted(),
      track: [...unassigned.track.slice(1), ada],
    },
    layered: {
      placements: [
        `${BASEPLATE} layer 0`,
        `${cottage} layer ${adaLayer}`,
        `${cottage} layer 0`,
      ].toSorted(),
      track: [...unlayered.track.slice(1), adaLayer],
    },
    roster: ["Ada", "Grace"],
  });
});

import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, STUD, byPosition } from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const SIDE_STUDS = 32;
const OVERHANG_STUDS = 2;
const SIDE = SIDE_STUDS * STUD;

const DETAILS = {
  title: "Brickworld 2027 main line",
  club: "PennLUG",
  startDate: "2027-06-20",
  endDate: "2027-06-22",
  comment: "Hall B, tables against the north wall",
} as const;

const SIZE = {
  studs: `${2 * SIDE_STUDS + OVERHANG_STUDS} × ${SIDE_STUDS}`,
  modules: "0.69 × 0.33",
  metres: "0.53 × 0.26",
  feet: "1.73 × 0.84",
} as const;

function overhangingModule(): string {
  return [
    "0 A user's module whose brick hangs two studs past its baseplate's east edge",
    "0 Name: overhanging-module.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
    `1 4 ${SIDE / 2} -24 0 1 0 0 0 1 0 0 0 1 3001.dat`,
    "",
  ].join("\n");
}

function eventPanel(page: Page) {
  return page.locator(".event-panel");
}

async function openEventPanel(page: Page): Promise<void> {
  const panel = eventPanel(page);
  if ((await panel.getAttribute("open")) === null) await panel.locator("> summary").click();
  await expect(panel).toHaveAttribute("open", "");
}

async function shownSize(page: Page): Promise<Record<keyof typeof SIZE, string>> {
  const row = (unit: keyof typeof SIZE) =>
    eventPanel(page).locator(`[data-unit="${unit}"] td`).innerText();
  return {
    studs: await row("studs"),
    modules: await row("modules"),
    metres: await row("metres"),
    feet: await row("feet"),
  };
}

async function shownDetails(page: Page): Promise<Record<keyof typeof DETAILS, string>> {
  const value = (field: keyof typeof DETAILS) =>
    eventPanel(page).locator(`[data-field="${field}"]`).inputValue();
  return {
    title: await value("title"),
    club: await value("club"),
    startDate: await value("startDate"),
    endDate: await value("endDate"),
    comment: await value("comment"),
  };
}

test("the event panel measures a user's overhanging module beside a baseplate from their geometry, and its details come back with the world after a reload", async ({
  page,
}) => {
  const file = test.info().outputPath("overhanging-module.ldr");
  await writeFile(file, overhangingModule());
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  await editor.zoom(400);
  await editor.placeAt(imported.item, { x: 0, z: 0 });
  await editor.placeAt(BASEPLATE, { x: -SIDE, z: 0 });
  await editor.escape();
  const placed = await editor.poses();
  expect(placed).toEqual(
    [
      { item: imported.item, x: 0, z: 0, yPlates: 0, rot: 0 },
      { item: BASEPLATE, x: -SIDE, z: 0, yPlates: 0, rot: 0 },
    ].toSorted(byPosition),
  );

  await openEventPanel(page);
  expect(await shownSize(page)).toEqual(SIZE);
  const panel = eventPanel(page);
  for (const [field, value] of Object.entries(DETAILS)) {
    await panel.locator(`[data-field="${field}"]`).fill(value);
  }
  await panel.getByRole("button", { name: "Apply" }).click();
  await expect(panel.locator(".event-glance")).toHaveText(DETAILS.title);
  await expect(page.locator(".world-name")).toHaveAttribute("data-save", "saved");
  await panel.screenshot({ path: test.info().outputPath("event-panel-applied.png") });
  await page.screenshot({ path: test.info().outputPath("event-panel-layout.png") });

  const reopened = await EditorPage.open(page);
  await expect
    .poll(() => reopened.poses(), { timeout: 180_000, message: "the import comes back" })
    .toEqual(placed);
  await openEventPanel(page);
  await expect(eventPanel(page).locator(".event-glance")).toHaveText(DETAILS.title);
  expect({ details: await shownDetails(page), size: await shownSize(page) }).toEqual({
    details: DETAILS,
    size: SIZE,
  });
  await eventPanel(page).screenshot({
    path: test.info().outputPath("event-panel-reloaded.png"),
  });
});

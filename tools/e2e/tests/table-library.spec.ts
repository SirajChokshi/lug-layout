import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, type LatticePoint } from "./editor-page.ts";

const HUT_FILE = "my-crossing-hut.ldr";
const USER_HUT = [
  `0 ${HUT_FILE}, a user's own model of official parts`,
  `0 Name: ${HUT_FILE}`,
  "0 Author: lug-layout e2e",
  "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3031.dat",
  "1 15 -20 -24 0 0 0 1 0 1 0 -1 0 0 3001.dat",
  "1 15 20 -24 0 0 0 1 0 1 0 -1 0 0 3001.dat",
  "1 4 0 -32 0 1 0 0 0 1 0 0 0 1 3031.dat",
  "",
].join("\n");

const CLUB_6FT = {
  name: "Club 6ft",
  widthMm: "1830",
  depthMm: "760",
  heightMm: "750",
  owned: "2",
  color: "#c8a165",
};
const FOLDING_4FT = {
  name: "Folding 4ft",
  widthMm: "1220",
  depthMm: "610",
  heightMm: "750",
  owned: "4",
  color: "#3d6b9e",
};

const CLUB_CURSORS: ReadonlyArray<LatticePoint> = [
  { x: 2280, z: 940 },
  { x: 7080, z: 940 },
];
const TURNED_CLUB_CURSOR: LatticePoint = { x: 960, z: 4200 };
const FOLDING_CURSORS: ReadonlyArray<LatticePoint> = [
  { x: 3600, z: 2840 },
  { x: 6800, z: 2840 },
];
const HUT_ON_TABLE_ONE: LatticePoint = { x: 1600, z: 800 };

async function addTableType(page: Page, fields: Readonly<Record<string, string>>): Promise<void> {
  for (const [key, value] of Object.entries(fields)) {
    await page.locator(`input[name="new-table-type-${key}"]`).fill(value);
  }
  await page.locator('[data-action="add-table-type"]').click();
}

async function placeType(page: Page, typeId: number): Promise<void> {
  await page.locator(`[data-table-type="${typeId}"] [data-action="place-table-type"]`).click();
}

async function libraryOf(page: Page) {
  return page.locator("[data-table-type]").evaluateAll((rows) =>
    rows.map((row) => ({
      type: row.getAttribute("data-table-type"),
      placed: row.querySelector("[data-placed]")?.textContent ?? null,
    })),
  );
}

async function tablesOf(editor: EditorPage) {
  const [plan] = await editor.plans();
  return (plan?.footprint.tables ?? []).map(({ number, name, typeId, rect, heightMm }) => ({
    number,
    name,
    typeId,
    rect,
    heightMm,
  }));
}

test("a club's table types from the library are placed on the canvas a quarter turn at a time with their corner on the 8-stud grid, numbered and counted against those owned, carry a user's own model, and are still there after a reload", async ({
  page,
}) => {
  const hutFile = test.info().outputPath(HUT_FILE);
  await writeFile(hutFile, USER_HUT);
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const hut = await editor.importModel(hutFile);
  expect(hut.status, hut.text).toBe("placeable");
  await editor.escape();
  await editor.goTo({ x: 3600, z: 2400 });
  await editor.zoom(900);

  await page.locator(".plan-panel > summary").click();
  await addTableType(page, CLUB_6FT);
  await addTableType(page, FOLDING_4FT);
  await expect(page.locator("[data-table-type]")).toHaveCount(2);

  await placeType(page, 0);
  await expect(editor.root).toHaveAttribute("data-mode", "table");
  for (const cursor of CLUB_CURSORS) await editor.clickAt(cursor);
  await editor.press("r");
  await editor.clickAt(TURNED_CLUB_CURSOR);
  await editor.escape();
  await placeType(page, 1);
  for (const cursor of FOLDING_CURSORS) await editor.clickAt(cursor);
  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("library-tables-placed.png") });
  await editor.escape();
  await editor.press("b");
  await editor.placeAt(hut.item, HUT_ON_TABLE_ONE);
  await editor.escape();
  await editor.saved();
  await expect(page.locator(".plan-panel [data-unmeasured]")).toHaveCount(0);

  const placed = {
    tables: await tablesOf(editor),
    library: await libraryOf(page),
    rows: (await editor.planRows()).map((row) => row.rule),
  };
  const club = { typeId: 0, heightMm: 750 };
  const folding = { typeId: 1, heightMm: 750 };
  expect(placed).toEqual({
    tables: [
      { number: 1, name: "Table 1", ...club, rect: { x: 0, z: 0, width: 1830, depth: 760 } },
      { number: 2, name: "Table 2", ...club, rect: { x: 1920, z: 0, width: 1830, depth: 760 } },
      { number: 3, name: "Table 3", ...club, rect: { x: 0, z: 768, width: 760, depth: 1830 } },
      { number: 4, name: "Table 4", ...folding, rect: { x: 832, z: 832, width: 1220, depth: 610 } },
      {
        number: 5,
        name: "Table 5",
        ...folding,
        rect: { x: 2112, z: 832, width: 1220, depth: 610 },
      },
    ],
    library: [
      { type: "0", placed: "3 placed, 1 more than the 2 owned" },
      { type: "1", placed: "2 of 4 owned placed in this plan" },
    ],
    rows: [],
  });
  await page.locator('.plan-panel [data-action="view-plan"]').click();
  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("library-tables-from-above.png") });
  await editor.press("b");
  await expect(editor.root).toHaveAttribute("data-mode", "table");
  await page.screenshot({ path: test.info().outputPath("library-tables-numbered.png") });
  await editor.press("b");

  await editor.reload();
  await expect(page.locator(".welcome")).toHaveCount(0);
  await expect.poll(() => tablesOf(editor)).toEqual(placed.tables);
  await expect.poll(() => libraryOf(page)).toEqual(placed.library);
  await page.locator('section[aria-label="Table library"]').scrollIntoViewIfNeeded();
  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("library-tables-reloaded.png") });
});

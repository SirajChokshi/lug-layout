import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EditorPage, STUD, type LatticePoint } from "./editor-page.ts";

const OWNED_PARTS_CSV = fileURLToPath(
  new URL("../../../packages/test-fixtures/owned-parts.csv", import.meta.url),
);
const RELOAD_TIMEOUT_MS = 150_000;
const WANTED_ITEM =
  /<ITEMID>([^<]+)<\/ITEMID>\s*<COLOR>([^<]+)<\/COLOR>\s*<MINQTY>([^<]+)<\/MINQTY>/gu;

function customModel(): string {
  return [
    "0 Custom model built for the own vs buy test",
    "0 Name: own-vs-buy-model.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
    "1 4 -280 -24 -280 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 4 -160 -24 -280 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 4 -40 -24 -280 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 1 0 -24 0 1 0 0 0 1 0 0 0 1 3003.dat",
    "1 1 60 -24 0 1 0 0 0 1 0 0 0 1 3003.dat",
    "1 14 260 -24 290 1 0 0 0 1 0 0 0 1 3700.dat",
    "1 15 200 -8 -200 1 0 0 0 1 0 0 0 1 3024.dat",
    "1 15 220 -8 -200 1 0 0 0 1 0 0 0 1 3024.dat",
    "1 15 240 -8 -200 1 0 0 0 1 0 0 0 1 3024.dat",
    "1 15 260 -8 -200 1 0 0 0 1 0 0 0 1 3024.dat",
    "",
  ].join("\n");
}

interface TableSurface {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

function onLattice(ldu: number): number {
  return Math.round(ldu / STUD) * STUD;
}

async function tableCentre(page: Page): Promise<LatticePoint> {
  const state: {
    readonly checks: ReadonlyArray<{ readonly tables: ReadonlyArray<{ surface: TableSurface }> }>;
  } = JSON.parse((await page.locator("#plan-state").textContent()) ?? "");
  const surface = state.checks[0]?.tables[0]?.surface;
  if (!surface) throw new Error("the plan has no table");
  return {
    x: onLattice((surface.minX + surface.maxX) / 2),
    z: onLattice((surface.minZ + surface.maxZ) / 2),
  };
}

async function downloaded(page: Page, button: Locator): Promise<string> {
  const [file] = await Promise.all([page.waitForEvent("download"), button.click()]);
  return readFile(await file.path(), "utf8");
}

test("parts owned in a CSV split a plan's parts list, holding an imported custom model, into own and buy, the shortfall downloads in Rebrickable and BrickLink ids, and the owned parts survive a reload", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const file = test.info().outputPath("own-vs-buy-model.ldr");
  await writeFile(file, customModel());
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  await page.locator(".plan-panel > summary").click();
  await page.locator('[data-action="new-plan"]').click();
  await page.locator('[data-action="add-table"]').click();
  const centre = await tableCentre(page);
  await page.locator(".plan-panel > summary").click();
  await editor.goTo(centre);
  await editor.placeAt(imported.item, centre);
  await editor.escape();

  const ownVsBuy = page.locator(".own-vs-buy");
  await expect(ownVsBuy).toHaveAttribute("data-loaded", "1");
  await ownVsBuy.locator('input[type="file"]').setInputFiles(OWNED_PARTS_CSV);
  await expect(ownVsBuy).toHaveAttribute("data-owned", "17");
  await expect(ownVsBuy).toHaveAttribute("data-rejected", "2");
  await page.locator('input[name="bom-scope"][value="plan"]').check();
  await page.getByRole("button", { name: "Build parts list" }).click();

  await expect(ownVsBuy).toHaveAttribute("data-buy", "3");
  await expect(ownVsBuy).toHaveAttribute("data-own", "8");
  await expect(ownVsBuy).toHaveAttribute("data-unknown", "2");
  const toBuy = page.getByRole("group", { name: "To buy" });
  const rebrickable = await downloaded(
    page,
    toBuy.getByRole("button", { name: "Rebrickable CSV" }),
  );
  expect(rebrickable).toBe("Part,Color,Quantity\r\n3003,1,1\r\n3700,14,1\r\n3811,2,1\r\n");
  const bricklink = await downloaded(page, toBuy.getByRole("button", { name: "BrickLink XML" }));
  expect([...bricklink.matchAll(WANTED_ITEM)].map((item) => item.slice(1))).toEqual([
    ["3003", "7", "1"],
    ["3700", "3", "1"],
    ["3811", "6", "1"],
  ]);
  const plain = await downloaded(page, toBuy.getByRole("button", { name: "Plain CSV" }));
  expect(plain.trimEnd().split("\r\n").slice(1, -1)).toEqual([
    "ldraw:3003,1,1,3003,1,3003,7,,",
    "ldraw:3700,14,1,3700,14,3700,3,,",
    "ldraw:3811,2,1,3811,2,3811,6,,",
  ]);

  await page.reload();
  await expect(editor.root).toHaveAttribute("data-status", "ready", {
    timeout: RELOAD_TIMEOUT_MS,
  });
  await expect(page.locator(".own-vs-buy")).toHaveAttribute("data-owned", "17");
});

import { expect, test, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { readZip } from "@brr/storage/zip";
import { EditorPage, startEmpty } from "./editor-page.ts";

const PLAN_FILE = "hall-plan.png";
const PLAN_WIDTH_PX = 800;
const PLAN_HEIGHT_PX = 500;
const SCALE_BAR_FROM = [100, 460] as const;
const SCALE_BAR_TO = [500, 460] as const;
const SCALE_BAR_M = 10;
const RELOAD_TIMEOUT_MS = 120_000;

async function drawnFloorPlan(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(
    async ({ width, height, from, to }) => {
      const canvas = new OffscreenCanvas(width, height);
      const ink = canvas.getContext("2d");
      if (!ink) throw new Error("no 2D canvas");
      ink.fillStyle = "#ffffff";
      ink.fillRect(0, 0, width, height);
      ink.strokeStyle = "#1b2a34";
      ink.lineWidth = 8;
      ink.strokeRect(40, 40, width - 80, height - 120);
      ink.fillStyle = "#c0392b";
      ink.fillRect(380, 200, 40, 40);
      ink.lineWidth = 4;
      ink.beginPath();
      ink.moveTo(from[0], from[1]);
      ink.lineTo(to[0], to[1]);
      ink.stroke();
      const blob = await canvas.convertToBlob({ type: "image/png" });
      return [...new Uint8Array(await blob.arrayBuffer())];
    },
    { width: PLAN_WIDTH_PX, height: PLAN_HEIGHT_PX, from: SCALE_BAR_FROM, to: SCALE_BAR_TO },
  );
  return Buffer.from(bytes);
}

function underlaySection(page: Page) {
  return page.locator('section[aria-label="Floor plan underlay"]');
}

async function openPlanPanel(page: Page): Promise<void> {
  const panel = page.locator(".plan-panel");
  if ((await panel.getAttribute("open")) === null) await panel.locator("> summary").click();
}

async function exportedWorld(page: Page): Promise<string> {
  const menu = page.locator(".world-menu");
  if ((await menu.getAttribute("open")) === null) await menu.locator("> summary").click();
  const download = page.waitForEvent("download");
  await menu.getByRole("button", { name: "Export .brr.zip" }).click();
  const file = await download;
  const path = test.info().outputPath(file.suggestedFilename());
  await file.saveAs(path);
  return path;
}

test("a floor plan scaled by its 10 m scale bar stays with the world through a reload, an export and an import, and its lock holds it", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  const png = await drawnFloorPlan(page);
  const sha256 = createHash("sha256").update(png).digest("hex");
  const planFile = test.info().outputPath(PLAN_FILE);
  await writeFile(planFile, png);
  await openPlanPanel(page);
  const section = underlaySection(page);
  await expect(section).toHaveAttribute("data-underlay", "");

  await section
    .locator('input[aria-label="Choose a PNG or JPEG floor plan"]')
    .setInputFiles(planFile);
  const dialog = page.locator(".underlay-calibrator");
  const picture = dialog.locator(".underlay-picture img");
  await expect
    .poll(() => picture.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBe(PLAN_WIDTH_PX);
  const shown = await picture.boundingBox();
  if (!shown) throw new Error("the floor plan isn't shown");
  for (const [x, y] of [SCALE_BAR_FROM, SCALE_BAR_TO]) {
    await picture.click({
      position: { x: (x * shown.width) / PLAN_WIDTH_PX, y: (y * shown.height) / PLAN_HEIGHT_PX },
    });
  }
  await expect(dialog.locator(".underlay-picture")).toHaveAttribute(
    "data-points",
    `${SCALE_BAR_FROM.join(",")} ${SCALE_BAR_TO.join(",")}`,
  );
  await dialog.locator('input[name="underlay-distance"]').fill(String(SCALE_BAR_M));
  await dialog.locator('[data-action="apply-underlay-scale"]').click();
  await expect(dialog).toHaveCount(0);
  await expect(section).toHaveAttribute("data-underlay", sha256);
  await expect(section.locator("[data-underlay-mm-per-pixel]")).toHaveAttribute(
    "data-underlay-mm-per-pixel",
    "25",
  );
  await section.locator('input[name="underlay-opacity"]').fill("70");
  await section.locator('input[name="underlay-locked"]').check();
  for (const action of ["choose-underlay", "rescale-underlay", "remove-underlay"]) {
    await expect(section.locator(`[data-action="${action}"]`)).toBeDisabled();
  }

  const exported = await exportedWorld(page);
  const zip = await readZip(new Uint8Array(await readFile(exported)));
  if (!zip.ok) throw new Error("the exported world isn't a ZIP");
  const manifest = JSON.parse(new TextDecoder().decode(zip.value.get("manifest.json")));
  expect({
    underlay: manifest.underlay,
    image: zip.value.get(`imports/${sha256}/${PLAN_FILE}`),
  }).toEqual({
    underlay: {
      image: sha256,
      from: [...SCALE_BAR_FROM],
      to: [...SCALE_BAR_TO],
      distanceMm: SCALE_BAR_M * 1000,
      x: 0,
      z: 0,
      opacity: 70,
      locked: true,
    },
    image: new Uint8Array(png),
  });

  await page.reload();
  await expect(editor.root).toHaveAttribute("data-status", "ready", {
    timeout: RELOAD_TIMEOUT_MS,
  });
  await startEmpty(page);
  await openPlanPanel(page);
  await expect(section).toHaveAttribute("data-underlay", sha256);
  await expect(section.locator('input[name="underlay-opacity"]')).toHaveValue("70");
  await expect(section.locator('input[name="underlay-locked"]')).toBeChecked();

  await section.locator('input[name="underlay-locked"]').uncheck();
  await section.locator('[data-action="remove-underlay"]').click();
  await expect(section).toHaveAttribute("data-underlay", "");
  await page.locator('input[aria-label="Import a .brr.zip world"]').setInputFiles(exported);
  await expect(section).toHaveAttribute("data-underlay", sha256);
  await expect(section.locator('input[name="underlay-locked"]')).toBeChecked();
});

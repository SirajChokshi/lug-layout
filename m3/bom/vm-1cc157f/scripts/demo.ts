import { writeFileSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
const out = process.argv[2] ?? "/tmp/evidence/demo-final";
const browser = await chromium.launch({ executablePath: "/usr/local/bin/google-chrome", headless: false, slowMo: 350, args: ["--window-position=0,0", "--window-size=1920,1160"] });
const context = await browser.newContext({ viewport: { width: 1900, height: 1040 }, acceptDownloads: true });
const page = await context.newPage();
async function downloads(p: Page, labels: string[]): Promise<void> {
  for (const label of labels) {
    const [d] = await Promise.all([p.waitForEvent("download"), p.getByRole("button", { name: label }).click()]);
    await d.saveAs(`${out}/${d.suggestedFilename()}`);
  }
}
await page.goto("http://localhost:4173/?model=10218-1&api=webgl2");
await page.waitForSelector(".bom", { timeout: 600000 });
await page.waitForTimeout(1500);
await page.getByRole("button", { name: "Build parts list" }).click();
await page.waitForSelector(".bom-downloads", { timeout: 60000 });
await page.waitForTimeout(1500);
for (const summary of await page.locator(".bom details summary").all()) {
  await summary.click();
  await page.waitForTimeout(1200);
}
await page.locator(".bom details").last().scrollIntoViewIfNeeded();
await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}/model-10218-1-not-counted.png` });
await downloads(page, ["Plain CSV"]);
await page.waitForTimeout(1500);
await page.goto("http://localhost:4173/?state=1&api=webgl2");
await page.waitForSelector(".bom", { timeout: 600000 });
const canvasBox = await page.locator("canvas").first().boundingBox();
if (!canvasBox) throw new Error("no canvas");
const spots = [[0.35, 0.55], [0.6, 0.55]] as const;
for (const [index, set] of ["10264-1", "7936-1"].entries()) {
  const [fx, fy] = spots[index] ?? [0.5, 0.5];
  await page.locator(`[data-item="omr:${set}"]`).click();
  await page.mouse.move(canvasBox.x + canvasBox.width * fx, canvasBox.y + canvasBox.height * fy, { steps: 12 });
  await page.waitForTimeout(800);
  await page.mouse.click(canvasBox.x + canvasBox.width * fx, canvasBox.y + canvasBox.height * fy);
  await page.waitForSelector(`#edit-state[data-placements="${index + 1}"]`, { timeout: 600000, state: "attached" });
}
await page.keyboard.press("Escape");
await page.mouse.click(canvasBox.x + canvasBox.width * 0.35, canvasBox.y + canvasBox.height * 0.55);
await page.waitForSelector(".editor:not([data-selection=''])", { timeout: 600000, state: "attached" });
await page.waitForTimeout(1200);
await page.getByRole("button", { name: "Build parts list" }).click();
await page.waitForSelector(".bom-downloads", { timeout: 60000 });
await page.waitForTimeout(2000);
await downloads(page, ["Rebrickable CSV", "BrickLink XML", "Plain CSV"]);
await page.locator('input[name="bom-scope"][value="selection"]').check();
await page.getByRole("button", { name: "Build parts list" }).click();
await page.waitForTimeout(2500);
await page.locator(".bom details summary").click();
await page.waitForTimeout(2500);
await downloads(page, ["Rebrickable CSV", "BrickLink XML", "Plain CSV"]);
await page.screenshot({ path: `${out}/editor-selection.png` });
await page.waitForTimeout(1500);
await page.goto("http://localhost:4173/?scene=city&parts=2000&dumpWorld=1&measure=1&warmup=1&frames=5&api=webgl2");
await page.waitForSelector("#result[data-done]", { timeout: 300000, state: "attached" });
writeFileSync(`${out}/city-result.json`, (await page.locator("#result").textContent()) ?? "");
await page.getByRole("button", { name: "Build parts list" }).click();
await page.waitForSelector(".bom-downloads", { timeout: 60000 });
await page.waitForTimeout(2000);
await downloads(page, ["Rebrickable CSV", "Plain CSV"]);
await page.locator('input[name="bom-scope"][value="region"]').check();
for (const [field, value] of Object.entries({ minX: 0, minZ: 0, maxX: 640, maxZ: 640 })) {
  await page.locator(`.bom-region input[name="${field}"]`).fill(String(value));
}
await page.getByRole("button", { name: "Build parts list" }).click();
await page.waitForTimeout(3000);
await downloads(page, ["Rebrickable CSV", "Plain CSV"]);
await page.screenshot({ path: `${out}/city-region.png` });
await page.waitForTimeout(2500);
await browser.close();

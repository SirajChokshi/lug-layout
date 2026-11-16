import { writeFileSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
const out = "/tmp/evidence/demo";
const browser = await chromium.launch({ executablePath: "/usr/local/bin/google-chrome", headless: false, slowMo: 350, args: ["--window-position=0,0", "--window-size=1920,1160"] });
const context = await browser.newContext({ viewport: { width: 1900, height: 1040 }, acceptDownloads: true });
const page = await context.newPage();
async function downloads(p: Page, labels: string[]): Promise<void> {
  for (const label of labels) {
    const [d] = await Promise.all([p.waitForEvent("download"), p.getByRole("button", { name: label }).click()]);
    await d.saveAs(`${out}/${d.suggestedFilename()}`);
  }
}
await page.goto("http://localhost:4173/?model=10264-1&api=webgl2");
await page.waitForSelector(".bom", { timeout: 300000 });
await page.waitForTimeout(1500);
await page.getByRole("button", { name: "Build parts list" }).click();
await page.waitForSelector(".bom-downloads", { timeout: 60000 });
await page.waitForTimeout(2000);
await page.locator(".bom details summary").click();
await page.waitForTimeout(3000);
await downloads(page, ["Rebrickable CSV", "BrickLink XML", "Plain CSV"]);
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

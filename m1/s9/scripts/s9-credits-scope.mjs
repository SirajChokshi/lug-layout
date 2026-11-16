import fs from "node:fs";
import { chromium } from "playwright-core";
const [baseUrl, out] = process.argv.slice(2);
const profile = fs.mkdtempSync("/tmp/s9-scope-");
const context = await chromium.launchPersistentContext(profile, { executablePath: "/usr/local/bin/google-chrome", headless: false, viewport: { width: 1600, height: 900 }, acceptDownloads: true });
const page = context.pages()[0];
await page.goto(`${baseUrl}/?api=webgl2`);
await page.waitForSelector('.editor[data-status="ready"]', { state: "attached", timeout: 600000 });
await page.fill('input[aria-label="New world name"]', "Two sets");
await page.click('form.world-new button[type="submit"]');
await page.waitForFunction(() => document.querySelector(".world-name strong")?.textContent === "Two sets");
for (const [item, x] of [["omr:7936-1", -600], ["omr:10133-1", 600]]) {
  await page.fill('input[aria-label="Go to x (LDU)"]', String(x));
  await page.fill('input[aria-label="Go to z (LDU)"]', "0");
  await page.click("text=Go to x, z");
  await page.click(`[data-item="${item}"]`);
  await page.mouse.move(800, 450);
  await page.waitForFunction((t) => document.querySelector(".editor")?.getAttribute("data-hover") === t, `${x},0`, { timeout: 60000 });
  await page.mouse.click(800, 450);
  await page.keyboard.press("Escape");
}
await page.waitForFunction(() => (document.querySelector(".world-name")?.textContent ?? "").includes("Saved · 2 placements"), null, { timeout: 120000 });
const [download] = await Promise.all([page.waitForEvent("download"), page.click("text=Export .brr.zip")]);
await download.saveAs(out);
console.log("saved", out, download.suggestedFilename());
await context.close();

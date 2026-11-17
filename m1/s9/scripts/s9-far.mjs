import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const [baseUrl, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const context = await chromium.launchPersistentContext(fs.mkdtempSync("/tmp/s9-far-"), {
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  viewport: { width: 1600, height: 900 },
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = context.pages()[0];
const ready = async () => {
  await page.waitForSelector('.editor[data-status="ready"]', { state: "attached", timeout: 600000 });
  await page.waitForFunction(() => document.querySelector(".editor-hud")?.textContent?.includes("First world frame"), null, { timeout: 600000 });
};
const shot = async (name) => {
  await page.mouse.move(2, 898);
  await page.addStyleTag({ content: ".hud, .side-panel, footer, .editor-hud, .palette { visibility: hidden !important; }" });
  await page.waitForTimeout(4000);
  const clip = await page.locator("canvas.scene").boundingBox();
  const bytes = await page.screenshot({ clip, timeout: 180000 });
  fs.writeFileSync(path.join(outDir, name), bytes);
  return PNG.sync.read(bytes);
};
const hud = async () => (await page.locator(".editor-hud").innerText()).split("\n").find((l) => l.includes("origin")) ?? "";
await page.goto(`${baseUrl}/?state=1&api=webgl2&lod=low`);
await ready();
const X = 25_000_000;
const Z = -25_000_000;
await page.fill('input[aria-label="Go to x (LDU)"]', String(X));
await page.fill('input[aria-label="Go to z (LDU)"]', String(Z));
await page.click("text=Go to x, z");
await page.click('[data-item="ldraw:3811@2"]');
await page.mouse.move(800, 450);
await page.waitForFunction((t) => document.querySelector(".editor")?.getAttribute("data-hover") === t, `${X},${Z}`, { timeout: 60000 });
await page.mouse.click(800, 450);
await page.keyboard.press("Escape");
await page.waitForFunction(() => (document.querySelector(".world-name")?.textContent ?? "").includes("1 placement"), null, { timeout: 120000 });
await page.waitForTimeout(2000);
const originBefore = await hud();
const a = await shot("far-before.png");
await page.reload();
await ready();
const originAfter = await hud();
const b = await shot("far-after.png");
let diff = 0;
for (let i = 0; i < a.data.length; i += 4) {
  if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2] || a.data[i + 3] !== b.data[i + 3]) diff++;
}
const line = `far reload at (${X}, ${Z}): ${diff} of ${a.width * a.height} pixels differ; ${originBefore} -> ${originAfter}`;
console.log(line);
fs.writeFileSync(path.join(outDir, "far.log"), `${line}\n`);
await context.close();

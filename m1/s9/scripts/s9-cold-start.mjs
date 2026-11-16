import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const [baseUrl, profile, outDir, runsArg = "5", api = "webgl2"] = process.argv.slice(2);
if (!baseUrl || !profile || !outDir) {
  console.error("usage: node s9-cold-start.mjs <app url> <profile with a saved world> <out dir> [runs] [webgl2|webgpu]");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const runs = Number(runsArg);
const appUrl = `${baseUrl}/?api=${api}`;

const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME ?? "/usr/local/bin/google-chrome",
  headless: false,
  viewport: { width: 1600, height: 900 },
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
});
const page = context.pages()[0] ?? (await context.newPage());

async function installSaveCounter() {
  await page.evaluate(() => {
    if (window.__saveCycles !== undefined) return;
    window.__saveCycles = 0;
    const editor = document.querySelector(".editor");
    let last = editor?.getAttribute("data-save");
    new MutationObserver(() => {
      const now = editor?.getAttribute("data-save");
      if (last === "saving" && now === "saved") window.__saveCycles++;
      last = now;
    }).observe(editor, { attributes: true, attributeFilter: ["data-save"] });
  });
}

async function saveCycles() {
  return page.evaluate(() => window.__saveCycles);
}

async function viewSaved(baseline) {
  await page.waitForFunction((n) => window.__saveCycles > n, baseline, { timeout: 600000 });
  for (;;) {
    const cycles = await saveCycles();
    await page.waitForTimeout(5000);
    const state = await page.getAttribute(".editor", "data-save");
    if (state === "saved" && (await saveCycles()) === cycles) return;
  }
}

async function ready() {
  await page.waitForSelector('.editor[data-status="ready"]', { state: "attached", timeout: 600000 });
  await page.waitForFunction(
    () => document.querySelector(".editor-hud")?.textContent?.includes("First world frame"),
    null,
    { timeout: 600000 },
  );
}

function row(text, label) {
  const lines = text.split("\n");
  const at = lines.indexOf(label);
  return at < 0 ? null : lines[at + 1];
}

await page.goto(appUrl);
await ready();
await installSaveCounter();
const baseline = await saveCycles();
await page.fill('input[aria-label="Go to x (LDU)"]', "0");
await page.fill('input[aria-label="Go to z (LDU)"]', "0");
await page.click("text=Go to x, z");
const box = await page.locator("canvas.scene").boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
for (const delta of [400, 400, 300]) await page.mouse.wheel(0, delta);
await page.mouse.move(2, 898);
await viewSaved(baseline);
const samples = [];
for (let i = 0; i < runs; i++) {
  await page.reload();
  await ready();
  const hud = await page.locator(".editor-hud").innerText();
  const world = await page.locator(".world-name").innerText();
  const sample = {
    run: i + 1,
    world,
    load: row(hud, "Load"),
    worldOpen: row(hud, "World open"),
    firstWorldFrame: row(hud, "First world frame"),
    adapter: row(hud, "Adapter"),
    api: row(hud, "API"),
  };
  samples.push(sample);
  console.log(JSON.stringify(sample));
}
const number = (text) => Number(String(text).replace(/[^0-9.]/g, ""));
const median = (values) => values.toSorted((a, b) => a - b)[Math.floor(values.length / 2)];
const summary = {
  url: appUrl,
  userAgent: await page.evaluate(() => navigator.userAgent),
  runs,
  medianWorldOpenMs: median(samples.map((s) => number(s.worldOpen))),
  medianFirstWorldFrameMs: median(samples.map((s) => number(s.firstWorldFrame))),
  medianLoadMs: median(samples.map((s) => number(s.load))),
  samples,
};
fs.writeFileSync(path.join(outDir, `cold-start-${api}.json`), JSON.stringify(summary, null, 2));
console.log(JSON.stringify({ ...summary, samples: undefined }));
await context.close();

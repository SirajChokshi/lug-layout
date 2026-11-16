import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const [baseUrl, archive, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync("/tmp/s9-recheck-");
const context = await chromium.launchPersistentContext(profile, {
  executablePath: "/usr/local/bin/google-chrome",
  headless: false,
  viewport: { width: 1600, height: 900 },
  acceptDownloads: true,
});
const page = context.pages()[0];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const log = [];
const note = (line) => {
  log.push(line);
  console.log(line);
};

async function ready() {
  await page.waitForSelector('.editor[data-status="ready"]', { state: "attached", timeout: 600000 });
  await page.waitForFunction(
    () => document.querySelector(".editor-hud")?.textContent?.includes("First world frame"),
    null,
    { timeout: 600000 },
  );
}

async function canvasShot(name) {
  await page.mouse.move(2, 898);
  await page.addStyleTag({ content: ".hud, .side-panel, footer { visibility: hidden !important; }" });
  await page.waitForTimeout(4000);
  const clip = await page.locator("canvas.scene").boundingBox();
  const bytes = await page.screenshot({ clip, timeout: 180000 });
  await page.evaluate(() =>
    document.querySelectorAll("style").forEach((style) => {
      if (style.textContent?.includes(".side-panel, footer")) style.remove();
    }),
  );
  fs.writeFileSync(path.join(outDir, name), bytes);
  return bytes;
}

function differing(a, b) {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  let count = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    for (let c = 0; c < 4; c++) {
      if (pa.data[i + c] !== pb.data[i + c]) {
        count++;
        break;
      }
    }
  }
  return count;
}

async function state() {
  return JSON.parse(await page.locator("#edit-state").textContent()).world;
}

await page.goto(`${baseUrl}/?state=1&api=webgl2`);
await ready();
await page.setInputFiles("input.world-import", archive);
await page.waitForFunction(
  () => (document.querySelector(".world-name")?.textContent ?? "").includes("Two clusters"),
  null,
  { timeout: 600000 },
);
note(`imported: ${await page.locator(".world-name").innerText()}`);
const before = await state();
const beforeShot = await canvasShot("recheck-before-reload.png");
await page.reload();
await ready();
const after = await state();
const afterShot = await canvasShot("recheck-after-reload.png");
note(`reload: ${differing(beforeShot, afterShot)} of 1440000 pixels differ; chunk counts equal ${JSON.stringify(before.chunkCounts) === JSON.stringify(after.chunkCounts)}; placements ${before.placements.x.length} -> ${after.placements.x.length}`);
const [download] = await Promise.all([page.waitForEvent("download", { timeout: 300000 }), page.click("text=Export .brr.zip")]);
const exported = path.join(outDir, "recheck-export.brr.zip");
await download.saveAs(exported);
const a = fs.readFileSync(archive);
const b = fs.readFileSync(exported);
note(`archive in ${a.length} B sha256 ${sha256(a)}; export ${b.length} B sha256 ${sha256(b)}; identical ${Buffer.compare(a, b) === 0}`);
note(`hud: ${(await page.locator(".editor-hud").innerText()).replace(/\n/g, " | ")}`);
fs.writeFileSync(path.join(outDir, "recheck.log"), `${log.join("\n")}\n`);
await context.close();

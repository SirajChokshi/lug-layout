import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const [baseUrl, outDir] = process.argv.slice(2);
fs.mkdirSync(outDir, { recursive: true });
const context = await chromium.launchPersistentContext(fs.mkdtempSync("/tmp/s9-track-"), {
  executablePath: "/usr/local/bin/google-chrome",
  headless: true,
  viewport: { width: 1600, height: 900 },
  acceptDownloads: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = context.pages()[0];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const log = [];
const note = (line) => {
  log.push(line);
  console.log(line);
};
const worldLine = () => page.locator(".world-name").innerText();
const waitLine = (text) =>
  page.waitForFunction((t) => (document.querySelector(".world-name")?.textContent ?? "").includes(t), text, {
    timeout: 300000,
  });

async function ready() {
  await page.waitForSelector('.editor[data-status="ready"]', { state: "attached", timeout: 600000 });
  await page.waitForFunction(() => document.querySelector(".editor-hud")?.textContent?.includes("First world frame"), null, {
    timeout: 600000,
  });
}

async function canvasShot(name) {
  await page.mouse.move(2, 898);
  await page.addStyleTag({ content: ".hud, .side-panel, footer, .editor-hud, .palette { visibility: hidden !important; }" });
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

async function exportTo(name) {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 300000 }),
    page.click("text=Export .brr.zip"),
  ]);
  const file = path.join(outDir, name);
  await download.saveAs(file);
  return fs.readFileSync(file);
}

await page.goto(`${baseUrl}/?state=1&api=webgl2&lod=low`);
await ready();
await page.click('[data-item="ldraw:3811@2"]');
await page.mouse.move(800, 450);
await page.waitForTimeout(500);
await page.mouse.click(800, 450);
await page.keyboard.press("Escape");
await waitLine("1 placement");
await page.click('[data-item="track:lego-9v"]');
await page.mouse.move(640, 520);
await page.mouse.down();
for (let step = 1; step <= 20; step++) await page.mouse.move(640 + step * 20, 520 - step * 6);
await page.waitForTimeout(1500);
await page.mouse.up();
await page.keyboard.press("Escape");
await waitLine("track piece");
note(`after drawing: ${await worldLine()}`);
if (process.env.MOVE === "1") {
  await page.mouse.move(800, 450);
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -120);
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(2500);
  const view = await page.evaluate(() => JSON.parse(document.querySelector("#edit-state")?.textContent ?? "{}").world?.view ?? null);
  note(`after zooming: ${await worldLine()}; state view ${JSON.stringify(view)}`);
}
const exportA = await exportTo("A.brr.zip");
note(`exported view: ${JSON.stringify(JSON.parse(exportA.toString("latin1").match(/\{"bundleVersion".*?"yaw":[^}]*\}\}/)?.[0] ?? "{}").view ?? null)}`);
const before = await canvasShot("before-reload.png");
await page.reload();
await ready();
await waitLine("track piece");
note(`after reload: ${await worldLine()}`);
const after = await canvasShot("after-reload.png");
note(`reload: ${differing(before, after)} of 1440000 pixels differ`);
const exportB = await exportTo("B.brr.zip");
note(`export before reload ${exportA.length} B sha256 ${sha256(exportA)}; after reload ${sha256(exportB)}; identical ${Buffer.compare(exportA, exportB) === 0}`);
const databases = await page.evaluate(async () => {
  const names = (await indexedDB.databases()).map((db) => db.name ?? "");
  await Promise.all(
    names.map(
      (name) =>
        new Promise((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = request.onerror = request.onblocked = () => resolve(null);
        }),
    ),
  );
  return { names, after: (await indexedDB.databases()).map((db) => db.name) };
});
note(`wiped ${JSON.stringify(databases.names)} -> ${JSON.stringify(databases.after)}`);
await page.reload();
await ready();
note(`after wipe: ${await worldLine()}`);
await page.setInputFiles("input.world-import", path.join(outDir, "A.brr.zip"));
await waitLine("track piece");
note(`after import: ${await worldLine()}`);
const imported = await canvasShot("after-import.png");
note(`import vs before reload: ${differing(before, imported)} of 1440000 pixels differ`);
const exportC = await exportTo("C.brr.zip");
note(`re-export sha256 ${sha256(exportC)}; identical to A ${Buffer.compare(exportA, exportC) === 0}`);
fs.writeFileSync(path.join(outDir, "track.log"), `${log.join("\n")}\n`);
await context.close();

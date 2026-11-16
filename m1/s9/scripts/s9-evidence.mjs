import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import { PNG } from "pngjs";

const [baseUrl, outDir, api = "webgl2"] = process.argv.slice(2);
if (!baseUrl || !outDir) {
  console.error("usage: node s9-evidence.mjs <app url> <out dir> [webgl2|webgpu]");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });
const resumeProfile = process.env.RESUME_PROFILE;
const profile = resumeProfile ?? fs.mkdtempSync("/tmp/s9-profile-");
const appUrl = `${baseUrl}/?state=1&api=${api}`;
const VIEWPORT = { width: 1600, height: 900 };
const TEN_KM_LDU = 25_000_000;
const SPACING = 1280;
const SETS = [
  "7936-1",
  "10264-1",
  "10185-1",
  "10190-1",
  "10218-1",
  "2150-1",
  "4554-1",
  "4555-1",
  "10128-1",
  "10133-1",
];
const FAR_SETS = ["10133-1", "7936-1"];
const log = [];
const note = (line) => {
  log.push(line);
  console.log(line);
};
const write = (name, data) => fs.writeFileSync(path.join(outDir, name), data);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const context = await chromium.launchPersistentContext(profile, {
  executablePath: process.env.CHROME ?? "/usr/local/bin/google-chrome",
  headless: false,
  viewport: VIEWPORT,
  acceptDownloads: true,
  recordVideo: { dir: path.join(outDir, "video"), size: VIEWPORT },
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
});
const page = context.pages()[0] ?? (await context.newPage());
page.on("pageerror", (e) => note(`pageerror: ${e.message}`));
note(`profile ${profile}`);
note(`chrome ${context.browser()?.version() ?? (await page.evaluate(() => navigator.userAgent))}`);

async function ready() {
  await page.waitForSelector('.editor[data-status="ready"]', { state: "attached", timeout: 600000 });
  await page.waitForFunction(
    () => document.querySelector(".editor-hud")?.textContent?.includes("First world frame"),
    null,
    { timeout: 600000 },
  );
}

async function hud() {
  return page.locator(".editor-hud").innerText();
}

async function worldLine() {
  return page.locator(".world-name").innerText();
}

async function settled(placements) {
  await page.waitForFunction(
    (n) => {
      const line = document.querySelector(".world-name")?.textContent ?? "";
      return line.includes(`Saved · ${n} placement`);
    },
    placements,
    { timeout: 120000 },
  );
  await page.waitForTimeout(1200);
  await page.waitForSelector('.editor[data-save="saved"]', { state: "attached" });
}

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

async function goTo(x, z) {
  await page.fill('input[aria-label="Go to x (LDU)"]', String(x));
  await page.fill('input[aria-label="Go to z (LDU)"]', String(z));
  await page.click("text=Go to x, z");
}

async function canvasCentre() {
  const box = await page.locator("canvas.scene").boundingBox();
  return [box.x + box.width / 2, box.y + box.height / 2];
}

async function place(item, x, z, rot) {
  await goTo(x, z);
  await page.click(`[data-item="${item}"]`);
  while (Number(await page.getAttribute(".editor", "data-ghost-rot")) !== rot) {
    await page.keyboard.press("r");
  }
  const [cx, cy] = await canvasCentre();
  await page.mouse.move(cx, cy);
  await page.waitForFunction(
    (target) => document.querySelector(".editor")?.getAttribute("data-hover") === target,
    `${x},${z}`,
    { timeout: 30000 },
  );
  await page.mouse.click(cx, cy);
  await page.keyboard.press("Escape");
}

async function editState() {
  return JSON.parse(await page.locator("#edit-state").textContent());
}

function sortedPlacements(state) {
  const p = state.world.placements;
  return p.x
    .map((x, i) => [state.world.refs[p.refId[i]], x, p.z[i], p.yPlates[i], p.rot[i]])
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function canvasShot(name) {
  await page.mouse.move(2, VIEWPORT.height - 2);
  await page.addStyleTag({
    content: ".hud, .side-panel, footer { visibility: hidden !important; }",
  });
  await page.waitForTimeout(4000);
  const clip = await page.locator("canvas.scene").boundingBox();
  const bytes = await page.screenshot({ clip, timeout: 180000 });
  await page.evaluate(() => document.querySelectorAll("style").forEach((s) => {
    if (s.textContent?.includes(".side-panel, footer")) s.remove();
  }));
  write(name, bytes);
  return bytes;
}

function pixelDiff(a, b) {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return { size: "differs" };
  let differing = 0;
  let maxDelta = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    let pixel = 0;
    for (let c = 0; c < 4; c++) pixel = Math.max(pixel, Math.abs(pa.data[i + c] - pb.data[i + c]));
    if (pixel > 0) differing++;
    maxDelta = Math.max(maxDelta, pixel);
  }
  return { width: pa.width, height: pa.height, differing, maxDelta };
}

async function idbDump() {
  return page.evaluate(async () => {
    const open = (name) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const all = (db, store, method) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(store).objectStore(store)[method]();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const utf8 = new TextEncoder();
    const databases = (await indexedDB.databases()).map((d) => d.name).sort();
    const index = await open("brr-worlds");
    const worlds = await all(index, "worlds", "getAll");
    index.close();
    const result = { databases, worlds: [] };
    for (const world of worlds) {
      const db = await open(`brr-world-${world.id}`);
      const keys = await all(db, "shards", "getAllKeys");
      const values = await all(db, "shards", "getAll");
      const manifest = (await all(db, "manifest", "getAll"))[0];
      db.close();
      result.worlds.push({
        database: `brr-world-${world.id}`,
        name: world.name,
        manifestBytes: utf8.encode(manifest).length,
        shards: keys.map((key, i) => ({
          key,
          placements: JSON.parse(values[i]).placements.length,
          bytes: utf8.encode(values[i]).length,
        })),
      });
    }
    return result;
  });
}

async function exportWorld(name) {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.click("text=Export .brr.zip"),
  ]);
  const file = path.join(outDir, name);
  await download.saveAs(file);
  note(`exported ${name} (suggested ${download.suggestedFilename()})`);
  return fs.readFileSync(file);
}

async function internalsShot(name) {
  const internals = await context.newPage();
  await internals.goto("chrome://indexeddb-internals/");
  await internals.waitForTimeout(1500);
  await internals.screenshot({ path: path.join(outDir, name), fullPage: true });
  write(`${name}.txt`, await internals.locator("body").innerText());
  await internals.close();
}

const startedAt = Date.now();
await page.goto(appUrl);
await ready();
note(`${resumeProfile ? "resumed" : "fresh"} profile opened: ${await worldLine()}`);
let placed = 0;
if (resumeProfile) {
  placed = SETS.length * 2 + FAR_SETS.length * 2;
} else {
await page.fill('input[aria-label="New world name"]', "Two clusters");
await page.click('form.world-new button[type="submit"]');
await page.waitForFunction(() => document.querySelector(".world-name strong")?.textContent === "Two clusters");

for (let i = 0; i < SETS.length; i++) {
  const x = (i % 5 - 2) * SPACING;
  const z = (Math.floor(i / 5) * 2 - 1) * (SPACING / 2);
  const rot = i % 4;
  await place("ldraw:3811", x, z, 0);
  await place(`omr:${SETS[i]}`, x, z, rot);
  placed += 2;
  note(`placed 3811 and ${SETS[i]} at (${x}, ${z}) rot ${rot}`);
}
for (let i = 0; i < FAR_SETS.length; i++) {
  const x = TEN_KM_LDU + i * SPACING;
  const z = -TEN_KM_LDU;
  await place("ldraw:3811", x, z, 0);
  await place(`omr:${FAR_SETS[i]}`, x, z, i);
  placed += 2;
  note(`placed 3811 and ${FAR_SETS[i]} at (${x}, ${z}) rot ${i}`);
}
}
await settled(placed);
note(`built ${placed} placements in ${((Date.now() - startedAt) / 1000).toFixed(0)} s: ${await worldLine()}`);

const reloadChecks = [];
for (const [label, x, z, wheel] of [
  ["origin", 0, 0, [400, 400, 300]],
  ["far", TEN_KM_LDU + SPACING / 2, -TEN_KM_LDU, [-600]],
]) {
  await installSaveCounter();
  const baseline = await saveCycles();
  await goTo(x, z);
  const [cx, cy] = await canvasCentre();
  await page.mouse.move(cx, cy);
  for (const delta of wheel) await page.mouse.wheel(0, delta);
  await viewSaved(baseline);
  const before = await editState();
  const beforeShot = await canvasShot(`reload-${label}-before.png`);
  write(`reload-${label}-before.hud.txt`, await hud());
  await page.reload();
  await ready();
  await page.waitForTimeout(1500);
  const after = await editState();
  const afterShot = await canvasShot(`reload-${label}-after.png`);
  write(`reload-${label}-after.hud.txt`, await hud());
  const check = {
    label,
    pixels: pixelDiff(beforeShot, afterShot),
    placementsBefore: before.world.placements.x.length,
    placementsAfter: after.world.placements.x.length,
    chunkCountsEqual: JSON.stringify(before.world.chunkCounts) === JSON.stringify(after.world.chunkCounts),
    placementsEqual: JSON.stringify(sortedPlacements(before)) === JSON.stringify(sortedPlacements(after)),
    chunkCounts: after.world.chunkCounts,
  };
  write(`reload-${label}-state-before.json`, JSON.stringify(before.world));
  write(`reload-${label}-state-after.json`, JSON.stringify(after.world));
  reloadChecks.push(check);
  note(`reload ${label}: ${JSON.stringify({ ...check, chunkCounts: undefined })}`);
}
write("reload-checks.json", JSON.stringify(reloadChecks, null, 2));

const dump = await idbDump();
write("indexeddb-dump.json", JSON.stringify(dump, null, 2));
note(`IndexedDB databases: ${dump.databases.join(", ")}`);
for (const world of dump.worlds) {
  note(`  ${world.database} "${world.name}" manifest ${world.manifestBytes} B, shards: ${world.shards.map((s) => `${s.key} (${s.placements} placements, ${s.bytes} B)`).join("; ") || "none"}`);
}
await internalsShot("indexeddb-internals-before-wipe.png");

const archiveA = await exportWorld("A.brr.zip");
const origin = new URL(baseUrl).origin;
await page.goto(`${origin}/bundle/standard/manifest.json`);
const wiped = await page.evaluate(async () => {
  const before = (await indexedDB.databases()).map((d) => d.name).sort();
  for (const name of before) {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error(`${name} is blocked`));
    });
  }
  const after = (await indexedDB.databases()).map((d) => d.name);
  return { before, after };
});
write("wipe.json", JSON.stringify(wiped, null, 2));
note(`wiped IndexedDB: before ${wiped.before.join(", ")}; after [${wiped.after.join(", ")}]`);
await internalsShot("indexeddb-internals-after-wipe.png");

await page.goto(appUrl);
await ready();
note(`after wipe the app opened: ${await worldLine()}`);
await page.setInputFiles("input.world-import", path.join(outDir, "A.brr.zip"));
await page.waitForFunction(() => document.querySelector(".world-name strong")?.textContent === "Two clusters", null, { timeout: 600000 });
await settled(placed);
note(`imported A: ${await worldLine()}`);
await canvasShot("after-import.png");
const archiveB = await exportWorld("B.brr.zip");
const roundTrip = {
  a: { bytes: archiveA.length, sha256: sha256(archiveA) },
  b: { bytes: archiveB.length, sha256: sha256(archiveB) },
  identical: Buffer.compare(archiveA, archiveB) === 0,
};
write("round-trip.json", JSON.stringify(roundTrip, null, 2));
note(`round trip: ${JSON.stringify(roundTrip)}`);
write("hud-final.txt", await hud());
write("run.log", `${log.join("\n")}\n`);
await context.close();

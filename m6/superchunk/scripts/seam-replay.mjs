import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? "1"];
  }),
);
const BASE = args.url ?? "http://127.0.0.1:4182/";
const OUT = args.out ?? "/tmp/pw/seam-replay";
const WIDTH = 1600;
const HEIGHT = 1000;
const SUPER = args.superchunks ?? "1";
const ORBIT_DX = Number(args.orbitDx ?? 0);
const ORBIT_DY = Number(args.orbitDy ?? 0);
const START_WHEEL = Number(args.startWheel ?? 1800);
const STEP_WHEEL = Number(args.stepWheel ?? -60);
const STEPS = Number(args.steps ?? 60);
const STOP_ON_MIXED = args.stopOnMixed === "1";
const STOP_ON_RESIDENT = args.stopOnResident === "1";
const SHOTS = (args.shots ?? "").split(",").filter(Boolean).map(Number);
const PLATES = (args.plates ?? "-680:320,-40:320,600:320").split(",").map((p) => p.split(":").map(Number));
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/local/bin/google-chrome",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
const page = await context.newPage();
page.on("pageerror", (e) => console.log("pageerror", e.message));
await page.goto(`${BASE}?api=webgl2&frames=10${SUPER === "0" ? "&superchunks=0" : ""}`);
await page.waitForSelector(".editor[data-status=ready]", { timeout: 300000, state: "attached" });
const canvas = await page.locator("canvas.scene").boundingBox();
const centre = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };

async function hover() {
  const value = await page.locator(".editor").getAttribute("data-hover");
  if (!value) return null;
  const [x, z] = value.split(",").map(Number);
  return { x, z };
}

async function moveTo(x, y) {
  await page.mouse.move(x, y);
  for (let i = 0; i < 40; i++) {
    const h = await hover();
    if (h) return h;
    await page.waitForTimeout(5);
  }
  return null;
}

async function aim(tx, tz) {
  let x = centre.x;
  let y = centre.y;
  const probe = 24;
  for (let iter = 0; iter < 40; iter++) {
    const h = await moveTo(x, y);
    if (!h) throw new Error(`no hover at ${x},${y}`);
    if (h.x === tx && h.z === tz) return [x, y];
    const hx = await moveTo(x + probe, y);
    const hy = await moveTo(x, y + probe);
    if (!hx || !hy) throw new Error("no hover while probing");
    const a = (hx.x - h.x) / probe;
    const b = (hy.x - h.x) / probe;
    const c = (hx.z - h.z) / probe;
    const d = (hy.z - h.z) / probe;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) throw new Error("degenerate hover jacobian");
    const ex = tx - h.x;
    const ez = tz - h.z;
    let dx = (d * ex - b * ez) / det;
    let dy = (-c * ex + a * ez) / det;
    const len = Math.hypot(dx, dy);
    if (len > 300) {
      dx *= 300 / len;
      dy *= 300 / len;
    }
    x += dx;
    y += dy;
  }
  throw new Error(`could not aim at ${tx},${tz}`);
}

async function hudRow(label) {
  return page.evaluate((l) => {
    const dt = [...document.querySelectorAll(".editor-hud dt")].find((d) => d.textContent === l);
    return dt?.nextElementSibling?.textContent ?? null;
  }, label);
}

const items = await page.$$eval("[data-item]", (els) => els.map((el) => el.getAttribute("data-item")));
const plate = args.item ?? items.find((id) => id === "ldraw:3811@2") ?? items.find((id) => id === "ldraw:3811");
const button = page.locator(`[data-item="${plate}"]`);
await button.scrollIntoViewIfNeeded();
await button.click();
await page.mouse.move(centre.x, centre.y);
await page.mouse.wheel(0, START_WHEEL);
await page.waitForTimeout(500);
for (const [tx, tz] of PLATES) {
  const [x, y] = await aim(tx, tz);
  await page.mouse.click(x, y);
  await page.waitForTimeout(300);
}
await page.keyboard.press("Escape");
console.log("placements", await hudRow("Placements"));

await page.mouse.move(centre.x, centre.y);
await page.mouse.down({ button: "right" });
for (let i = 1; i <= 10; i++) await page.mouse.move(centre.x + (ORBIT_DX * i) / 10, centre.y + (ORBIT_DY * i) / 10);
await page.mouse.up({ button: "right" });

const log = [];
for (let step = 0; step <= STEPS; step++) {
  if (step > 0) {
    await page.mouse.move(centre.x, centre.y);
    await page.mouse.wheel(0, STEP_WHEEL);
  }
  const wanted = SHOTS.includes(step);
  await page.mouse.move(canvas.x + canvas.width - 4, canvas.y + canvas.height - 4);
  await page.waitForTimeout(wanted ? 20000 : 2500);
  const entry = {
    step,
    superChunks: await hudRow("Super-chunks (mesh / resident / all)"),
    tiers: await hudRow("Chunk tiers near/mid/far"),
    live: await hudRow("Live chunks"),
    studs: await hudRow("Studs drawn"),
    pitch: await hudRow("Projected stud pitch, nearest chunk"),
  };
  log.push(entry);
  console.log(JSON.stringify(entry));
  const [meshed, resident, all] = (entry.superChunks ?? "").split("/").map((v) => Number(v.trim()));
  const mixed = meshed > 0 && resident > 0 && resident < all;
  if (wanted || (STOP_ON_MIXED && mixed)) {
    if (!wanted) {
      await page.waitForTimeout(20000);
      entry.settledSuperChunks = await hudRow("Super-chunks (mesh / resident / all)");
    }
    await page.screenshot({ path: `${OUT}/step-${step}.png` });
  }
  writeFileSync(`${OUT}/log.json`, JSON.stringify(log, null, 1));
  if (STOP_ON_MIXED && mixed) break;
  if (STOP_ON_RESIDENT && resident > 0) break;
}
await browser.close();

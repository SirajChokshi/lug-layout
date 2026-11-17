import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_CORE ?? "playwright-core");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const api = arg("api", "webgpu");
const W = Number(arg("width", "1800"));
const H = Number(arg("height", "1000"));
const dpr = Number(arg("dpr", "2"));
const base = arg("base", "http://localhost:5173");
const out = arg("out", `out-${api}-${W}x${H}@${dpr}`);
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || undefined,
  channel: process.env.CHROME_PATH ? undefined : arg("channel", process.env.CHROME_CHANNEL) || undefined,
  headless: false,
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", `--window-size=${W},${H + 120}`],
});
const context = await browser.newContext({
  viewport: { width: W, height: H },
  deviceScaleFactor: dpr,
  recordVideo: { dir: out, size: { width: W, height: H } },
});
const page = await context.newPage();
const logs = [];
page.on("console", (m) => {
  if (m.type() === "error") logs.push(`console error: ${m.text()}`);
});
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(`${base}/?api=${api}&state=1`);
await page.waitForSelector('.editor[data-status="ready"], .editor[data-status="error"]', {
  state: "attached",
  timeout: 900000,
});
if ((await page.getAttribute(".editor", "data-status")) === "error") {
  throw new Error(`editor failed: ${await page.textContent(".hud")}`);
}

const pause = (ms) => page.waitForTimeout(ms);
const nextFrame = () =>
  page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
const planState = async () => JSON.parse(await page.textContent("#plan-state"));
const editState = async () => JSON.parse(await page.textContent("#edit-state"));
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
const steps = [];
const log = (s) => {
  steps.push(s);
  console.log(s);
};

async function typeMm(selector, value) {
  await page.locator(selector).first().fill(String(value));
  await nextFrame();
  await pause(200);
}

async function hoverAt(sx, sy) {
  await page.mouse.move(sx, sy);
  await nextFrame();
  const value = await page.getAttribute(".editor", "data-hover");
  if (!value) return null;
  const [x, z] = value.split(",").map(Number);
  return { x, z };
}

const free = { left: 450, right: W - 330, top: 20, bottom: H - 110 };
const pointer = { x: 0, y: 0 };

async function searchLattice(x, z) {
  let sx = pointer.x || (free.left + free.right) / 2;
  let sy = pointer.y || (free.top + free.bottom) / 2;
  for (let iteration = 0; iteration < 40; iteration++) {
    const here = await hoverAt(sx, sy);
    if (here && here.x === x && here.z === z) {
      pointer.x = sx;
      pointer.y = sy;
      return { sx, sy };
    }
    const step = 24;
    const right = await hoverAt(sx + step, sy);
    const down = await hoverAt(sx, sy + step);
    if (!here || !right || !down) {
      sx = (free.left + free.right) / 2;
      sy = Math.min(free.bottom, sy + 40);
      continue;
    }
    const a = (right.x - here.x) / step;
    const b = (down.x - here.x) / step;
    const c = (right.z - here.z) / step;
    const d = (down.z - here.z) / step;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) {
      sx += step;
      continue;
    }
    const ex = x - here.x;
    const ez = z - here.z;
    sx = Math.min(Math.max(sx + (d * ex - b * ez) / det, free.left), free.right);
    sy = Math.min(Math.max(sy + (-c * ex + a * ez) / det, free.top), free.bottom);
  }
  return null;
}

async function moveToLattice(x, z) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await searchLattice(x, z);
    if (found) return found;
    pointer.x = 0;
    pointer.y = 0;
  }
  throw new Error(`could not put the cursor on lattice point (${x}, ${z}) in 3 attempts`);
}

async function choose(id, rot = 0) {
  await page.click(`[data-item="${id}"]`);
  await nextFrame();
  for (let i = 0; i < 4 && Number(await page.getAttribute(".editor", "data-ghost-rot")) !== rot; i++) {
    await page.keyboard.press("r");
    await nextFrame();
  }
}

async function placeAt(x, z) {
  const before = (await editState()).world.placements.x.length;
  const { sx, sy } = await moveToLattice(x, z);
  await page.mouse.click(sx, sy);
  await page.waitForFunction(
    (n) => JSON.parse(document.querySelector("#edit-state").textContent).world.placements.x.length > n,
    before,
    { timeout: 300000 },
  );
  await nextFrame();
}

async function topView() {
  await page.click('[data-action="view-plan"]');
  await nextFrame();
  await pause(800);
  pointer.x = 0;
  pointer.y = 0;
}

async function workView() {
  await topView();
  for (let i = 0; i < 3; i++) {
    await page.mouse.move((free.left + free.right) / 2, (free.top + free.bottom) / 2);
    await page.mouse.wheel(0, 200);
    await nextFrame();
  }
  await pause(800);
}

const fitIssues = async () =>
  (await planState()).checks[0].issues.filter((i) => i.rule === "fit");
const describe = (issues) =>
  issues
    .map((i) => `[${i.placements.map((k) => `${k.chunkKey}:${k.slot}`).join(",")}] ${i.message}`)
    .join("\n  ");


const editorDump = async () => JSON.parse(await page.textContent("#edit-state"));
await pause(1000);
let target = { x: 0, z: 0 };
for (let i = 0; i < 6 && target.z > -3840; i++) {
  const goal = { x: 0, z: Math.max(target.z - 800, -4000) };
  const { sx, sy } = await moveToLattice(goal.x, goal.z);
  await page.mouse.move(sx, sy);
  await nextFrame();
  await page.keyboard.press("c");
  await nextFrame();
  await pause(300);
  target = goal;
  pointer.x = 0;
  pointer.y = 0;
}
log(`camera centred on lattice point ${target.x}, ${target.z}`);
await page.click('[data-action="new-plan"]');
await nextFrame();
const plan0 = (await planState()).plans[0];
log(`plan origin chunk ${plan0.originChunkX}, ${plan0.originChunkZ}`);
await page.click('[data-action="add-table"]');
await nextFrame();
const tId = (await planState()).plans[0].footprint.tables[0].id;
await typeMm(`input[name="${tId}-z"]`, 0);
await typeMm(`input[name="${tId}-depth"]`, 1321);
await topView();
const surf = (await planState()).checks[0].tables[0].surface;
log(`table surface ${JSON.stringify(surf)}`);
await shot("r1-table");
await workView();
const px = plan0.originChunkX * 640 + 4000;
await choose("ldraw:3811");
await placeAt(px, surf.minZ + 320);
log(`control baseplate on the table: ${(await planState()).checks[0].issues.length} errors, placements ${(await planState()).placements.length}`);
await choose("omr:10185-1");
const before = (await editorDump()).world.placements.x.length;
const { sx, sy } = await moveToLattice(px, -840);
await page.mouse.click(sx, sy);
await pause(3000);
await nextFrame();
const after = (await editorDump()).world.placements.x.length;
const ps = await planState();
log(`10185-1 at ${px}, -840: world placements ${before} -> ${after}; plan-state placements ${ps.placements.length}; issues ${JSON.stringify(ps.checks[0].issues.map((i) => i.message))}`);
log(`panel says: ${await page.textContent('[data-plan-errors]')}`);
await topView();
await shot("r2-after-10185");
await typeMm(`input[name="${tId}-depth"]`, 1400);
const ps2 = await planState();
log(`after editing table depth to 1400 mm: table maxZ ${ps2.checks[0].tables[0].surface.maxZ}, plan-state placements ${ps2.placements.length}, issues ${JSON.stringify(ps2.checks[0].issues.map((i) => i.message))}`);
await shot("r3-after-depth-edit");
for (const depth of [1588, 1589]) {
  await typeMm(`input[name="${tId}-depth"]`, depth);
  const ps3 = await planState();
  log(`table depth ${depth} mm: table maxZ ${ps3.checks[0].tables[0].surface.maxZ}, 10185-1 box maxZ ${ps3.placements.find((p) => p.ref === "omr:10185-1").box.maxZ}, issues ${JSON.stringify(ps3.checks[0].issues.map((i) => i.message))}, panel: ${await page.textContent('[data-plan-errors]')}`);
  await shot(`r4-depth-${depth}`);
}
writeFileSync(`${out}/steps.txt`, `${steps.join("\n")}\n${logs.join("\n")}\n`);
await context.close();
await browser.close();
console.log(logs.join("\n"));

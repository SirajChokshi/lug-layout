import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

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

await pause(1000);
await typeMm('.plan-new input[name="room-width"]', 5000);
await typeMm('.plan-new input[name="room-depth"]', 3600);
await page.click('[data-action="new-plan"]');
await nextFrame();
await page.click('[data-action="add-table"]');
await nextFrame();
const tableId = (await planState()).plans[0].footprint.tables[0].id;
await typeMm(`input[name="${tableId}-x"]`, 1600);
await typeMm(`input[name="${tableId}-z"]`, 1000);
await typeMm(`input[name="${tableId}-width"]`, 2400);
await typeMm(`input[name="${tableId}-depth"]`, 1200);
await typeMm(`input[name="${tableId}-height"]`, 750);
await topView();
await shot("01-room-and-table");
const top = (await planState()).checks[0].tables[0];
log(`room 5000 x 3600 mm, table 2400 x 1200 x 750 mm at 1600, 1000 mm: ${top.studs.studsWide} x ${top.studs.studsDeep} studs, surface ${JSON.stringify(top.surface)} LDU`);
const { minX, minZ, maxX, maxZ } = top.surface;
const half = 320;

await workView();
await choose("ldraw:3811");
for (let i = 0; i < 9; i++) await placeAt(minX + half + i * 640, minZ + half);
log(`nine baseplates along the front edge: ${(await planState()).checks[0].issues.length} errors`);
await topView();
await shot("02-nine-fit");
await workView();
await choose("ldraw:3811");
await placeAt(minX + half + 9 * 640, minZ + half);
log(`tenth baseplate:\n  ${describe(await fitIssues())}`);
await topView();
await shot("03-tenth-overhangs");

await typeMm('input[name="max-overhang"]', 100);
log(`limit 100 mm:\n  ${describe(await fitIssues())}`);
await shot("03c-limit-100");
await typeMm('input[name="max-overhang"]', 160);
log(`limit 160 mm: ${(await fitIssues()).length} fit errors`);
await shot("03d-limit-160");
await typeMm('input[name="max-overhang"]', 0);

await workView();
await choose("ldraw:3811");
for (let r = 1; r < 5; r++) await placeAt(minX + half, minZ + half + r * 640);
log(`column five deep:\n  ${describe(await fitIssues())}`);
await choose("omr:10264-1");
await placeAt(minX + 3600, minZ + 1900);
await choose("omr:10185-1");
await placeAt(minX + half + 4 * 640, minZ + half);
log(`10264-1 mid-table and 10185-1 on the front row:\n  ${describe(await fitIssues())}`);
await choose("omr:4554-1", 1);
await placeAt(maxX - 700, maxZ);
log(`4554-1 rotated 90 degrees across the back edge:\n  ${describe(await fitIssues())}`);
await choose("ldraw:3811");
await placeAt(maxX + 1680 + half, minZ + 1500);
log(`baseplate 672 mm right of the table:\n  ${describe(await fitIssues())}`);
await topView();
await shot("04-sets-rotated-and-far");
await workView();
await choose("ldraw:3811");
await placeAt(minX + 2000, -1600);
const sandbox = await planState();
log(`baseplate outside the room: sandbox ${JSON.stringify(sandbox.sandboxPlacements)}, plan errors ${sandbox.checks[0].issues.length}`);
await shot("05-sandbox-outside");

await page.keyboard.press("Escape");
await page.click('[data-action="add-obstacle"]');
await nextFrame();
const obstacleId = (await planState()).plans[0].footprint.obstacles[0].id;
await typeMm(`input[name="${obstacleId}-x"]`, 4300);
await typeMm(`input[name="${obstacleId}-z"]`, 1600);
await typeMm(`input[name="${obstacleId}-width"]`, 300);
await typeMm(`input[name="${obstacleId}-depth"]`, 300);
await typeMm(`input[name="${obstacleId}-x"]`, 3900);
log(`pillar moved onto the table: ${(await planState()).checks[0].issues.filter((i) => i.rule === "footprint").map((i) => i.message).join(" | ")}`);
await shot("06-obstacle-on-table");
await typeMm(`input[name="${obstacleId}-x"]`, 4300);

writeFileSync(`${out}/plan-state.json`, JSON.stringify(await planState(), null, 1));
writeFileSync(`${out}/edit-state.json`, JSON.stringify((await editState()).world, null, 1));

await topView();
const cx = (free.left + free.right) / 2;
const cy = (free.top + free.bottom) / 2;
await page.mouse.move(cx, cy);
await page.mouse.down({ button: "right" });
for (let i = 0; i < 30; i++) {
  await page.mouse.move(cx + i * 4, cy - i * 6);
  await nextFrame();
}
await page.mouse.up({ button: "right" });
for (let i = 0; i < 3; i++) {
  await page.mouse.wheel(0, -200);
  await nextFrame();
}
await pause(1500);
await shot("07-perspective");
writeFileSync(`${out}/steps.txt`, `${steps.join("\n")}\n${logs.join("\n")}\n`);
await context.close();
await browser.close();
console.log(logs.join("\n"));

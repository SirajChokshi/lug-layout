import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
const api = process.argv[2] ?? "webgl2";
const out = process.argv[3] ?? "/tmp/pw/out";
mkdirSync(out, { recursive: true });
const W = 1600, H = 1000;
const browser = await chromium.launch({ executablePath: process.env.CHROME ?? "/usr/local/bin/google-chrome", headless: false, args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", `--window-size=${W},${H}`] });
const context = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: out, size: { width: W, height: H } } });
const page = await context.newPage();
const logs = [];
page.on("console", (m) => { if (m.type() === "error") logs.push(`console error: ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
await page.goto(`http://localhost:5173/?api=${api}&state=1`);
await page.waitForFunction(() => document.querySelector(".editor")?.dataset.status !== "loading", null, { timeout: 300000 });
const pause = (ms) => page.waitForTimeout(ms);
const planState = async () => JSON.parse(await page.locator("#plan-state").textContent());
const editState = async () => JSON.parse(await page.locator("#edit-state").textContent());
const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });
async function typeMm(selector, value) {
  const input = page.locator(selector).first();
  await input.fill(String(value));
  await pause(250);
}
async function hoverAt(px, py) {
  await page.mouse.move(px, py);
  await pause(60);
  const h = await page.locator(".editor").getAttribute("data-hover");
  if (!h) return null;
  const [x, z] = h.split(",").map(Number);
  return { x, z };
}
let map = null;
async function calibrate() {
  const a = await hoverAt(700, 300);
  const b = await hoverAt(1100, 700);
  map = { sx: (b.x - a.x) / 400, sz: (b.z - a.z) / 400, ax: a.x, az: a.z, px: 700, py: 300 };
}
async function moveToLattice(x, z) {
  let px = map.px + (x - map.ax) / map.sx;
  let py = map.py + (z - map.az) / map.sz;
  for (let i = 0; i < 12; i++) {
    const h = await hoverAt(px, py);
    if (h && h.x === x && h.z === z) return [px, py];
    if (h) { px += Math.sign(x - h.x) * 0.5 * Math.max(1, Math.abs(x - h.x) / Math.abs(map.sx)); py += Math.sign(z - h.z) * 0.5 * Math.max(1, Math.abs(z - h.z) / Math.abs(map.sz)); }
  }
  throw new Error(`could not reach lattice ${x},${z}`);
}
async function placeAt(x, z) {
  const [px, py] = await moveToLattice(x, z);
  await page.mouse.click(px, py);
  await pause(500);
}
const steps = [];
const log = (s) => { steps.push(s); console.log(s); };

await pause(1500);
await typeMm('.plan-new input[name="room-width"]', 4000);
await typeMm('.plan-new input[name="room-depth"]', 3000);
await page.click('[data-action="new-plan"]');
await pause(800);
await page.click('[data-action="add-table"]');
await pause(800);
const tableId = (await planState()).plans[0].footprint.tables[0].id;
await typeMm(`input[name="${tableId}-x"]`, 800);
await typeMm(`input[name="${tableId}-z"]`, 800);
await typeMm(`input[name="${tableId}-width"]`, 2400);
await typeMm(`input[name="${tableId}-depth"]`, 1200);
await typeMm(`input[name="${tableId}-height"]`, 750);
await page.click('[data-action="view-plan"]');
await pause(1200);
await shot("01-room-and-table");
log("room 4000 x 3000 mm and table 2400 x 1200 mm x 750 mm drawn");

await page.click('[data-item="ldraw:3811"]');
await pause(400);
await calibrate();
const plan = (await planState()).checks[0];
const tableMinX = plan.tables[0].surface.minX, tableMinZ = plan.tables[0].surface.minZ;
const half = 320;
for (let i = 0; i < 9; i++) await placeAt(tableMinX + half + i * 640, tableMinZ + half);
await pause(800);
let check = (await planState()).checks[0];
log(`nine 3811 baseplates along the near edge: ${check.inside.length} inside, ${check.issues.length} errors`);
await shot("02-nine-fit");
await placeAt(tableMinX + half + 9 * 640, tableMinZ + half);
await pause(1000);
check = (await planState()).checks[0];
log(`tenth baseplate: ${check.issues.map((i) => i.message).join(" | ")}`);
await shot("03-tenth-overhangs");
{
  const [ex, ez] = await moveToLattice(tableMinX + 6000, tableMinZ + 320);
  await page.keyboard.press("Escape");
  await page.mouse.move(ex, ez);
  await page.keyboard.press("c");
  for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -250); await pause(150); }
  await pause(1500);
  await shot("03b-overhang-closeup");
  await page.click('[data-action="view-plan"]');
  await pause(1000);
  await page.click('[data-item="ldraw:3811"]');
  await pause(300);
}
for (let r = 1; r < 4; r++) await placeAt(tableMinX + half, tableMinZ + half + r * 640);
await placeAt(tableMinX + half, tableMinZ + half + 4 * 640);
await pause(1000);
check = (await planState()).checks[0];
log(`column of five deep: ${check.issues.map((i) => i.message).join(" | ")}`);
await shot("04-fifth-row-overhangs");
await page.click('[data-item="omr:10264-1"]');
await pause(600);
await placeAt(tableMinX + 3600, tableMinZ + 1900);
await pause(1200);
check = (await planState()).checks[0];
log(`10264-1 in the middle of the table: errors ${check.issues.length}`);
await page.click('[data-item="omr:10185-1"]');
await pause(600);
await placeAt(tableMinX + half + 4 * 640, tableMinZ + half);
await pause(1200);
check = (await planState()).checks[0];
log(`10185-1 on the front row: ${check.issues.filter((i) => i.message.startsWith("10185")).map((i) => i.message).join(" | ")}`);
await shot("04b-sets-on-table");
await page.click('[data-item="ldraw:3811"]');
await pause(400);
for (let i = 0; i < 4; i++) { await page.mouse.move(800, 500); await page.mouse.wheel(0, 200); await pause(150); }
await pause(800);
await calibrate();
await placeAt(5000, -1600);
await pause(800);
const ps = await planState();
log(`one baseplate outside the room: sandbox placements ${JSON.stringify(ps.sandboxPlacements)}, plan errors still ${ps.checks[0].issues.length}`);
await shot("05-sandbox-outside");
await page.keyboard.press("Escape");
await page.click('[data-action="add-obstacle"]');
await pause(500);
const obstacleId = (await planState()).plans[0].footprint.obstacles[0].id;
await typeMm(`input[name="${obstacleId}-x"]`, 3400);
await typeMm(`input[name="${obstacleId}-z"]`, 800);
await typeMm(`input[name="${obstacleId}-width"]`, 300);
await typeMm(`input[name="${obstacleId}-depth"]`, 300);
await pause(800);
await shot("06-obstacle");
log(`obstacle pillar 300 x 300 mm at 3400, 800 mm: errors ${(await planState()).checks[0].issues.length}`);
await typeMm(`input[name="${obstacleId}-x"]`, 3000);
await pause(800);
log(`pillar moved onto the table: ${(await planState()).checks[0].issues.filter((i) => i.rule === "footprint").map((i) => i.message).join(" | ")}`);
await shot("07-obstacle-on-table");
await typeMm(`input[name="${obstacleId}-x"]`, 3400);
await pause(800);
writeFileSync(`${out}/plan-state.json`, JSON.stringify(await planState(), null, 1));
writeFileSync(`${out}/edit-state.json`, JSON.stringify((await editState()).world, null, 1));
writeFileSync(`${out}/steps.txt`, steps.join("\n") + "\n" + logs.join("\n") + "\n");
await page.mouse.move(800, 500);
await page.mouse.down({ button: "right" });
for (let i = 0; i < 30; i++) { await page.mouse.move(800 + i * 4, 500 - i * 6); await pause(60); }
await page.mouse.up({ button: "right" });
await pause(1500);
await shot("08-perspective");
for (let i = 0; i < 3; i++) { await page.mouse.move(800, 500); await page.mouse.wheel(0, -200); await pause(200); }
await pause(1500);
await shot("09-perspective-closer");
await context.close();
await browser.close();
console.log(logs.join("\n"));

import { writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
import { findScreen } from "./lib.mjs";
import { newPlan, addTable, viewPlan, planState, fill } from "./ui.mjs";

const OUT = process.env.OUT ?? "/opt/cursor/artifacts/m5-track";
const BASE = "http://localhost:5174/?api=webgl2&state=1";
const STUD = 20;
const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: false,
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1440 } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error") logs.push(`console: ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
const record = {};

async function report() {
  return JSON.parse(await page.locator("#buildable-state").innerText())[0];
}

async function step(name) {
  const r = await report();
  record[name] = { report: r, track: (await page.locator(".track-panel").innerText().catch(() => "")).replace(/\n/g, " | ") };
  console.log(`== ${name}: ${r.verdict} errors=${r.errors} warnings=${r.warnings} parts=${r.bom.totalParts}`);
  console.log(`   track panel: ${record[name].track}`);
  for (const i of r.issues) console.log(`   [${i.rule}/${i.severity}] ${i.message.slice(0, 260)}`);
  await page.screenshot({ path: `${OUT}/${name}.png` });
}

const OVAL = {
  a: [160, 65], b: [240, 65], u1: [266, 73], u2: [280, 100], u3: [268, 133],
  c: [240, 145], d: [160, 145], w1: [134, 137], w2: [120, 110], w3: [132, 77],
};
const RUNS = { p0: [170, 168], p1: [230, 168], q0: [320, 150], q1: [320, 205] };

async function setup() {
  console.log('setup: goto');
  await page.goto(BASE);
  await page.waitForSelector('.editor[data-status="ready"]', { timeout: 300000 });
  console.log('setup: ready');
  const plan = await newPlan(page, 4000, 2400);
  console.log('setup: plan', plan.originChunkX, plan.originChunkZ);
  await addTable(page, { x: 400, z: 240, width: 2400, depth: 1200 });
  await viewPlan(page);
  const ox = plan.originChunkX * 640;
  const oz = plan.originChunkZ * 640;
  const screen = {};
  for (const [name, [x, z]] of Object.entries({ ...OVAL, ...RUNS })) {
    const { px, py } = await findScreen(page, ox + x * STUD, oz + z * STUD);
    screen[name] = { sx: px, sy: py };
    console.log('calibrated', name, Math.round(px), Math.round(py));
  }
  return screen;
}

async function drag(screen, names) {
  console.log('drag', names.join(' '));
  const [first, ...rest] = names;
  await page.mouse.move(screen[first].sx, screen[first].sy, { steps: 8 });
  await page.waitForTimeout(250);
  await page.mouse.down();
  for (const name of rest) {
    await page.mouse.move(screen[name].sx, screen[name].sy, { steps: 18 });
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(900);
  await page.mouse.up();
  await page.waitForTimeout(700);
}

async function oval(screen) {
  await drag(screen, ["a", "b"]);
  await drag(screen, ["b", "u1", "u2", "u3", "c"]);
  await drag(screen, ["c", "d"]);
  await drag(screen, ["d", "w1", "w2", "w3", "a"]);
}

let screen = await setup();
await page.click('button[data-item="track:lego-9v"]');
await page.waitForTimeout(500);
await oval(screen);
await page.locator(".buildable-bom summary").click();
await step("01-9v-oval-closed");
await drag(screen, ["p0", "p1"]);
await step("02-open-run");
await drag(screen, ["q0", "q1"]);
await step("03-run-off-the-table");

screen = await setup();
await page.click('button[data-item="track:lego-plastic"]');
await page.waitForTimeout(500);
await oval(screen);
await page.locator(".buildable-bom summary").click();
await step("04-plastic-oval-unverified");
const tables = (await planState(page)).plans.at(-1).footprint.tables;
await fill(page, `${tables[0].id}-width`, 1300);
await addTable(page, { x: 1700, z: 240, width: 1100, depth: 1200 });
await page.waitForTimeout(400);
await step("05-seam-off-module-grid");

writeFileSync(`${OUT}/track-reports.json`, JSON.stringify(record, null, 1));
console.log(logs.join("\n"));
await browser.close();

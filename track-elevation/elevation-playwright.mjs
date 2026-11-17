import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:5173";
const OUT = process.env.OUT ?? "/tmp/pw/out";
const MODE = process.env.MODE ?? "after";
mkdirSync(OUT, { recursive: true });
const log = [];
const note = (line) => {
  log.push(line);
  console.log(line);
};

const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("console", (m) => {
  if (m.type() === "error") note(`console error: ${m.text()}`);
});
page.on("pageerror", (e) => note(`page error: ${e.message}`));
await page.goto(`${BASE}/?api=webgl2`);
await page.waitForSelector('.editor[data-status="ready"]', { timeout: 180000, state: "attached" });
const editor = page.locator(".editor");
const canvas = page.locator("canvas.scene");

async function hoverAt(x, y) {
  await page.mouse.move(x, y);
  await page.waitForTimeout(30);
  const hover = await editor.getAttribute("data-hover");
  if (!hover) return null;
  const [hx, hz] = hover.split(",").map(Number);
  return { x: hx, z: hz };
}

async function pixelFor(tx, tz) {
  let px = 800;
  let py = 500;
  for (let i = 0; i < 30; i++) {
    const h = await hoverAt(px, py);
    const hx = await hoverAt(px + 40, py);
    const hy = await hoverAt(px, py + 40);
    if (!h || !hx || !hy) throw new Error(`no hover at ${px},${py}`);
    if (h.x === tx && h.z === tz) return { x: px, y: py };
    const a = (hx.x - h.x) / 40;
    const b = (hy.x - h.x) / 40;
    const c = (hx.z - h.z) / 40;
    const d = (hy.z - h.z) / 40;
    const det = a * d - b * c;
    const ex = tx - h.x;
    const ez = tz - h.z;
    const dx = (d * ex - b * ez) / det;
    const dy = (-c * ex + a * ez) / det;
    px = Math.min(1180, Math.max(470, px + dx));
    py = Math.min(995, Math.max(5, py + dy));
  }
  const h = await hoverAt(px, py);
  if (h && Math.abs(h.x - tx) <= 20 && Math.abs(h.z - tz) <= 20) return { x: px, y: py };
  throw new Error(`could not find pixel for ${tx},${tz}`);
}

async function choose(prefix) {
  const picked = await page.evaluate((prefix) => {
    const items = [...document.querySelectorAll(`[data-item^="${prefix}"]`)];
    const green = items.find((item) => item.getAttribute("title") === "Green");
    const item = green ?? items[0];
    item?.click();
    return item?.getAttribute("data-item") ?? null;
  }, prefix);
  note(`chose ${picked}`);
  await page.waitForTimeout(200);
}

async function clickStud(xs, zs) {
  const p = await pixelFor(xs * 20, zs * 20);
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(150);
}

async function dragStuds(from, to) {
  const a = await pixelFor(from[0] * 20, from[1] * 20);
  const b = await pixelFor(to[0] * 20, to[1] * 20);
  note(`drag ${from} -> ${to} at pixels ${Math.round(a.x)},${Math.round(a.y)} -> ${Math.round(b.x)},${Math.round(b.y)}`);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(a.x + ((b.x - a.x) * i) / steps, a.y + ((b.y - a.y) * i) / steps);
    await page.waitForTimeout(40);
  }
  return {
    release: async () => {
      await page.mouse.up();
      await page.waitForTimeout(300);
    },
    point: b,
  };
}

async function trackState() {
  return page.evaluate(() => {
    const panel = document.querySelector(".track-panel");
    const rules = document.querySelector(".placement-rules, [aria-label='Placement rules']");
    return {
      pieces: panel?.getAttribute("data-track-pieces"),
      joins: panel?.getAttribute("data-joins"),
      open: panel?.getAttribute("data-open-ends"),
      piers: panel?.getAttribute("data-piers"),
      crossings: panel?.getAttribute("data-crossings"),
      lastCommit: panel?.getAttribute("data-last-commit"),
      labels: [...document.querySelectorAll(".height-label")].map((l) => l.textContent),
      refusal: rules?.textContent?.slice(0, 600) ?? null,
    };
  });
}

async function shot(name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  note(`shot ${name}: ${JSON.stringify(await trackState())}`);
}

async function setHeight(plates) {
  const current = Number((await page.locator(".track-height").getAttribute("data-draw-plates")) ?? 0);
  let delta = plates - current;
  while (delta !== 0) {
    if (Math.abs(delta) >= 3) {
      await page.keyboard.press(delta > 0 ? "Shift+PageUp" : "Shift+PageDown");
      delta += delta > 0 ? -3 : 3;
    } else {
      await page.keyboard.press(delta > 0 ? "PageUp" : "PageDown");
      delta += delta > 0 ? -1 : 1;
    }
  }
}

await page.mouse.move(800, 500);
for (let i = 0; i < 9; i++) await page.mouse.wheel(0, 140);
await page.waitForTimeout(300);
await choose("ldraw:3811");
for (const [x, z] of [[-48, -16], [-16, -16], [16, -16], [48, -16], [80, -16], [112, -16], [-48, 16], [-16, 16], [16, 16], [48, 16], [80, 16], [112, 16]]) {
  await clickStud(x, z);
}
await choose("track:");
const ground = await dragStuds([-56, 0], [56, 0]);
await ground.release();
await shot("01-ground-line");

if (MODE === "after") await setHeight(38);
const low = await dragStuds([8, -24], [8, 24]);
await shot("02-bridge-38-ghost");
await low.release();
await shot("03-bridge-38-released");

if (MODE === "after") await setHeight(39);
const bridge = await dragStuds([8, -24], [8, 24]);
await shot("04-bridge-39-ghost");
await bridge.release();
await shot("05-bridge-39-laid");

if (MODE === "after") await setHeight(4);
const ramp = await dragStuds([56, 0], [120, 0]);
await shot("06-ramp-ghost");
await ramp.release();
await shot("07-ramp-laid");

await page.keyboard.press("Escape");
async function closeUp(name, at, zoomSteps, pitchPx, extraZoom = 8) {
  const centre = await canvas.boundingBox();
  await page.mouse.move(centre.width / 2, centre.height / 2);
  for (let i = 0; i < zoomSteps; i++) await page.mouse.wheel(0, 140);
  await page.waitForTimeout(200);
  const p = await pixelFor(at[0] * 20, at[1] * 20);
  note(`close-up ${name} centred on ${at}`);
  await page.mouse.move(p.x, p.y);
  await page.keyboard.press("c");
  await page.waitForTimeout(200);
  const box = await canvas.boundingBox();
  await page.mouse.move(box.width / 2, box.height / 2);
  for (let i = 0; i < zoomSteps + extraZoom; i++) await page.mouse.wheel(0, -140);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.width / 2 + 60, box.height / 2 - pitchPx, { steps: 8 });
  await page.mouse.up({ button: "right" });
  await shot(name);
}
await closeUp("08-viaduct-close", [8, 0], 0, 70);


writeFileSync(`${OUT}/log.txt`, `${log.join("\n")}\n`);
await browser.close();

import { mkdirSync, writeFileSync } from "node:fs";
import { openEditor, placeWith, calibrate, state, hud, settle, orbit, wheel } from "./drive.mjs";

const base = process.env.BASE ?? "http://127.0.0.1:5173";
const out = process.env.OUT ?? "/tmp/pw/scene-after";
const api = process.env.API ?? "webgl2";
const frames = Number(process.env.FRAMES ?? 30);
mkdirSync(out, { recursive: true });

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
const SPACING = 1600;
const slots = SETS.map((set, k) => ({
  set,
  x: (k % 5) * SPACING - 2 * SPACING,
  z: Math.floor(k / 5) * SPACING - SPACING / 2,
}));

async function frameIntervals(page, count) {
  return page.evaluate(async (n) => {
    const t = [];
    let last = performance.now();
    for (let i = 0; i < n; i++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = performance.now();
      t.push(now - last);
      last = now;
    }
    return t;
  }, count);
}

function median(values) {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function capture(page, name) {
  await page.mouse.move(2, 2);
  await settle(page, 3000);
  await frameIntervals(page, 3);
  const intervals = await frameIntervals(page, frames);
  const text = await hud(page);
  await page.screenshot({ path: `${out}/${name}.png`, timeout: 300000 });
  const canvas = await page.evaluate(() => {
    const c = document.querySelector("canvas.scene");
    return { width: c.width, height: c.height, dpr: window.devicePixelRatio };
  });
  return { name, medianFrameMs: median(intervals), intervals, hud: text, canvas };
}

const { browser, page } = await openEditor({ base, api });
await wheel(page, 600, Number(process.env.ZOOM_OUT ?? 3));
await settle(page, 1000);
const map = await calibrate(page);
console.log("calibrated from", map.samples, "samples");
for (const { set, x, z } of slots) {
  await placeWith(page, map, "ldraw:3811", x, z);
  await placeWith(page, map, `omr:${set}`, x, z);
  console.log("placed", set, x, z);
}
await wheel(page, -600, 1);
const aerial = await capture(page, "aerial");
await orbit(page, 0, -110);
await wheel(page, -500, 2);
const street = await capture(page, "street");
const s = await state(page);
writeFileSync(
  `${out}/scene.json`,
  JSON.stringify(
    { base, api, userAgent: await page.evaluate(() => navigator.userAgent), slots, aerial, street, world: s.world, latencies: s.latencies },
    null,
    2,
  ),
);
console.log("aerial", aerial.medianFrameMs, aerial.hud);
console.log("street", street.medianFrameMs, street.hud);
await browser.close();

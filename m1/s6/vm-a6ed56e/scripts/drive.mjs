import { chromium } from "playwright-core";

export async function openEditor({ base, api = "webgl2", width = 1600, height = 1000, query = "" }) {
  const browser = await chromium.launch({
    executablePath: process.env.CHROME ?? "/usr/local/bin/google-chrome",
    headless: false,
    args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const logs = [];
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/?api=${api}&state=1${query}`);
  await page.waitForFunction(
    () => {
      const status = document.querySelector(".editor")?.getAttribute("data-status");
      return status === "ready" || status === "error";
    },
    null,
    { timeout: 900000, polling: 500 },
  );
  const status = await page.locator(".editor").getAttribute("data-status");
  if (status !== "ready") throw new Error(`editor ${status}: ${logs.join("\n")}`);
  return { browser, page, logs };
}

export async function canvasBox(page) {
  return page.locator("canvas.scene").boundingBox();
}

async function hoverAt(page, px, py) {
  await page.mouse.move(px, py);
  await page.waitForTimeout(30);
  const hover = await page.locator(".editor").getAttribute("data-hover");
  if (!hover) return null;
  const [x, z] = hover.split(",").map(Number);
  return { x, z };
}

const LEFT_CLEAR_PX = 400;
const RIGHT_CLEAR_PX = 360;
const BOTTOM_CLEAR_PX = 90;

function region(box) {
  return {
    minX: box.x + LEFT_CLEAR_PX,
    maxX: box.x + box.width - RIGHT_CLEAR_PX,
    minY: box.y + 10,
    maxY: box.y + box.height - BOTTOM_CLEAR_PX,
  };
}

async function newton(page, x, z, exact) {
  const box = await canvasBox(page);
  const r = region(box);
  let px = (r.minX + r.maxX) / 2;
  let py = (r.minY + r.maxY) / 2;
  let best = null;
  let good = null;
  for (let iteration = 0; iteration < 60; iteration++) {
    const here = await hoverAt(page, px, py);
    if (!here) {
      if (!good) throw new Error(`cursor at ${px},${py} is off the ground`);
      px = (px + good.px) / 2;
      py = (py + good.py) / 2;
      continue;
    }
    good = { px, py };
    const error = Math.hypot(here.x - x, here.z - z);
    if (!best || error < best.error) best = { px, py, error };
    if (error === 0) return best;
    const step = 6;
    const ax = await hoverAt(page, px + step, py);
    const ay = await hoverAt(page, px, py + step);
    if (!ax || !ay) {
      py += 20;
      continue;
    }
    const j11 = (ax.x - here.x) / step;
    const j21 = (ax.z - here.z) / step;
    const j12 = (ay.x - here.x) / step;
    const j22 = (ay.z - here.z) / step;
    const det = j11 * j22 - j12 * j21;
    const ex = x - here.x;
    const ez = z - here.z;
    let dx = det === 0 ? 1 : (j22 * ex - j12 * ez) / det;
    let dy = det === 0 ? 1 : (-j21 * ex + j11 * ez) / det;
    const limit = 300;
    const length = Math.hypot(dx, dy);
    if (length > limit) {
      dx *= limit / length;
      dy *= limit / length;
    }
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) {
      dx = Math.sign(ex || 1) * 0.5;
      dy = Math.sign(ez || 1) * 0.5;
    }
    const nx = Math.min(Math.max(px + dx, r.minX), r.maxX);
    const ny = Math.min(Math.max(py + dy, r.minY), r.maxY);
    if (!exact && nx === px && ny === py) return best;
    px = nx;
    py = ny;
  }
  if (!exact) return best;
  throw new Error(`could not aim at ${x},${z}`);
}

function solve(matrix, rhs) {
  const n = rhs.length;
  const m = matrix.map((row, i) => [...row, rhs[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c <= n; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

export async function calibrate(page) {
  const box = await canvasBox(page);
  const r = region(box);
  const samples = [];
  const steps = 5;
  for (let i = 0; i < steps; i++) {
    for (let j = 0; j < steps; j++) {
      const u = r.minX + ((r.maxX - r.minX) * i) / (steps - 1);
      const v = r.minY + ((r.maxY - r.minY) * j) / (steps - 1);
      const hit = await hoverAt(page, u, v);
      if (hit) samples.push({ u, v, x: hit.x, z: hit.z });
    }
  }
  const normal = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const rhs = new Array(8).fill(0);
  for (const { u, v, x, z } of samples) {
    const rows = [
      [[x, z, 1, 0, 0, 0, -u * x, -u * z], u],
      [[0, 0, 0, x, z, 1, -v * x, -v * z], v],
    ];
    for (const [a, b] of rows) {
      for (let p = 0; p < 8; p++) {
        rhs[p] += a[p] * b;
        for (let q = 0; q < 8; q++) normal[p][q] += a[p] * a[q];
      }
    }
  }
  const h = solve(normal, rhs);
  return {
    samples: samples.length,
    region: r,
    toScreen(x, z) {
      const w = h[6] * x + h[7] * z + 1;
      return [(h[0] * x + h[1] * z + h[2]) / w, (h[3] * x + h[4] * z + h[5]) / w];
    },
  };
}

export async function aimWith(page, map, x, z) {
  const [u, v] = map.toScreen(x, z);
  const r = map.region;
  if (u < r.minX || u > r.maxX || v < r.minY || v > r.maxY) {
    throw new Error(`target ${x},${z} projects to ${u.toFixed(0)},${v.toFixed(0)}, outside the clear region`);
  }
  const here = await hoverAt(page, u, v);
  if (here && here.x === x && here.z === z) return { px: u, py: v };
  return newtonFrom(page, x, z, u, v);
}

async function newtonFrom(page, x, z, startX, startY) {
  let px = startX;
  let py = startY;
  for (let iteration = 0; iteration < 30; iteration++) {
    const here = await hoverAt(page, px, py);
    if (!here) throw new Error(`cursor at ${px},${py} is off the ground`);
    if (here.x === x && here.z === z) return { px, py };
    const step = 3;
    const ax = await hoverAt(page, px + step, py);
    const ay = await hoverAt(page, px, py + step);
    const j11 = (ax.x - here.x) / step;
    const j21 = (ax.z - here.z) / step;
    const j12 = (ay.x - here.x) / step;
    const j22 = (ay.z - here.z) / step;
    const det = j11 * j22 - j12 * j21;
    const ex = x - here.x;
    const ez = z - here.z;
    let dx = det === 0 ? 0.5 : (j22 * ex - j12 * ez) / det;
    let dy = det === 0 ? 0.5 : (-j21 * ex + j11 * ez) / det;
    if (Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3) {
      dx = Math.sign(dx || 1) * 0.3;
      dy = Math.sign(dy || 1) * 0.3;
    }
    px += Math.max(-40, Math.min(40, dx));
    py += Math.max(-40, Math.min(40, dy));
  }
  throw new Error(`could not aim at ${x},${z}`);
}

export async function placeWith(page, map, id, x, z, turns = 0) {
  await choose(page, id);
  for (let i = 0; i < turns; i++) await page.keyboard.press("r");
  const { px, py } = await aimWith(page, map, x, z);
  const before = Number(await page.locator("#edit-state").getAttribute("data-placements"));
  await page.mouse.click(px, py);
  await page.waitForFunction(
    (n) => Number(document.querySelector("#edit-state")?.getAttribute("data-placements")) === n,
    before + 1,
    { timeout: 300000 },
  );
  for (let i = 0; i < (4 - (turns % 4)) % 4; i++) await page.keyboard.press("r");
  await page.keyboard.press("Escape");
}

export async function centreOn(page, x, z) {
  for (let pass = 0; pass < 3; pass++) {
    const near = await newton(page, x, z, false);
    await page.mouse.move(near.px, near.py);
    await page.waitForTimeout(30);
    await page.keyboard.press("c");
    await page.waitForTimeout(60);
    if (near.error === 0) return;
  }
}

export async function aim(page, x, z) {
  await centreOn(page, x, z);
  return newton(page, x, z, true);
}

export async function choose(page, id) {
  await page.locator(`[data-item="${id}"]`).click();
}

export async function placeAt(page, id, x, z, turns = 0) {
  await choose(page, id);
  for (let i = 0; i < turns; i++) await page.keyboard.press("r");
  const { px, py } = await aim(page, x, z);
  const before = Number(await page.locator("#edit-state").getAttribute("data-placements"));
  await page.mouse.click(px, py);
  await page.waitForFunction(
    (n) => Number(document.querySelector("#edit-state")?.getAttribute("data-placements")) === n,
    before + 1,
    { timeout: 120000 },
  );
  for (let i = 0; i < (4 - (turns % 4)) % 4; i++) await page.keyboard.press("r");
  await page.keyboard.press("Escape");
}

export async function state(page) {
  return JSON.parse(await page.locator("#edit-state").innerText());
}

export async function hud(page) {
  return (await page.locator(".editor-hud").innerText()).replace(/\n/g, " | ");
}

export async function wheel(page, deltaY, times = 1) {
  const box = await canvasBox(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, deltaY);
    await page.waitForTimeout(20);
  }
}

export async function orbit(page, dx, dy) {
  const box = await canvasBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down({ button: "right" });
  const steps = 10;
  for (let i = 1; i <= steps; i++) await page.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps);
  await page.mouse.up({ button: "right" });
}

export async function pan(page, dx, dy) {
  const box = await canvasBox(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.keyboard.down("Shift");
  await page.mouse.down({ button: "left" });
  const steps = 10;
  for (let i = 1; i <= steps; i++) await page.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps);
  await page.mouse.up({ button: "left" });
  await page.keyboard.up("Shift");
}

export async function settle(page, ms = 1500) {
  await page.waitForTimeout(ms);
}

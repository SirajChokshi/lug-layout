import { chromium } from "playwright-core";

export const VIEW = { width: 1600, height: 1000 };
const PROBE_REGION = { x0: 360, x1: 1240, y0: 240, y1: 880 };

export async function openEditor({ url, video }) {
  const browser = await chromium.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: false,
    args: ["--enable-unsafe-webgpu", "--use-angle=swiftshader"],
  });
  const context = await browser.newContext({
    viewport: VIEW,
    deviceScaleFactor: 1,
    ...(video ? { recordVideo: { dir: video, size: VIEW } } : {}),
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message));
  await page.goto(url);
  await page.waitForSelector('.editor[data-status="ready"]', { timeout: 300_000, state: "attached" });
  return { browser, context, page };
}

async function attr(page, name) {
  return page.locator(".editor").getAttribute(name);
}

export async function hoverAt(page, px, py) {
  await page.mouse.move(px, py);
  await page.waitForFunction(() => true);
  await page.waitForTimeout(40);
  const value = await attr(page, "data-hover");
  if (!value) return null;
  const [x, z] = value.split(",").map(Number);
  return { x, z };
}

function solve(a, b) {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r;
    [m[c], m[p]] = [m[p], m[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = m[r][c] / m[c][c];
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k];
    }
  }
  return m.map((row, i) => row[n] / row[i]);
}

function fitHomography(pairs) {
  const ata = Array.from({ length: 8 }, () => new Array(8).fill(0));
  const atb = new Array(8).fill(0);
  const add = (row, rhs) => {
    for (let i = 0; i < 8; i++) {
      atb[i] += row[i] * rhs;
      for (let j = 0; j < 8; j++) ata[i][j] += row[i] * row[j];
    }
  };
  for (const { from, to } of pairs) {
    const [x, y] = from;
    const [u, v] = to;
    add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
    add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
  }
  const h = solve(ata, atb);
  return ([x, y]) => {
    const w = h[6] * x + h[7] * y + 1;
    return [(h[0] * x + h[1] * y + h[2]) / w, (h[3] * x + h[4] * y + h[5]) / w];
  };
}

export async function calibrate(page) {
  const pairs = [];
  for (let i = 0; i <= 5; i++) {
    for (let j = 0; j <= 5; j++) {
      const px = PROBE_REGION.x0 + ((PROBE_REGION.x1 - PROBE_REGION.x0) * i) / 5;
      const py = PROBE_REGION.y0 + ((PROBE_REGION.y1 - PROBE_REGION.y0) * j) / 5;
      const hit = await hoverAt(page, px, py);
      if (hit) pairs.push({ from: [hit.x, hit.z], to: [px, py] });
    }
  }
  return fitHomography(pairs);
}

export async function screenFor(page, toScreen, x, z) {
  let [px, py] = toScreen([x, z]);
  for (let step = 0; step < 12; step++) {
    const hit = await hoverAt(page, px, py);
    if (hit && hit.x === x && hit.z === z) return [px, py];
    if (!hit) break;
    const [hx, hy] = toScreen([hit.x, hit.z]);
    const [tx, ty] = toScreen([x, z]);
    px += tx - hx;
    py += ty - hy;
  }
  return [px, py];
}

export async function chooseItem(page, id) {
  await page.locator(`[data-item="${id}"]`).click();
  await page.evaluate(() => document.activeElement?.blur());
}

export async function select(page) {
  await page.keyboard.press("Escape");
}

export async function setRot(page, rot) {
  for (let i = 0; i < 4; i++) {
    if (Number(await attr(page, "data-ghost-rot")) === rot) return;
    await page.keyboard.press("r");
    await page.waitForTimeout(40);
  }
}

export async function roadCounts(page) {
  return {
    joined: Number(await attr(page, "data-road-joined")),
    open: Number(await attr(page, "data-road-open")),
    mismatch: Number(await attr(page, "data-road-mismatch")),
  };
}

export async function probe(page, toScreen, x, z) {
  const [px, py] = await screenFor(page, toScreen, x, z);
  const snap = await attr(page, "data-snap");
  const hover = await attr(page, "data-hover");
  return { px, py, snap: snap === "" ? 0 : Number(snap), hover };
}

export async function placeAt(page, px, py) {
  await page.mouse.move(px, py);
  await page.waitForTimeout(40);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(400);
}

export async function setCheckbox(page, label, checked) {
  const box = page.getByLabel(label);
  if ((await box.isChecked()) !== checked) await box.click();
  await page.evaluate(() => document.activeElement?.blur());
}

export async function zoom(page, delta) {
  await page.mouse.move(800, 560);
  await page.mouse.wheel(0, delta);
  await page.waitForTimeout(300);
}

export async function editState(page) {
  const text = await page.locator("#edit-state").textContent();
  return JSON.parse(text);
}

export async function closeUp(page, toScreen, x, z, { wheel = -900, orbitDx = 0, orbitDy = -80 } = {}) {
  const [px, py] = await screenFor(page, toScreen, x, z);
  await page.mouse.move(px, py);
  await page.waitForTimeout(100);
  await page.keyboard.press("c");
  await page.waitForTimeout(300);
  await page.mouse.move(800, 560);
  await page.mouse.wheel(0, wheel);
  await page.waitForTimeout(300);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(800 + orbitDx, 560 + orbitDy, { steps: 8 });
  await page.mouse.up({ button: "right" });
  await page.waitForTimeout(1500);
}

export async function checkMs(page) {
  return Number((await page.locator('[data-road="check-ms"]').textContent()).replace(" ms", ""));
}

export async function focusPiece(page, toScreen, x, z, { orbitDx = 0, orbitDy = -60, wheel = 0 } = {}) {
  await page.keyboard.press("Escape");
  const [px, py] = await screenFor(page, toScreen, x, z);
  await placeAt(page, px, py);
  await page.keyboard.press("f");
  await page.waitForTimeout(300);
  await page.mouse.move(800, 560);
  if (wheel !== 0) await page.mouse.wheel(0, wheel);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(800 + orbitDx, 560 + orbitDy, { steps: 8 });
  await page.mouse.up({ button: "right" });
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
}

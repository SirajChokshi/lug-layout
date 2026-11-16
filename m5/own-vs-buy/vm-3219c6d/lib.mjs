import { chromium } from "playwright-core";

export async function openEditor({ api = "webgl2", width = 1920, height = 1200 } = {}) {
  const browser = await chromium.launch({
    executablePath: "/usr/local/bin/google-chrome",
    headless: false,
    args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width, height } });
  const logs = [];
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`${m.type()}: ${m.text()}`); });
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(`http://localhost:5173/?api=${api}&state=1`);
  await page.waitForSelector('.editor[data-status="ready"]', { timeout: 180000 });
  return { browser, page, logs };
}

export async function hoverAt(page, px, py) {
  await page.mouse.move(px, py);
  await page.waitForTimeout(30);
  const h = await page.locator(".editor").getAttribute("data-hover");
  if (!h) return null;
  const [x, z] = h.split(",").map(Number);
  return { x, z };
}

export async function canvasBox(page) {
  return page.locator("canvas").first().boundingBox();
}

export async function findScreen(page, tx, tz) {
  const box = await canvasBox(page);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  const a = await hoverAt(page, cx, cy);
  const b = await hoverAt(page, cx + 100, cy);
  const c = await hoverAt(page, cx, cy + 100);
  const m = [[(b.x - a.x) / 100, (c.x - a.x) / 100], [(b.z - a.z) / 100, (c.z - a.z) / 100]];
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  let px = cx + (m[1][1] * (tx - a.x) - m[0][1] * (tz - a.z)) / det;
  let py = cy + (-m[1][0] * (tx - a.x) + m[0][0] * (tz - a.z)) / det;
  for (let i = 0; i < 40; i++) {
    const h = await hoverAt(page, px, py);
    if (!h) throw new Error(`no ground under ${px},${py} for ${tx},${tz}`);
    if (h.x === tx && h.z === tz) return { px, py };
    const dx = tx - h.x, dz = tz - h.z;
    px += (m[1][1] * dx - m[0][1] * dz) / det * 0.9;
    py += (-m[1][0] * dx + m[0][0] * dz) / det * 0.9;
  }
  throw new Error(`could not hover ${tx},${tz}`);
}

export async function place(page, item, x, z, rot = 0) {
  await page.locator(`.catalog-item[data-item="${item}"]`).click();
  for (let r = Number(await page.locator(".editor").getAttribute("data-ghost-rot")); r % 4 !== rot; r++) {
    await page.keyboard.press("r");
  }
  const { px, py } = await findScreen(page, x, z);
  await page.mouse.click(px, py);
  await page.waitForTimeout(150);
}

export async function reports(page) {
  return JSON.parse(await page.locator("#buildable-state").innerText());
}

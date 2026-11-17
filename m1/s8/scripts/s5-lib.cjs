const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function openEditor({ api, base, width, height, videoDir, extraQuery = '' }) {
  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.CHROME_PATH || undefined,
    channel: process.env.CHROME_PATH ? undefined : arg('channel', process.env.CHROME_CHANNEL) || undefined,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--start-maximized'],
  });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: Number(arg('dpr', '1')),
    ...(videoDir ? { recordVideo: { dir: videoDir, size: { width, height } } } : {}),
  });
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/?state=1&api=${api}${extraQuery}`);
  await page.waitForSelector('.editor[data-status="ready"], .editor[data-status="error"]', {
    state: 'attached',
    timeout: 900000,
  });
  if ((await page.getAttribute('.editor', 'data-status')) === 'error') {
    throw new Error(`editor failed: ${await page.textContent('.hud')}`);
  }
  return { browser, context, page, consoleLines };
}

async function hover(page) {
  const value = await page.getAttribute('.editor', 'data-hover');
  if (!value) return null;
  const [x, z] = value.split(',').map(Number);
  return { x, z };
}

async function samples(page) {
  return Number(await page.getAttribute('#edit-state', 'data-samples'));
}

async function state(page) {
  return JSON.parse(await page.textContent('#edit-state'));
}

async function waitSamples(page, count) {
  await page.waitForFunction(
    (n) => Number(document.querySelector('#edit-state').dataset.samples) >= n,
    count,
    { timeout: 900000, polling: 16 },
  );
}

async function hoverAt(page, sx, sy) {
  await page.mouse.move(sx, sy);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))),
  );
  return hover(page);
}

const pointer = { x: 0, y: 0 };

async function searchLattice(page, x, z) {
  const size = page.viewportSize();
  const left = 450;
  const right = size.width - 330;
  const top = 20;
  const bottom = size.height - 100;
  const middleX = (left + right) / 2;
  let sx = pointer.x || middleX;
  let sy = pointer.y || (top + bottom) / 2;
  for (let iteration = 0; iteration < 40; iteration++) {
    const here = await hoverAt(page, sx, sy);
    if (here && here.x === x && here.z === z) {
      pointer.x = sx;
      pointer.y = sy;
      return { sx, sy };
    }
    const step = 24;
    const toRight = await hoverAt(page, sx + step, sy);
    const down = await hoverAt(page, sx, sy + step);
    if (!here || !toRight || !down) {
      sx = middleX;
      sy = Math.min(bottom, sy + 40);
      continue;
    }
    const a = (toRight.x - here.x) / step;
    const b = (down.x - here.x) / step;
    const c = (toRight.z - here.z) / step;
    const d = (down.z - here.z) / step;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) {
      sx += step;
      continue;
    }
    const ex = x - here.x;
    const ez = z - here.z;
    sx += (d * ex - b * ez) / det;
    sy += (-c * ex + a * ez) / det;
    sx = Math.min(Math.max(sx, left), right);
    sy = Math.min(Math.max(sy, top), bottom);
  }
  return null;
}

const SEARCH_ATTEMPTS = 3;

async function moveToLattice(page, x, z) {
  for (let attempt = 0; attempt < SEARCH_ATTEMPTS; attempt++) {
    const found = await searchLattice(page, x, z);
    if (found) return found;
    pointer.x = 0;
    pointer.y = 0;
  }
  throw new Error(`could not put the cursor on lattice point (${x}, ${z}) in ${SEARCH_ATTEMPTS} attempts`);
}

async function chooseItem(page, id) {
  await page.click(`[data-item="${id}"]`);
}

async function setGhostRotation(page, rot) {
  for (let i = 0; i < 4; i++) {
    if (Number(await page.getAttribute('.editor', 'data-ghost-rot')) === rot) return;
    await page.keyboard.press('r');
  }
  throw new Error(`ghost rotation did not reach ${rot}`);
}

async function clickHere(page) {
  await page.mouse.down();
  await page.mouse.up();
}

async function place(page, id, x, z, rot) {
  const before = await samples(page);
  await chooseItem(page, id);
  await setGhostRotation(page, rot);
  await moveToLattice(page, x, z);
  await clickHere(page);
  await waitSamples(page, before + 1);
}

async function selectAt(page, x, z, expected) {
  await page.keyboard.press('Escape');
  await moveToLattice(page, x, z);
  await clickHere(page);
  await page.waitForFunction(
    (id) => document.querySelector('.editor').dataset.selection === id,
    expected,
    { timeout: 60000 },
  );
}

async function keyAction(page, key) {
  const before = await samples(page);
  await page.keyboard.press(key);
  await waitSamples(page, before + 1);
}

async function zoom(page, delta) {
  await page.mouse.wheel(0, delta);
}

async function centreOn(page, x, z) {
  await moveToLattice(page, x, z);
  await page.keyboard.press('c');
}

function outPath(dir, name) {
  return path.join(dir, name);
}

module.exports = {
  arg,
  openEditor,
  hover,
  samples,
  state,
  waitSamples,
  moveToLattice,
  chooseItem,
  setGhostRotation,
  clickHere,
  place,
  selectAt,
  keyAction,
  zoom,
  centreOn,
  outPath,
};

const fs = require('node:fs');
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? 'playwright-core');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

(async () => {
  const base = arg('base', 'http://localhost:4173');
  const query = arg('query', 'scene=city&parts=1000000&camera=aerial&api=webgpu&measure=1&warmup=10&frames=120');
  const out = arg('out', 'viewer-measure');
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.CHROME_PATH || undefined,
    channel: process.env.CHROME_PATH ? undefined : arg('channel', process.env.CHROME_CHANNEL) || undefined,
    args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'],
  });
  const context = await browser.newContext({
    viewport: { width: Number(arg('width', '1800')), height: Number(arg('height', '1000')) },
    deviceScaleFactor: Number(arg('dpr', '1')),
  });
  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`));
  await page.goto(`${base}/?${query}`);
  await page.waitForFunction(() => document.querySelector('#result') || document.querySelector('.hud .error'), null, {
    timeout: 3_600_000,
  });
  const error = await page.$('.hud .error');
  if (error) throw new Error(`viewer failed: ${await error.textContent()}`);
  fs.writeFileSync(`${out}/result.json`, await page.textContent('#result'));
  fs.writeFileSync(`${out}/hud.txt`, await page.innerText('.hud'));
  fs.writeFileSync(`${out}/console.txt`, consoleLines.join('\n'));
  await page.screenshot({ path: `${out}/viewport.png` });
  const result = JSON.parse(await page.textContent('#result'));
  const t = result.timings;
  const measured = new Set(result.rebases.map((e) => e.frame - t.firstMeasuredFrame).filter((i) => i >= 0 && i < t.frames));
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted.length === 0 ? null : sorted[Math.floor(sorted.length / 2)];
  };
  const pick = (array, keep) => array.filter((_, i) => keep(i));
  const summary = {
    activeApi: result.backend.activeApi,
    adapter: result.backend.adapter,
    drawingBuffer: result.drawingBuffer,
    chunks: result.summary.modules,
    rebases: result.rebases.length,
    rebaseLoopMsMedian: median(result.rebases.map((e) => e.ms)),
    rebaseLoopMsMax: Math.max(...result.rebases.map((e) => e.ms)),
    measuredRebaseFrames: measured.size,
    cpuSubmitMsMedianOnRebaseFrames: median(pick(t.cpuSubmitMs, (i) => measured.has(i))),
    cpuSubmitMsMedianOtherFrames: median(pick(t.cpuSubmitMs, (i) => !measured.has(i))),
    frameMsMedianOnRebaseFrames: median(pick(t.frameMs, (i) => measured.has(i))),
    frameMsMedianOtherFrames: median(pick(t.frameMs, (i) => !measured.has(i))),
    medianFrameMs: t.medianFrameMs,
    p95FrameMs: t.p95FrameMs,
  };
  fs.writeFileSync(`${out}/rebase-summary.json`, JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

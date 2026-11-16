const { chromium } = require('/agent/repos/lug-layout/.probe/node_modules/playwright-core');
const fs = require('fs');
const path = require('path');
(async () => {
  const [port, query, seconds, out] = process.argv.slice(2);
  const dir = fs.mkdtempSync('/tmp/vid-');
  const b = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir, size: { width: 1280, height: 720 } } });
  const p = await ctx.newPage();
  await p.goto(`http://localhost:${port}/?${query}`);
  await p.waitForFunction(() => /Frame rate|Measured frames/.test(document.querySelector('.hud')?.textContent ?? '') || document.querySelector('.hud .error'), null, { timeout: 1800000 });
  if (query.includes('measure=1')) {
    await p.waitForFunction(() => document.querySelector('#result') || document.querySelector('.hud .error'), null, { timeout: 3000000 });
    await p.waitForTimeout(1500);
  } else {
    await p.waitForTimeout(Number(seconds) * 1000);
  }
  fs.writeFileSync(out.replace(/\.webm$/, '.hud.txt'), (await p.textContent('.hud')).replace(/\s+/g, ' '));
  const video = p.video();
  await ctx.close();
  fs.renameSync(await video.path(), out);
  await b.close();
})();

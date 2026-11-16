const { chromium } = require('/agent/repos/lug-layout/.probe/node_modules/playwright-core');
const fs = require('fs');
(async () => {
  const [port, query, out] = process.argv.slice(2);
  const b = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--js-flags=--expose-gc', '--enable-precise-memory-info'] });
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto(`http://localhost:${port}/?${query}`);
  await p.waitForFunction(() => document.querySelector('#result') || document.querySelector('.hud .error'), null, { timeout: 3000000 });
  const result = await p.textContent('#result');
  fs.writeFileSync(out + '.json', result);
  const heap = await p.evaluate(() => { globalThis.gc(); globalThis.gc(); return performance.memory.usedJSHeapSize; });
  fs.writeFileSync(out + '.heap.txt', String(heap));
  await p.addStyleTag({ content: '.hud, footer { display: none !important; }' });
  await p.locator('canvas').screenshot({ path: out + '.canvas.png', timeout: 600000 });
  await b.close();
})();

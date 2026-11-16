const { chromium } = require('/agent/repos/lug-layout/.probe/node_modules/playwright-core');
(async () => {
  const b = await chromium.launch({ headless: false, args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist'] });
  const ctx = await b.newContext({ viewport: { width: 1800, height: 1043 }, deviceScaleFactor: 2 });
  await ctx.addInitScript({ path: '/cursor/stores/bc-847a100f-b8f0-4276-ac1a-75c3e7e5c5cd/internal/critic/pr16-0e9e6bb-repro/memory/count-buffers.js' });
  const p = await ctx.newPage();
  await p.goto('http://localhost:4173/?' + process.argv[2]);
  await p.waitForFunction(() => document.querySelector('#result') || document.querySelector('.hud .error'), null, { timeout: 3000000 });
  const result = JSON.parse(await p.textContent('#result'));
  const tally = await p.evaluate(() => globalThis.__bufferTally());
  const mib = (x) => (x / 1048576).toFixed(1);
  console.log(JSON.stringify({ query: process.argv[2], drawingBuffer: result.drawingBuffer, tiers: result.timings.medianChunkTiers,
    app: { vertexIndexMiB: mib(result.memory.vertexIndexBytes), vertexIndexBytes: result.memory.vertexIndexBytes, otherBytes: result.memory.otherBytes },
    criticHook: { vertexIndexMiB: mib((tally.vertex ?? 0) + (tally.index ?? 0)), vertexIndexBytes: (tally.vertex ?? 0) + (tally.index ?? 0), raw: tally } }));
  await p.screenshot({ path: process.argv[3], timeout: 600000 });
  await b.close();
})();

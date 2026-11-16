const fs = require('node:fs');
const lib = require('./s5-lib.cjs');

(async () => {
  const api = lib.arg('api', 'webgpu');
  const base = lib.arg('base', 'http://localhost:4173');
  const out = lib.arg('out', `latency-${api}`);
  const trials = Number(lib.arg('trials', '50'));
  const width = Number(lib.arg('width', '1800'));
  const height = Number(lib.arg('height', '1000'));
  const only = lib.arg('sets', '');
  fs.mkdirSync(out, { recursive: true });
  const { browser, page, consoleLines } = await lib.openEditor({ api, base, width, height });
  const catalog = await page.$$eval('[data-item]', (buttons) => buttons.map((b) => b.dataset.item));
  const sets = catalog.filter((id) => id.startsWith('omr:') && (only === '' || only.split(',').includes(id)));
  await lib.zoom(page, 700);
  await lib.place(page, 'ldraw:3811', 0, 0, 0);
  const started = Date.now();
  for (const id of sets) {
    for (let rot = 0; rot < 4; rot++) {
      for (let k = 0; k < trials; k++) {
        await lib.place(page, id, 0, 0, rot);
        await lib.selectAt(page, 0, 0, id);
        await lib.keyAction(page, 'r');
        await lib.keyAction(page, 'Delete');
      }
      console.log(`${id} rot ${rot}: ${trials} trials, ${Math.round((Date.now() - started) / 1000)} s`);
    }
  }
  const result = await lib.state(page);
  fs.writeFileSync(`${out}/edit-state.json`, JSON.stringify(result));
  fs.writeFileSync(`${out}/hud.txt`, await page.innerText('.hud'));
  fs.writeFileSync(`${out}/console.txt`, consoleLines.join('\n'));
  await page.screenshot({ path: `${out}/final.png` });
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

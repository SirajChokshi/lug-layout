const fs = require('node:fs');
const lib = require('./s5-lib.cjs');

const SPOTS = [
  ['omr:10264-1', -3200, -800, 0],
  ['omr:10185-1', -1600, -800, 1],
  ['omr:10190-1', 0, -800, 2],
  ['omr:10218-1', 1600, -800, 3],
  ['omr:4555-1', 3200, -800, 0],
  ['omr:2150-1', -3200, 800, 1],
  ['omr:4554-1', -1600, 800, 0],
  ['omr:10128-1', 0, 800, 3],
  ['omr:7936-1', 1600, 800, 2],
  ['omr:10133-1', 3200, 800, 1],
];
const ROTATE_THROUGH_ALL = ['omr:10185-1', 'omr:10128-1', 'omr:2150-1'];
const DELETE = 'omr:4554-1';

(async () => {
  const api = lib.arg('api', 'webgpu');
  const base = lib.arg('base', 'http://localhost:4173');
  const out = lib.arg('out', `video-${api}`);
  const width = Number(lib.arg('width', '1800'));
  const height = Number(lib.arg('height', '1000'));
  const pause = Number(lib.arg('pause', '600'));
  fs.mkdirSync(out, { recursive: true });
  const { browser, context, page, consoleLines } = await lib.openEditor({
    api,
    base,
    width,
    height,
    videoDir: out,
  });
  const log = [];
  const note = (text) => {
    log.push(`${new Date().toISOString()} ${text}`);
    console.log(text);
  };
  await page.waitForTimeout(pause);
  await lib.zoom(page, 1350);
  await page.waitForTimeout(pause);
  for (const [, x, z] of SPOTS) {
    await lib.place(page, 'ldraw:3811', x, z, 0);
  }
  note('placed 10 baseplates');
  for (const [id, x, z, rot] of SPOTS) {
    await lib.place(page, id, x, z, rot);
    note(`placed ${id} at (${x}, ${z}) rot ${rot}`);
    await page.waitForTimeout(pause);
  }
  for (const id of ROTATE_THROUGH_ALL) {
    const [, x, z] = SPOTS.find(([spot]) => spot === id);
    await lib.selectAt(page, x, z, id);
    await page.waitForTimeout(pause);
    for (let turn = 0; turn < 4; turn++) {
      await lib.keyAction(page, 'r');
      note(`rotated ${id} (turn ${turn + 1} of 4)`);
      await page.waitForTimeout(pause);
    }
  }
  const [, dx, dz] = SPOTS.find(([spot]) => spot === DELETE);
  await lib.selectAt(page, dx, dz, DELETE);
  await page.waitForTimeout(pause);
  await lib.keyAction(page, 'Delete');
  note(`deleted ${DELETE}`);
  await page.waitForTimeout(pause * 2);
  await page.keyboard.press('Escape');
  await page.mouse.move(width / 2, height / 2);
  await page.mouse.down({ button: 'right' });
  for (let i = 0; i < 30; i++) await page.mouse.move(width / 2 + i * 8, height / 2 + i);
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(pause * 2);
  const result = await lib.state(page);
  fs.writeFileSync(`${out}/edit-state.json`, JSON.stringify(result));
  fs.writeFileSync(`${out}/hud.txt`, await page.innerText('.hud'));
  fs.writeFileSync(`${out}/console.txt`, consoleLines.join('\n'));
  fs.writeFileSync(`${out}/steps.txt`, log.join('\n'));
  await page.screenshot({ path: `${out}/final.png` });
  await context.close();
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

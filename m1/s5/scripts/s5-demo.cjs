const fs = require('node:fs');
const lib = require('./s5-lib.cjs');

async function glide(page, from, to, steps) {
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(from.sx + ((to.sx - from.sx) * i) / steps, from.sy + ((to.sy - from.sy) * i) / steps);
    await page.waitForTimeout(60);
  }
}

(async () => {
  const api = lib.arg('api', 'webgl2');
  const out = lib.arg('out', '/tmp/s5/demo');
  const width = Number(lib.arg('width', '1280'));
  const height = Number(lib.arg('height', '720'));
  fs.mkdirSync(out, { recursive: true });
  const { browser, context, page } = await lib.openEditor({ api, base: 'http://localhost:4173', width, height, videoDir: out });
  const beat = (ms = 700) => page.waitForTimeout(ms);
  await beat(1200);
  await lib.zoom(page, 520);
  await beat();
  for (const [x, z] of [[-320, -320], [320, -320], [-320, 320], [320, 320], [960, -320], [960, 320]]) {
    await lib.place(page, 'ldraw:3811', x, z, 0);
  }
  await beat();
  await lib.chooseItem(page, 'omr:10185-1');
  const a = await lib.moveToLattice(page, -640, 0);
  const b = await lib.moveToLattice(page, -300, -300);
  await glide(page, b, a, 25);
  await beat();
  for (let turn = 0; turn < 4; turn++) {
    await page.keyboard.press('r');
    await beat(600);
  }
  await lib.place(page, 'omr:10185-1', -320, -320, 0);
  await beat();
  await lib.place(page, 'omr:10190-1', 320, -320, 2);
  await beat();
  await lib.place(page, 'omr:7936-1', -320, 320, 0);
  await beat();
  await lib.place(page, 'omr:10133-1', 320, 320, 1);
  await beat();
  await lib.place(page, 'omr:10218-1', 960, 320, 1);
  await beat();
  await lib.selectAt(page, 960, 320, 'omr:10218-1');
  await beat();
  for (let turn = 0; turn < 4; turn++) {
    await lib.keyAction(page, 'r');
    await beat(800);
  }
  await lib.selectAt(page, -320, 320, 'omr:7936-1');
  await beat();
  await lib.keyAction(page, 'Delete');
  await beat(1000);
  await page.keyboard.press('Escape');
  const centre = { sx: width * 0.45, sy: height * 0.5 };
  await page.mouse.move(centre.sx, centre.sy);
  await page.keyboard.down('Shift');
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(centre.sx - i * 6, centre.sy + i * 2);
    await page.waitForTimeout(60);
  }
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await beat();
  await page.mouse.down({ button: 'right' });
  for (let i = 1; i <= 30; i++) {
    await page.mouse.move(centre.sx - 180 + i * 6, centre.sy + 60);
    await page.waitForTimeout(60);
  }
  await page.mouse.up({ button: 'right' });
  await beat(1500);
  const state = await lib.state(page);
  fs.writeFileSync(`${out}/edit-state.json`, JSON.stringify(state));
  fs.writeFileSync(`${out}/hud.txt`, await page.innerText('.hud'));
  await page.screenshot({ path: `${out}/final.png` });
  await context.close();
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

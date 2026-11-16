const fs = require('node:fs');
const lib = require('./s5-lib.cjs');

const SPACING = 1600;
const CLOSE_UP_SET = 'omr:10185-1';
const CLOSE_UP_ZOOM_IN = -3300;

(async () => {
  const api = lib.arg('api', 'webgpu');
  const base = lib.arg('base', 'http://localhost:4173');
  const out = lib.arg('out', `world-${api}`);
  const width = Number(lib.arg('width', '1800'));
  const height = Number(lib.arg('height', '1000'));
  fs.mkdirSync(out, { recursive: true });
  const { browser, page, consoleLines } = await lib.openEditor({ api, base, width, height });
  const catalog = await page.$$eval('[data-item]', (buttons) => buttons.map((b) => b.dataset.item));
  const sets = catalog.filter((id) => id.startsWith('omr:'));
  await lib.zoom(page, 1250);
  const camera = { x: 0, z: 0 };
  const travel = async (x, z) => {
    while (camera.x !== x || camera.z !== z) {
      const stepX = Math.sign(x - camera.x) * Math.min(SPACING, Math.abs(x - camera.x));
      const stepZ = stepX === 0 ? Math.sign(z - camera.z) * Math.min(SPACING, Math.abs(z - camera.z)) : 0;
      camera.x += stepX;
      camera.z += stepZ;
      await lib.centreOn(page, camera.x, camera.z);
    }
  };
  const spots = [];
  sets.forEach((id, column) => {
    for (let k = 0; k < 4; k++) {
      const rot = column % 2 === 0 ? k : 3 - k;
      spots.push([id, column * SPACING, rot * SPACING, rot]);
    }
  });
  for (const [id, x, z, rot] of spots) {
    await travel(x, z);
    await lib.place(page, id, x, z, rot);
    console.log(`placed ${id} rot ${rot} at (${x}, ${z})`);
  }
  const closeUpX = sets.indexOf(CLOSE_UP_SET) * SPACING;
  for (let rot = 0; rot < 4; rot++) {
    const cz = (5 + rot) * SPACING;
    await travel(closeUpX, cz);
    for (const [ox, oz] of [[-320, -320], [320, -320], [-320, 320], [320, 320]]) {
      await lib.place(page, 'ldraw:3811', closeUpX + ox, cz + oz, 0);
    }
    await lib.place(page, CLOSE_UP_SET, closeUpX, cz, rot);
    await lib.selectAt(page, closeUpX, cz, CLOSE_UP_SET);
    const selection = await page.innerText('.inspector');
    fs.writeFileSync(`${out}/closeup-rot${rot}-inspector.txt`, selection);
    const footprint = /Footprint x, z \(LDU\)\s*(-?[\d.]+)…(-?[\d.]+), (-?[\d.]+)…(-?[\d.]+)/u.exec(selection);
    if (!footprint) throw new Error(`no footprint in the inspector: ${selection}`);
    const cornerX = Math.round(Number(footprint[2]) / 20) * 20;
    const cornerZ = Math.round(Number(footprint[4]) / 20) * 20;
    await page.keyboard.press('Escape');
    await lib.centreOn(page, cornerX, cornerZ);
    await lib.zoom(page, CLOSE_UP_ZOOM_IN);
    await page.waitForTimeout(Number(lib.arg('settle', '2500')));
    await page.addStyleTag({ content: '.hud, .side-panel, footer { visibility: hidden !important; }' });
    await page.screenshot({ path: `${out}/closeup-${CLOSE_UP_SET.replace('omr:', '')}-rot${rot}.png` });
    await page.addStyleTag({ content: '.hud, .side-panel, footer { visibility: visible !important; }' });
    await lib.zoom(page, -CLOSE_UP_ZOOM_IN);
    await lib.centreOn(page, closeUpX, cz);
    await page.waitForTimeout(500);
    console.log(`close-up rot ${rot} at corner (${cornerX}, ${cornerZ})`);
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

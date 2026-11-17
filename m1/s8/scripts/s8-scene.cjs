const fs = require("node:fs");
const lib = require("./s5-lib.cjs");

const SPACING = 1600;
const COLUMNS = 5;
const AERIAL_ZOOM_OUT = 2600;
const STREET_ZOOM_IN = -2400;
const SETTLE_MS = Number(lib.arg("settle", "6000"));

(async () => {
  const api = lib.arg("api", "webgl2");
  const base = lib.arg("base", "http://localhost:4173");
  const out = lib.arg("out", "scene");
  const look = lib.arg("look", "");
  const width = Number(lib.arg("width", "1920"));
  const height = Number(lib.arg("height", "1080"));
  fs.mkdirSync(out, { recursive: true });
  const { browser, page, consoleLines } = await lib.openEditor({
    api,
    base,
    width,
    height,
    extraQuery: look ? `&look=${look}` : "",
  });
  const catalog = await page.$$eval("[data-item]", (buttons) => buttons.map((b) => b.dataset.item));
  const sets = catalog.filter((id) => id.startsWith("omr:"));
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
  for (let i = 0; i < sets.length; i++) {
    const x = (i % COLUMNS) * SPACING;
    const z = Math.floor(i / COLUMNS) * SPACING;
    await travel(x, z);
    await lib.place(page, "ldraw:3811", x, z, 0);
    await lib.place(page, sets[i], x, z, 0);
    console.log(`placed ${sets[i]} at (${x}, ${z})`);
  }
  await page.keyboard.press("Escape");
  await travel(2 * SPACING, 0);
  await travel(2 * SPACING, SPACING);
  const hide = ".hud, .side-panel, footer { visibility: hidden !important; }";
  const show = ".hud, .side-panel, footer { visibility: visible !important; }";
  const shoot = async (name) => {
    await page.mouse.move(2, 2);
    await page.waitForTimeout(SETTLE_MS);
    await page.addStyleTag({ content: hide });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/${name}.png` });
    await page.addStyleTag({ content: show });
    fs.writeFileSync(`${out}/${name}-hud.txt`, await page.innerText(".hud"));
  };
  await lib.zoom(page, AERIAL_ZOOM_OUT);
  await shoot("aerial");
  await lib.zoom(page, -AERIAL_ZOOM_OUT);
  await travel(2 * SPACING, 0);
  await lib.zoom(page, STREET_ZOOM_IN);
  await shoot("street");
  fs.writeFileSync(`${out}/edit-state.json`, JSON.stringify(await lib.state(page)));
  fs.writeFileSync(`${out}/console.txt`, consoleLines.join("\n"));
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

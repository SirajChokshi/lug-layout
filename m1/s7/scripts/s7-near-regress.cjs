const lib = require("./s5-lib.cjs");
(async () => {
  const base = lib.arg("base", "http://localhost:4173");
  const extra = lib.arg("extra", "");
  const out = lib.arg("out", "near.png");
  const { browser, page } = await lib.openEditor({ api: "webgl2", base, width: 1800, height: 1000, extraQuery: extra });
  await lib.place(page, "ldraw:3811@2", 0, 0, 0);
  await lib.place(page, "omr:10264-1", 0, 0, 1);
  await lib.place(page, "ldraw:3811@2", 800, 0, 0);
  await lib.place(page, "omr:10218-1", 800, 0, 3);
  await page.keyboard.press("Escape");
  await page.mouse.move(5, 5);
  await page.waitForTimeout(4000);
  await page.addStyleTag({ content: ".hud, .side-panel, footer { visibility: hidden !important; }" });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: out, timeout: 0 });
  console.log(JSON.stringify((await lib.state(page)).world.placements));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

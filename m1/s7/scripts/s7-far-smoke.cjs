const lib = require("./s5-lib.cjs");
(async () => {
  const { browser, page, consoleLines } = await lib.openEditor({ api: "webgl2", base: "http://localhost:4173", width: 1800, height: 1000 });
  await lib.place(page, "ldraw:3811@2", 0, 0, 0);
  await lib.place(page, "omr:10264-1", 0, 0, 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "smoke-auto.png" });
  for (const t of ["near", "mid", "far"]) { await page.keyboard.press("l"); await page.waitForTimeout(2500); await page.screenshot({ path: `smoke-${t}.png` }); }
  console.log(await page.innerText(".hud"));
  console.log(consoleLines.filter((l) => !l.startsWith("debug")).slice(0, 10).join("\n"));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });

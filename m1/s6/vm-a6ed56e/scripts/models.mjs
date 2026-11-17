import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const base = process.env.BASE ?? "http://127.0.0.1:5173";
const out = process.env.OUT ?? "/tmp/pw/models-after";
const api = process.env.API ?? "webgl2";
const sets = (
  process.env.SETS ?? "7936-1,10264-1,10185-1,10190-1,10218-1,2150-1,4554-1,4555-1,10128-1,10133-1"
).split(",");
const frameCounts = (process.env.FRAMES ?? "1,2,3,4").split(",").map(Number);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/local/bin/google-chrome",
  headless: false,
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
});
const rows = [];
for (const set of sets) {
  for (const frames of frameCounts) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const url = `${base}/?model=${set}&api=${api}&measure=1&warmup=1&frames=${frames}${process.env.VIEW ? `&view=${process.env.VIEW}` : ""}`;
    await page.goto(url);
    await page.waitForFunction(
      () => document.querySelector("#result[data-done], .hud .error"),
      null,
      { timeout: 600000, polling: 500 },
    );
    const error = await page.locator(".hud .error").count();
    const result = error ? null : JSON.parse(await page.locator("#result").innerText());
    await page.addStyleTag({ content: ".hud, footer { visibility: hidden !important; }" });
    await page.waitForTimeout(500);
    const name = `${set}-t${frames}`;
    await page.locator("canvas").first().screenshot({ path: `${out}/${name}.png` });
    const row = {
      set,
      frames,
      cameraT: (frames - 1) / frames,
      url,
      error: Boolean(error),
      studInstances: result?.summary.studInstances,
      visibleStudInstances: result?.summary.visibleStudInstances,
      studTriangles: result?.summary.studTriangles,
      drawnTriangles: result?.drawnTriangles,
      drawCalls: result?.drawCalls,
      drawingBuffer: result?.drawingBuffer,
      medianFrameMs: result?.timings.medianFrameMs,
    };
    rows.push(row);
    console.log(JSON.stringify(row));
    await page.close();
  }
}
await browser.close();
writeFileSync(`${out}/runs.json`, JSON.stringify(rows, null, 2));

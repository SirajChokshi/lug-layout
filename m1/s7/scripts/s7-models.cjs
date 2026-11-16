const fs = require("node:fs");
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
const lib = require("./s5-lib.cjs");

const SETS = [
  "7936-1",
  "10264-1",
  "10185-1",
  "10190-1",
  "10218-1",
  "2150-1",
  "4554-1",
  "4555-1",
  "10128-1",
  "10133-1",
];
const TIERS = ["near", "mid", "far"];

(async () => {
  const api = lib.arg("api", "webgpu");
  const base = lib.arg("base", "http://localhost:4173");
  const out = lib.arg("out", `s7-models-${api}`);
  const width = Number(lib.arg("width", "1280"));
  const height = Number(lib.arg("height", "800"));
  const distance = lib.arg("distance", "");
  const warmup = lib.arg("warmup", "5");
  const frames = lib.arg("frames", "60");
  const sets = lib.arg("sets", SETS.join(",")).split(",");
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.CHROME_PATH || undefined,
    channel: process.env.CHROME_PATH ? undefined : lib.arg("channel", process.env.CHROME_CHANNEL) || undefined,
    args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
  });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: Number(lib.arg("dpr", "1")),
  });
  const rows = [];
  for (const set of sets) {
    for (const tier of TIERS) {
      const page = await context.newPage();
      const logs = [];
      page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
      page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
      const url = `${base}/?model=${set}&api=${api}&tier=${tier}${distance ? `&distance=${distance}` : ""}&measure=1&warmup=${warmup}&frames=${frames}`;
      await page.goto(url);
      await page.waitForFunction(() => document.querySelector("#result[data-done], .hud .error"), null, {
        timeout: 3_600_000,
        polling: 500,
      });
      if (await page.locator(".hud .error").count()) {
        throw new Error(`${url}: ${await page.locator(".hud .error").innerText()}`);
      }
      const result = JSON.parse(await page.locator("#result").innerText());
      const hud = await page.locator(".hud").innerText();
      await page.screenshot({ path: `${out}/${set}-${tier}.png` });
      fs.writeFileSync(`${out}/${set}-${tier}.json`, JSON.stringify({ url, hud, result, logs }, null, 2));
      const row = {
        set,
        tier,
        parts: result.summary.parts,
        voxels: result.summary.farModel?.voxels ?? null,
        farMeshTriangles: result.summary.farModel?.triangles ?? null,
        drawCalls: result.drawCalls,
        drawnTriangles: result.drawnTriangles,
        medianFrameMs: result.timings.medianFrameMs,
        p95FrameMs: result.timings.p95FrameMs,
        drawingBuffer: result.drawingBuffer,
        adapter: result.backend.adapter,
        activeApi: result.backend.activeApi,
      };
      rows.push(row);
      console.log(JSON.stringify(row));
      await page.close();
    }
  }
  fs.writeFileSync(`${out}/models.json`, JSON.stringify(rows, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

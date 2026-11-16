import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync } from "node:fs";

const sets = process.argv.slice(2);
const apis = (process.env.APIS ?? "webgl2,webgpu").split(",");
const out = process.env.OUT ?? "/tmp/shots/out";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/local/bin/google-chrome",
  headless: false,
  args: (process.env.CHROME_ARGS ?? "--enable-unsafe-webgpu").split(" "),
});
const rows = [];
for (const set of sets) {
  for (const api of apis) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const logs = [];
    page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    const url = `http://localhost:4173/?model=${set}&api=${api}&measure=1&warmup=2&frames=5`;
    await page.goto(url);
    await page.waitForFunction(() => document.querySelector("#result[data-done], .hud .error"), null, {
      timeout: 600000,
      polling: 500,
    });
    const error = await page.locator(".hud .error").count();
    const hud = (await page.locator(".hud").innerText()).replace(/\n/g, " | ");
    const result = error ? null : JSON.parse(await page.locator("#result").innerText());
    await page.screenshot({ path: `${out}/${set}-${api}.png` });
    writeFileSync(`${out}/${set}-${api}.json`, JSON.stringify({ url, hud, result, logs }, null, 2));
    rows.push({ set, api, error: Boolean(error), hud });
    console.log(set, api, error ? "ERROR" : "ok", hud.slice(0, 400));
    await page.close();
  }
}
await browser.close();
writeFileSync(`${out}/summary-${Date.now()}.json`, JSON.stringify(rows, null, 2));

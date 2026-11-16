import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync } from "node:fs";
const out = process.env.OUT ?? "/tmp/ev/out";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: false,
  args: ["--enable-unsafe-webgpu"],
});
for (const query of process.argv.slice(2)) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const logs = [];
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  const base = process.env.BASE ?? "http://localhost:4173";
  const url = `${base}/?${query}&measure=1&warmup=${process.env.WARMUP ?? 2}&frames=${process.env.FRAMES ?? 3}`;
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#result[data-done], .hud .error"), null, { timeout: 600000, polling: 500 });
  const error = await page.locator(".hud .error").count();
  const hud = (await page.locator(".hud").innerText()).replace(/\n/g, " | ");
  const name = query.replace(/[&=,]/g, "_");
  await page.screenshot({ path: `${out}/${name}.png` });
  await page.addStyleTag({ content: ".hud, footer { visibility: hidden !important; }" });
  await page.screenshot({ path: `${out}/${name}.scene.png` });
  writeFileSync(`${out}/${name}.json`, JSON.stringify({ url, hud, result: error ? null : JSON.parse(await page.locator("#result").innerText()), logs }, null, 2));
  console.log(query, error ? "ERROR" : "ok", hud);
  await page.close();
}
await browser.close();

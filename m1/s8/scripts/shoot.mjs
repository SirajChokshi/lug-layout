import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync } from "node:fs";

const [out, ...specs] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/local/bin/google-chrome",
  headless: false,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--js-flags=--expose-gc", "--enable-precise-memory-info"],
});
const width = Number(process.env.VW ?? 1920);
const height = Number(process.env.VH ?? 1080);
for (const spec of specs) {
  const name = spec.slice(0, spec.indexOf("="));
  const url = spec.slice(spec.indexOf("=") + 1);
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  const logs = [];
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector("#result[data-done], .hud .error"), null, {
    timeout: 3_600_000,
    polling: 1000,
  });
  const result = await page.locator("#result").textContent({ timeout: 1000 }).catch(() => "");
  const error = await page.locator(".hud .error").textContent({ timeout: 500 }).catch(() => "");
  const hud = await page.locator(".hud").innerText();
  await page.addStyleTag({ content: ".hud, footer { display: none !important; }" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/${name}.png` });
  writeFileSync(
    `${out}/${name}.json`,
    JSON.stringify({ url, error, hud, logs, result: result ? JSON.parse(result) : null }, null, 1),
  );
  console.log(name, error ? `ERROR ${error}` : result ? "ok" : "NO RESULT", logs.filter((l) => !l.startsWith("debug")).slice(0, 5).join(" | "));
  await page.close();
}
await browser.close();

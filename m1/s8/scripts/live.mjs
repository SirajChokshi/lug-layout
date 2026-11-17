import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync } from "node:fs";
const [out, wait, ...specs] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: "/usr/local/bin/google-chrome", headless: false });
for (const spec of specs) {
  const name = spec.slice(0, spec.indexOf("=")), url = spec.slice(spec.indexOf("=") + 1);
  const page = await browser.newPage({ viewport: { width: Number(process.env.VW ?? 1280), height: Number(process.env.VH ?? 800) } });
  const logs = [];
  page.on("console", (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector(".hud dd, .hud .error"), null, { timeout: 600000 });
  await page.waitForTimeout(Number(wait) * 1000);
  const hud = await page.locator(".hud").innerText();
  await page.addStyleTag({ content: ".hud, footer { display: none !important; }" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${out}/${name}.png` });
  writeFileSync(`${out}/${name}.json`, JSON.stringify({ url, hud, logs }, null, 1));
  console.log(name, logs.filter((l) => l.includes("error")).slice(0, 3).join(" | "));
  await page.close();
}
await browser.close();

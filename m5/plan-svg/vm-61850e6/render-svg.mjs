import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "playwright-core";
const [svgPath, out, pages] = process.argv.slice(2);
const svg = readFileSync(svgPath, "utf8");
const browser = await chromium.launch({ executablePath: "/usr/local/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1587, height: 1123 } });
for (const n of pages.split(",").map(Number)) {
  const one = svg.replace(/width="420mm" height="\d+mm" viewBox="0 0 420 \d+"/u, `width="420mm" height="297mm" viewBox="0 ${(n - 1) * 297} 420 297"`);
  const file = `/tmp/pw/page-${n}.svg`;
  writeFileSync(file, one);
  await page.goto(`file://${file}`);
  await page.screenshot({ path: `${out}/svg-page-${n}.png` });
}
await browser.close();

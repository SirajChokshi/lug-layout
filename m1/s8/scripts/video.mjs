import { chromium } from "playwright-core";
import { mkdirSync, renameSync } from "node:fs";

const [out, seconds, ...specs] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/local/bin/google-chrome",
  headless: false,
});
const size = { width: Number(process.env.VW ?? 960), height: Number(process.env.VH ?? 540) };
for (const spec of specs) {
  const name = spec.slice(0, spec.indexOf("="));
  const url = spec.slice(spec.indexOf("=") + 1);
  const context = await browser.newContext({ viewport: size, recordVideo: { dir: out, size } });
  const page = await context.newPage();
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector(".hud dd"), null, { timeout: 600000 });
  await page.waitForTimeout(Number(seconds) * 1000);
  const hud = await page.locator(".hud").innerText();
  const video = page.video();
  await context.close();
  renameSync(await video.path(), `${out}/${name}.webm`);
  console.log(name, hud.split("\n").filter((l, i, a) => a[i - 1] === "Look" || a[i - 1] === "Frame rate (rAF)").join(" | "));
}
await browser.close();

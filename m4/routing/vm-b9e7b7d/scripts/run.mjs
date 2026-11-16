import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const [, , outDir, name, url, seconds, sampleSeconds] = process.argv;
const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: false,
  args: ["--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
const context = await browser.newContext({
  viewport: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 800) },
  ...(process.env.VIDEO ? { recordVideo: { dir: outDir, size: { width: Number(process.env.W ?? 1280), height: Number(process.env.H ?? 800) } } } : {}),
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForFunction(() => document.querySelector("#sim") || document.querySelector(".error"), null, { timeout: 300000 });
const samples = [];
const end = Date.now() + Number(seconds) * 1000;
while (Date.now() < end) {
  await page.waitForTimeout(Number(sampleSeconds) * 1000);
  const error = await page.$(".error");
  if (error) { samples.push({ error: await error.innerText() }); break; }
  const sim = await page.$eval("#sim", (el) => el.textContent);
  samples.push(JSON.parse(sim));
  const s = samples.at(-1);
  console.log(s.tick, JSON.stringify(s.routeStates), JSON.stringify(s.arrivals), s.sharedPieceTicks, s.checkedTicks, Math.round(s.minBogieSeparationLdu));
}
await page.screenshot({ path: `${outDir}/${name}.png` });
writeFileSync(`${outDir}/${name}.hud.txt`, await page.$eval(".hud", (el) => el.innerText));
writeFileSync(`${outDir}/${name}.samples.json`, JSON.stringify({ url, errors, samples }, null, 1));
const video = page.video();
await context.close();
if (video) console.log("video", await video.path());
await browser.close();

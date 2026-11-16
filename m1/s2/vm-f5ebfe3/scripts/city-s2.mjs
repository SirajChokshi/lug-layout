import { chromium } from "playwright-core";
const browser = await chromium.launch({ executablePath: process.env.CHROME, headless: false, args: ["--enable-unsafe-webgpu","--ignore-gpu-blocklist"] });
for (const port of [4174, 4173]) for (let run = 0; run < 3; run++) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`http://localhost:${port}/?scene=city&parts=20000&api=webgl2&measure=1&warmup=1&frames=2`);
  await page.waitForFunction(() => document.querySelector("#result[data-done], .hud .error"), null, { timeout: 600000, polling: 500 });
  const hud = (await page.locator(".hud").innerText()).replace(/\n/g, " | ");
  const pick = (k) => (hud.match(new RegExp(k.replace(/[()]/g, "\\$&") + " \\| ([^|]+)")) ?? [])[1]?.trim();
  console.log(port === 4174 ? "main" : "S2  ", run, ["Parts","Stud instances (drawn of total)","Scene triangles","Draw calls (median)","Load"].map(pick).join(" ; "));
  await page.close();
}
await browser.close();

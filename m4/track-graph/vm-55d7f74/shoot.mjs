import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const [, , outDir, base, ...cases] = process.argv;
const browser = await chromium.launch({
  executablePath: "/usr/local/bin/google-chrome",
  headless: false,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--use-angle=swiftshader", "--ignore-gpu-blocklist"],
});
for (const entry of cases) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const [name, query] = entry.split("=", 2).length === 2 ? [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)] : [entry, ""];
  await page.goto(`${base}/?${query}`);
  if (query.includes("measure=1")) await page.waitForSelector("#result[data-done='1'], .error", { timeout: 300000 });
  else await page.waitForFunction(() => document.querySelector(".hud")?.textContent?.includes("Frame rate") || document.querySelector(".error"), null, { timeout: 300000 });
  await page.waitForTimeout(Number(process.env.SETTLE_MS ?? 1500));
  const error = await page.$(".error");
  const hud = await page.$eval(".hud", (el) => el.innerText);
  const result = error ? null : await page.$eval("#result", (el) => el.textContent).catch(() => null);
  await page.screenshot({ path: `${outDir}/${name}.png` });
  writeFileSync(`${outDir}/${name}.hud.txt`, hud);
  if (result) writeFileSync(`${outDir}/${name}.result.json`, result);
  console.log(name, error ? "ERROR " + (await error.innerText()) : "ok");
  await page.close();
}
await browser.close();

import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.length ? v.join("=") : "1"];
  }),
);
const base = args.url ?? "http://127.0.0.1:4173/";
const out = args.out ?? "results/pointer";
const throttle = Number(args.throttle ?? 1);
const moves = Number(args.moves ?? 300);
const api = args.api ?? "webgpu";
const items = (args.items ?? "generated:mils-plain,omr:10264-1").split(",");
const chrome =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  executablePath: chrome,
  headless: false,
  args: ["--headless=new", "--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
});
const rows = [];
for (const item of items) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}?api=${api}`);
  await page.waitForSelector(".editor[data-status=ready]", { timeout: 300000, state: "attached" });
  if (throttle > 1) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  }
  await page.locator(`[data-item="${item}"]`).click();
  await page.waitForTimeout(500);
  const samples = await page.evaluate(async (count) => {
    const canvas = document.querySelector("canvas.scene");
    const rect = canvas.getBoundingClientRect();
    const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
    const result = [];
    for (let i = 0; i < count; i++) {
      const x = rect.left + rect.width * (0.3 + (0.4 * i) / count);
      const y = rect.top + rect.height * (0.45 + 0.1 * Math.sin(i / 10));
      const start = performance.now();
      canvas.dispatchEvent(
        new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true, pointerId: 1 }),
      );
      await null;
      await null;
      result.push(performance.now() - start);
      await frame();
    }
    return result;
  }, moves);
  const sorted = samples.toSorted((a, b) => a - b);
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
  const row = {
    item,
    api,
    throttle,
    moves: samples.length,
    medianMs: at(0.5),
    p95Ms: at(0.95),
    maxMs: sorted.at(-1),
    hover: await page.locator(".editor").getAttribute("data-hover"),
    errors,
  };
  rows.push(row);
  console.log(JSON.stringify(row));
  await page.screenshot({ path: join(out, `${item.replace(/[^a-z0-9-]/gi, "_")}.png`) });
  writeFileSync(join(out, `${item.replace(/[^a-z0-9-]/gi, "_")}.json`), JSON.stringify({ row, samples }));
  await page.close();
}
await browser.close();
writeFileSync(join(out, "summary.json"), JSON.stringify({ base, throttle, moves, rows }, null, 1));

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
const label = args.label ?? "run";
const out = args.out ?? join("results", label);
const width = Number(args.width ?? 1600);
const height = Number(args.height ?? 1000);
const dpr = Number(args.dpr ?? 2);
const frames = Number(args.frames ?? 120);
const warmup = Number(args.warmup ?? 10);
const apis = (args.apis ?? "webgpu,webgl2").split(",");
const cameras = (args.cameras ?? "aerial,street").split(",");
const repeats = Number(args.repeats ?? 3);
const extra = args.extra ?? "";
const throttle = Number(args.throttle ?? 1);
const chrome =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  executablePath: chrome,
  headless: false,
  args: [
    "--headless=new",
    "--enable-unsafe-webgpu",
    "--ignore-gpu-blocklist",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
  ],
});
const rows = [];
for (const api of apis) {
  for (const camera of cameras) {
    for (let r = 0; r < repeats; r++) {
      const page = await browser.newPage({
        viewport: { width, height },
        deviceScaleFactor: dpr,
      });
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      if (throttle > 1) {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
      }
      const url = `${base}?scene=layout&api=${api}&camera=${camera}&measure=1&warmup=${warmup}&frames=${frames}${extra}`;
      await page.goto(url);
      await page.waitForSelector("#result[data-done='1'], .hud .error", {
        timeout: 600000,
        state: "attached",
      });
      const error = await page.$(".hud .error");
      const name = `${api}-${camera}-${r + 1}`;
      if (error) {
        const text = await error.innerText();
        rows.push({ name, url, error: text, pageErrors: errors });
        console.log(name, "ERROR", text);
      } else {
        const result = JSON.parse(await page.locator("#result").innerText());
        writeFileSync(join(out, `${name}.json`), JSON.stringify(result, null, 1));
        const t = result.timings;
        const row = {
          name,
          url,
          api: result.backend.activeApi,
          adapter: result.backend.adapter,
          buffer: `${result.drawingBuffer.width}x${result.drawingBuffer.height}`,
          medianMs: t.medianFrameMs,
          p95Ms: t.p95FrameMs,
          cpuSubmitMs: t.medianCpuSubmitMs,
          draws: t.medianDrawCalls,
          triangles: t.medianDrawnTriangles,
          tiers: t.medianChunkTiers,
          studsDrawnOfTotal: [result.summary.visibleStudInstances, result.summary.studInstances],
          sceneTriangles: result.summary.bodyTriangles + result.summary.studTriangles,
          parts: result.summary.parts,
          memory: result.memory,
          loadMs: result.loadMs,
          throttle,
        };
        rows.push(row);
        console.log(JSON.stringify(row));
      }
      if (r === 0) await page.screenshot({ path: join(out, `${api}-${camera}.png`) });
      await page.close();
    }
  }
}
await browser.close();
writeFileSync(join(out, "summary.json"), JSON.stringify({ label, base, width, height, dpr, frames, warmup, throttle, extra, rows }, null, 1));

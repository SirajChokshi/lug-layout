import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";

const { values } = parseArgs({
  options: {
    base: { type: "string", default: "http://localhost:4173" },
    out: { type: "string", default: "bench-results" },
    parts: { type: "string", default: "100000,250000,1000000" },
    apis: { type: "string", default: "webgpu,webgl2" },
    strategies: { type: "string", default: "instanced" },
    lods: { type: "string", default: "standard" },
    cameras: { type: "string", default: "aerial" },
    width: { type: "string", default: "1920" },
    height: { type: "string", default: "1080" },
    warmup: { type: "string", default: "3" },
    frames: { type: "string", default: "30" },
    maxMs: { type: "string", default: "120000" },
    headless: { type: "boolean", default: false },
    channel: { type: "string" },
  },
});

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

const CASE_TIMEOUT_MS = 30 * 60 * 1000;
const width = Number(values.width);
const height = Number(values.height);

const browser = await chromium.launch({
  headless: values.headless,
  ...(values.channel ? { channel: values.channel } : {}),
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist", "--enable-precise-memory-info"],
});
await mkdir(values.out, { recursive: true });

const machine = {
  os: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model ?? "unknown",
  logicalCores: cpus().length,
  totalMemoryGiB: Math.round(totalmem() / 2 ** 30),
  browser: `${browser.browserType().name()} ${browser.version()}`,
  viewport: `${width}x${height}`,
};
process.stdout.write(`${JSON.stringify(machine)}\n`);

const results: unknown[] = [];
for (const parts of list(values.parts)) {
  for (const api of list(values.apis)) {
    for (const strategy of list(values.strategies)) {
      for (const lod of list(values.lods)) {
        for (const camera of list(values.cameras)) {
          const name = `${api}-${strategy}-${lod}-${camera}-${parts}`;
          const query = new URLSearchParams({
            measure: "1",
            parts,
            api,
            strategy,
            lod,
            camera,
            warmup: values.warmup,
            frames: values.frames,
            maxMs: values.maxMs,
          });
          const page = await browser.newPage({ viewport: { width, height } });
          const errors: string[] = [];
          page.on("pageerror", (error) => errors.push(String(error)));
          try {
            await page.goto(`${values.base}/bench.html?${query}`);
            await page.waitForSelector('body[data-bench-done="1"]', { timeout: CASE_TIMEOUT_MS });
            const result: unknown = JSON.parse((await page.textContent("#result")) ?? "null");
            await page.screenshot({ path: join(values.out, `${name}.png`) });
            results.push({ name, result, errors });
            process.stdout.write(`${name}: ${JSON.stringify(result)}\n`);
          } catch (error) {
            results.push({ name, result: null, errors: [...errors, String(error)] });
            process.stdout.write(`${name}: FAILED ${String(error)}\n`);
          } finally {
            await page.close();
          }
          await writeFile(
            join(values.out, "results.json"),
            `${JSON.stringify({ machine, results }, null, 2)}\n`,
          );
        }
      }
    }
  }
}
await browser.close();

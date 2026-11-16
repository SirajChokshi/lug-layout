import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";

const out = process.env.OUT ?? "/tmp/shots/net";
mkdirSync(out, { recursive: true });
const targets = JSON.parse(process.env.TARGETS);
const queries = [
  ["model-10264-1", "?model=10264-1&api=webgl2&measure=1&warmup=1&frames=2"],
  ["model-7936-1", "?model=7936-1&api=webgl2&measure=1&warmup=1&frames=2"],
  ["city-20k", "?scene=city&parts=20000&api=webgl2&measure=1&warmup=1&frames=2"],
];
const browser = await chromium.launch({
  executablePath: process.env.CHROME,
  headless: false,
  args: ["--enable-unsafe-webgpu", "--ignore-gpu-blocklist"],
});

async function visit(page, url) {
  await page.waitForFunction(() => document.querySelector("#result[data-done], .hud .error"), null, {
    timeout: 600000,
    polling: 250,
  });
  const hud = (await page.locator(".hud").innerText()).replace(/\n/g, " | ");
  const entries = await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .filter((e) => e.name.includes("/bundle/"))
      .map((e) => ({
        name: new URL(e.name).pathname,
        transferSize: e.transferSize,
        encodedBodySize: e.encodedBodySize,
        status: e.responseStatus,
      })),
  );
  const pick = (k) => (hud.match(new RegExp(k + " \\| ([^|]+)")) ?? [])[1]?.trim();
  return {
    url,
    load: pick("Load"),
    parts: pick("Parts"),
    bundle: pick("Bundle") ?? null,
    requests: entries.length,
    transferBytes: entries.reduce((a, e) => a + e.transferSize, 0),
    bodyBytes: entries.reduce((a, e) => a + e.encodedBodySize, 0),
    fromCache: entries.filter((e) => e.transferSize === 0).length,
    revalidated: entries.filter((e) => e.transferSize > 0 && e.transferSize < 1000 && e.encodedBodySize > 1000).length,
    entries,
  };
}

const rows = [];
for (const [label, base] of targets) {
  for (const [name, query] of queries) {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      recordHar: { path: `${out}/${label}-${name}.har`, content: "omit" },
    });
    const page = await context.newPage();
    await page.addInitScript(() => performance.setResourceTimingBufferSize(1_000_000));
    const url = base + query;
    await page.goto(url);
    const cold = await visit(page, url);
    await page.reload();
    const warm = await visit(page, url);
    await context.close();
    rows.push({ label, name, cold, warm });
    const fmt = (r) =>
      `${r.requests} req, ${(r.transferBytes / 1e6).toFixed(2)} MB transferred (${(r.bodyBytes / 1e6).toFixed(2)} MB body), ${r.fromCache} from cache, ${r.revalidated} revalidated, load ${r.load}`;
    console.log(`${label} ${name} parts=${cold.parts} bundle=${cold.bundle}\n  cold: ${fmt(cold)}\n  warm: ${fmt(warm)}`);
  }
}
writeFileSync(`${out}/network-${Date.now()}.json`, JSON.stringify(rows, null, 2));
await browser.close();

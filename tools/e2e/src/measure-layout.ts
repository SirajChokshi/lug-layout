import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, extname, join, normalize, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type CDPSession, type Page } from "playwright-core";

const DEFAULT_CHROME = "/usr/local/bin/google-chrome";
const VIEWPORT = { width: 1600, height: 900 } as const;
const READY_TIMEOUT_MS = 900_000;
const POLL_MS = 500;
const GC_PASSES = 3;
const MB = 1e6;
const IMPORT_INPUT = 'input[aria-label="Import a .brr.zip world"]';
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".glb": "model/gltf-binary",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".webp": "image/webp",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
const TIERS_IN_KEY_ORDER: ReadonlyArray<string> = ["far", "near", "mid"];
const CHUNK_TIER_COLUMNS: ReadonlyArray<string> = ["near", "mid", "far"];

const { values } = parseArgs({
  options: {
    app: { type: "string", default: "apps/web/dist" },
    worlds: { type: "string" },
    port: { type: "string", default: "4190" },
    out: { type: "string" },
    chrome: { type: "string" },
    "settle-ms": { type: "string", default: "5000" },
  },
});

interface Measurement {
  readonly world: string;
  readonly tier: string;
  readonly placements: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly chunkTiers: string;
  readonly studsDrawn: string;
  readonly heapUsedBytes: number;
  readonly backingStorageBytes: number;
  readonly screenshot: string;
}

function serve(root: string, port: number): Promise<Server> {
  const server = createServer((request, response) => {
    const urlPath = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    let path = normalize(join(root, urlPath));
    if (!path.startsWith(root)) {
      response.writeHead(403).end();
      return;
    }
    try {
      if (statSync(path).isDirectory()) path = join(path, "index.html");
      const body = readFileSync(path);
      response.writeHead(200, {
        "content-type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
      });
      response.end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  return new Promise((done) => server.listen(port, "127.0.0.1", () => done(server)));
}

type HudReading = Readonly<Record<string, string>>;

async function readHud(page: Page): Promise<HudReading> {
  return page.evaluate(() => {
    const rows: Record<string, string> = {};
    for (const row of document.querySelectorAll(".editor-hud dl > div")) {
      const label = row.querySelector("dt")?.textContent;
      if (label) rows[label] = row.querySelector("dd")?.textContent ?? "";
    }
    return rows;
  });
}

function count(text: string | undefined): number {
  return Number((text ?? "").replaceAll(",", ""));
}

function everyChunkAt(reading: HudReading, tier: string): boolean {
  const chunks = (reading["Chunk tiers near/mid/far"] ?? "").split(" / ").map(count);
  const total = chunks.reduce((sum, n) => sum + n, 0);
  return total > 0 && chunks[CHUNK_TIER_COLUMNS.indexOf(tier)] === total;
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > READY_TIMEOUT_MS) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

async function meshesSettled(page: Page): Promise<boolean> {
  const editor = page.locator(".editor");
  return (
    (await editor.getAttribute("data-far-tier")) === "ready" &&
    (await editor.getAttribute("data-meshes")) === "settled"
  );
}

async function settleAt(page: Page, tier: string, settleMs: number): Promise<HudReading> {
  let previousCallsAndTriangles = "";
  let reading: HudReading = {};
  await until(async () => {
    await page.waitForTimeout(settleMs);
    reading = await readHud(page);
    const callsAndTriangles = `${reading["Draw calls"]} ${reading["Drawn triangles"]}`;
    const settled =
      callsAndTriangles === previousCallsAndTriangles &&
      everyChunkAt(reading, tier) &&
      (await meshesSettled(page));
    previousCallsAndTriangles = callsAndTriangles;
    return settled;
  }, `every chunk at the ${tier} tier, every wanted mesh settled, and the same draw calls and triangles for ${settleMs} ms`);
  return reading;
}

async function forceTier(page: Page, tier: string): Promise<void> {
  for (;;) {
    const current = (await readHud(page))["Tier (L)"];
    if (current === tier) return;
    await page.keyboard.press("l");
    await until(async () => (await readHud(page))["Tier (L)"] !== current, "the tier to change");
  }
}

async function measureTier(
  page: Page,
  cdp: CDPSession,
  world: string,
  tier: string,
  outDir: string,
  reading: HudReading,
): Promise<Measurement> {
  for (let i = 0; i < GC_PASSES; i++) await cdp.send("HeapProfiler.collectGarbage");
  const usage = (await cdp.send("Runtime.getHeapUsage")) as {
    readonly usedSize: number;
    readonly backingStorageSize?: number;
  };
  if (usage.backingStorageSize === undefined) {
    throw new Error("this Chrome reports no ArrayBuffer backing size; use a newer Chrome");
  }
  const screenshot = join(outDir, `${world}-${tier}.png`);
  await page.locator("canvas.scene").screenshot({ path: screenshot, timeout: READY_TIMEOUT_MS });
  return {
    world,
    tier,
    placements: count(reading["Placements"]),
    drawCalls: count(reading["Draw calls"]),
    triangles: count(reading["Drawn triangles"]),
    chunkTiers: reading["Chunk tiers near/mid/far"] ?? "",
    studsDrawn: reading["Studs drawn"] ?? "",
    heapUsedBytes: usage.usedSize,
    backingStorageBytes: usage.backingStorageSize,
    screenshot,
  };
}

async function measureWorld(
  page: Page,
  baseUrl: string,
  worldPath: string,
  outDir: string,
  settleMs: number,
): Promise<Measurement[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}?api=webgl2&tier=far`);
  await page.waitForSelector('.editor[data-status="ready"]', {
    state: "attached",
    timeout: READY_TIMEOUT_MS,
  });
  await page.setInputFiles(IMPORT_INPUT, worldPath);
  await until(async () => count((await readHud(page))["Placements"]) > 0, "the world to import");
  await until(() => meshesSettled(page), "the far tier and every wanted mesh");
  await page.getByRole("button", { name: "Fit all" }).click({ timeout: READY_TIMEOUT_MS });
  const world = basename(worldPath).replace(/\.brr\.zip$/u, "");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  const rows: Measurement[] = [];
  for (const tier of TIERS_IN_KEY_ORDER) {
    await forceTier(page, tier);
    const reading = await settleAt(page, tier, settleMs);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    rows.push(await measureTier(page, cdp, world, tier, outDir, reading));
  }
  await cdp.detach();
  return rows;
}

async function main(): Promise<void> {
  const worldsDir = values.worlds;
  const outDir = values.out;
  if (!worldsDir || !outDir)
    throw new Error("pass --worlds <dir of .brr.zip files> and --out <dir>");
  mkdirSync(outDir, { recursive: true });
  const worlds = readdirSync(worldsDir)
    .filter((name) => name.endsWith(".brr.zip"))
    .map((name) => resolve(worldsDir, name));
  const port = Number(values.port);
  const server = await serve(resolve(values.app), port);
  const browser = await chromium.launch({
    executablePath: values.chrome ?? process.env["CHROME"] ?? DEFAULT_CHROME,
    args: [
      "--ignore-gpu-blocklist",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--enable-precise-memory-info",
    ],
  });
  const rows: Measurement[] = [];
  try {
    for (const world of worlds) {
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const measured = await measureWorld(
        page,
        `http://127.0.0.1:${port}/`,
        world,
        outDir,
        Number(values["settle-ms"]),
      );
      await context.close();
      for (const row of measured) {
        rows.push(row);
        process.stdout.write(
          `${row.world} ${row.tier}: ${row.placements} placements, ${row.drawCalls} draw calls, ${row.triangles} triangles, tiers ${row.chunkTiers}, heap ${(row.heapUsedBytes / MB).toFixed(1)} MB, backing ${(row.backingStorageBytes / MB).toFixed(1)} MB\n`,
        );
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  writeFileSync(join(outDir, "measurements.json"), `${JSON.stringify(rows, null, 2)}\n`);
}

await main();

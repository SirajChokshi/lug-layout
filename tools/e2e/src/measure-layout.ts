import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import {
  dispatchMs,
  distribution,
  frameTimes,
  type Distribution,
  type FrameTimes,
  type TraceEvent,
} from "./frame-trace.ts";

const DEFAULT_CHROME = "/usr/local/bin/google-chrome";
const VIEWPORT = { width: 1600, height: 900 } as const;
const READY_TIMEOUT_MS = 900_000;
const EDIT_TIMEOUT_MS = 120_000;
const POLL_MS = 500;
const EDIT_POLL_MS = 20;
const GC_PASSES = 3;
const MB = 1e6;
const WORLD_INPUT = 'input[aria-label="Import a .brr.zip world"]';
const PLAN_INPUT = 'input[aria-label="Open a .brrplan.zip plan file"]';
const WORLD_ARCHIVE = /\.brr\.zip$/u;
const PLAN_ARCHIVE = /\.brrplan\.zip$/u;
const LIBRARY_BAKE_ROUTE = "/library-bake/";
const LIBRARY_BAKE_ROOT = fileURLToPath(new URL("../../../.cache/library-bake/", import.meta.url));
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
const CHUNK_TIER_COLUMNS: ReadonlyArray<string> = ["near", "mid", "far"];
const AUTO_TIER = "auto";
const TRACE_CATEGORIES = [
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "toplevel",
  "v8.execute",
];
const INPUT_INTERVAL_MS = 16;
const PAN_RADIUS_PX = 200;
const PAN_PERIOD_MS = 2_000;
const WHEEL_STEP = 100;
const WHEEL_FLIP_MS = 500;
const GESTURE_TAIL_MS = 500;
const HOVER_SWEEP_FRACTION = 0.4;
const EDIT_ZOOM_STEPS = 12;
const ZOOM_IN_DELTA = -WHEEL_STEP;
const MAP_SAMPLE_PX = 160;
const AIM_ATTEMPTS = 6;
const DRAG_STEPS = 10;
const FRAME_TIME = /median ([\d.]+) ms, p95 ([\d.]+) ms over (\d+) frames/u;
const LATENCY_TEXT = /^([\d.]+) ms \((.+)\)$/u;
const SPLIT_TEXT =
  /^([\d.]+) ms rebuild, ([\d.]+) ms to the frame, ([\d.]+) ms submit, ([\d.]+) ms GPU wait$/u;

const { values } = parseArgs({
  options: {
    app: { type: "string", default: "apps/web/dist" },
    worlds: { type: "string" },
    port: { type: "string", default: "4190" },
    out: { type: "string" },
    chrome: { type: "string" },
    "settle-ms": { type: "string", default: "5000" },
    tiers: { type: "string", default: "far,near,mid" },
    "gesture-ms": { type: "string", default: "4000" },
    "hover-ms": { type: "string", default: "15000" },
    repeats: { type: "string", default: "8" },
  },
});

interface Point {
  readonly x: number;
  readonly z: number;
}

interface EditScript {
  readonly module: { readonly item: string; readonly at: Point };
  readonly track: {
    readonly item: string;
    readonly from: Point;
    readonly to: Point;
    readonly extensions: number;
  };
}

interface Memory {
  readonly heapUsedBytes: number;
  readonly backingStorageBytes: number;
}

interface TierMeasurement extends Memory {
  readonly tier: string;
  readonly placements: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly chunkTiers: string;
  readonly studsDrawn: string;
  readonly screenshot: string;
}

interface OpenTimes {
  readonly placedMs: number;
  readonly settledMs: number;
  readonly worldOpenMs: number | null;
}

interface GpuFrames {
  readonly medianMs: number;
  readonly p95Ms: number;
  readonly frames: number;
}

interface PlanMeasurement extends Memory {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly chunkTiers: string;
  readonly gpuFrames: GpuFrames;
  readonly pan: FrameTimes;
  readonly zoom: FrameTimes;
  readonly screenshot: string;
}

interface EditSample {
  readonly totalMs: number;
  readonly rebuildMs: number;
  readonly beforeGpuMs: number;
  readonly gpuWaitMs: number;
}

interface EditRow {
  readonly action: string;
  readonly totalMs: Distribution;
  readonly beforeGpuMs: Distribution;
  readonly rebuildMs: Distribution;
  readonly gpuWaitMs: Distribution;
}

interface EditMeasurement {
  readonly rows: ReadonlyArray<EditRow>;
  readonly refused: ReadonlyArray<string>;
  readonly hover: { readonly pointerMoveMs: Distribution; readonly frames: FrameTimes };
}

interface WorldMeasurement {
  readonly world: string;
  readonly archive: string;
  readonly placements: number;
  readonly open: OpenTimes;
  readonly warmOpen: OpenTimes | null;
  readonly tiers: ReadonlyArray<TierMeasurement>;
  readonly plan: PlanMeasurement;
  readonly edits: EditMeasurement | null;
}

function serve(root: string, port: number): Promise<Server> {
  const server = createServer((request, response) => {
    const urlPath = decodeURIComponent((request.url ?? "/").split("?")[0] ?? "/");
    const [base, relative] = urlPath.startsWith(LIBRARY_BAKE_ROUTE)
      ? [LIBRARY_BAKE_ROOT, urlPath.slice(LIBRARY_BAKE_ROUTE.length)]
      : [root, urlPath];
    let path = normalize(join(base, relative));
    if (!path.startsWith(normalize(base))) {
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
  if (tier === AUTO_TIER) return total > 0;
  return total > 0 && chunks[CHUNK_TIER_COLUMNS.indexOf(tier)] === total;
}

async function until(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<void> {
  const started = Date.now();
  while (!(await check())) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((done) => setTimeout(done, POLL_MS));
  }
}

async function editorAttribute(page: Page, name: string): Promise<string> {
  return (await page.locator(".editor").getAttribute(name)) ?? "";
}

async function meshesSettled(page: Page): Promise<boolean> {
  return (
    (await editorAttribute(page, "data-far-tier")) === "ready" &&
    (await editorAttribute(page, "data-meshes")) === "settled"
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

async function memory(cdp: CDPSession): Promise<Memory> {
  for (let i = 0; i < GC_PASSES; i++) await cdp.send("HeapProfiler.collectGarbage");
  const usage = (await cdp.send("Runtime.getHeapUsage")) as {
    readonly usedSize: number;
    readonly backingStorageSize?: number;
  };
  if (usage.backingStorageSize === undefined) {
    throw new Error("this Chrome reports no ArrayBuffer backing size; use a newer Chrome");
  }
  return { heapUsedBytes: usage.usedSize, backingStorageBytes: usage.backingStorageSize };
}

async function screenshot(page: Page, path: string): Promise<string> {
  await page.locator("canvas.scene").screenshot({ path, timeout: READY_TIMEOUT_MS });
  return path;
}

async function measureTier(
  page: Page,
  cdp: CDPSession,
  world: string,
  tier: string,
  outDir: string,
  reading: HudReading,
): Promise<TierMeasurement> {
  return {
    tier,
    placements: count(reading["Placements"]),
    drawCalls: count(reading["Draw calls"]),
    triangles: count(reading["Drawn triangles"]),
    chunkTiers: reading["Chunk tiers near/mid/far"] ?? "",
    studsDrawn: reading["Studs drawn"] ?? "",
    ...(await memory(cdp)),
    screenshot: await screenshot(page, join(outDir, `${world}-${tier}.png`)),
  };
}

async function startEmpty(page: Page): Promise<void> {
  const welcome = page.locator(".welcome");
  if ((await welcome.count()) === 0) return;
  await welcome.locator('[data-action="start-empty"]').click();
  await welcome.waitFor({ state: "detached" });
}

async function placements(page: Page): Promise<number> {
  return count((await readHud(page))["Placements"]);
}

async function opened(page: Page, started: number): Promise<OpenTimes> {
  await until(async () => (await placements(page)) > 0, "the world's placements");
  const placedMs = Date.now() - started;
  await until(() => meshesSettled(page), "the far tier and every wanted mesh");
  const settledMs = Date.now() - started;
  const worldOpen = (await readHud(page))["World open"];
  return { placedMs, settledMs, worldOpenMs: worldOpen ? Number.parseFloat(worldOpen) : null };
}

async function openArchive(page: Page, path: string): Promise<OpenTimes> {
  await startEmpty(page);
  const started = Date.now();
  await page.setInputFiles(PLAN_ARCHIVE.test(path) ? PLAN_INPUT : WORLD_INPUT, path);
  return opened(page, started);
}

async function reopenWarm(page: Page, baseUrl: string): Promise<OpenTimes> {
  await until(
    async () => (await editorAttribute(page, "data-save")) === "saved",
    "the world to save",
  );
  const started = Date.now();
  await page.goto(`${baseUrl}?api=webgl2`);
  await page.waitForSelector('.editor[data-status="ready"]', {
    state: "attached",
    timeout: READY_TIMEOUT_MS,
  });
  return opened(page, started);
}

async function traced(
  browser: Browser,
  page: Page,
  gesture: () => Promise<void>,
): Promise<ReadonlyArray<TraceEvent>> {
  await browser.startTracing(page, { categories: TRACE_CATEGORIES });
  await gesture();
  await page.waitForTimeout(GESTURE_TAIL_MS);
  const buffer = await browser.stopTracing();
  const parsed: unknown = JSON.parse(buffer.toString("utf8"));
  if (Array.isArray(parsed)) return parsed as TraceEvent[];
  const events = (parsed as { readonly traceEvents?: TraceEvent[] }).traceEvents;
  if (!events) throw new Error("the trace holds no events");
  return events;
}

async function canvasCentre(page: Page): Promise<{ readonly sx: number; readonly sy: number }> {
  const box = await page.locator("canvas.scene").boundingBox();
  if (!box) throw new Error("the editor canvas is not laid out");
  return { sx: box.x + box.width / 2, sy: box.y + box.height / 2 };
}

async function canvasWidth(page: Page): Promise<number> {
  return (await page.locator("canvas.scene").boundingBox())?.width ?? VIEWPORT.width;
}

async function pan(page: Page, gestureMs: number): Promise<void> {
  const { sx, sy } = await canvasCentre(page);
  await page.mouse.move(sx, sy + PAN_RADIUS_PX);
  await page.mouse.down({ button: "right" });
  const started = Date.now();
  for (let elapsed = 0; elapsed < gestureMs; elapsed = Date.now() - started) {
    const angle = (2 * Math.PI * elapsed) / PAN_PERIOD_MS;
    await page.mouse.move(
      sx + PAN_RADIUS_PX * Math.sin(angle),
      sy + PAN_RADIUS_PX * Math.cos(angle),
    );
    await page.waitForTimeout(INPUT_INTERVAL_MS);
  }
  await page.mouse.up({ button: "right" });
}

async function zoom(page: Page, gestureMs: number): Promise<void> {
  const { sx, sy } = await canvasCentre(page);
  await page.mouse.move(sx, sy);
  const started = Date.now();
  for (let elapsed = 0; elapsed < gestureMs; elapsed = Date.now() - started) {
    const inward = Math.floor(elapsed / WHEEL_FLIP_MS) % 2 === 0;
    await page.mouse.wheel(0, inward ? -WHEEL_STEP : WHEEL_STEP);
    await page.waitForTimeout(INPUT_INTERVAL_MS);
  }
}

async function view(page: Page, mode: "plan" | "orbit"): Promise<void> {
  await page.locator(`.view-controls [data-action="view-${mode}"]`).click();
  await page.locator(`.view-controls[data-view="${mode}"]`).waitFor();
}

async function gpuFrames(page: Page): Promise<GpuFrames> {
  await page.keyboard.press("m");
  let match: RegExpExecArray | null = null;
  await until(async () => {
    match = FRAME_TIME.exec((await readHud(page))["Frame time (M), GPU-synced"] ?? "");
    return match !== null;
  }, "the GPU-synced frame measurement");
  const found: RegExpExecArray | null = match;
  if (!found) throw new Error("the frame measurement vanished");
  return { medianMs: Number(found[1]), p95Ms: Number(found[2]), frames: Number(found[3]) };
}

async function measurePlan(
  browser: Browser,
  page: Page,
  cdp: CDPSession,
  world: string,
  outDir: string,
  settleMs: number,
  gestureMs: number,
): Promise<PlanMeasurement> {
  await view(page, "plan");
  await forceTier(page, AUTO_TIER);
  await page.getByRole("button", { name: "Fit all" }).click();
  const reading = await settleAt(page, AUTO_TIER, settleMs);
  const frames = await gpuFrames(page);
  const held = await memory(cdp);
  const shot = await screenshot(page, join(outDir, `${world}-plan.png`));
  const panned = frameTimes(await traced(browser, page, () => pan(page, gestureMs)));
  const zoomed = frameTimes(await traced(browser, page, () => zoom(page, gestureMs)));
  return {
    drawCalls: count(reading["Draw calls"]),
    triangles: count(reading["Drawn triangles"]),
    chunkTiers: reading["Chunk tiers near/mid/far"] ?? "",
    gpuFrames: frames,
    ...held,
    pan: panned,
    zoom: zoomed,
    screenshot: shot,
  };
}

interface ScreenSample {
  readonly sx: number;
  readonly sy: number;
  readonly at: Point;
}

class ScreenMap {
  private readonly page: Page;
  private readonly origin: ScreenSample;
  private readonly lduPerPxX: number;
  private readonly lduPerPxY: number;

  private constructor(page: Page, origin: ScreenSample, lduPerPxX: number, lduPerPxY: number) {
    this.page = page;
    this.origin = origin;
    this.lduPerPxX = lduPerPxX;
    this.lduPerPxY = lduPerPxY;
  }

  static async fit(page: Page): Promise<ScreenMap> {
    const { sx, sy } = await canvasCentre(page);
    const a = await hoverAt(page, sx, sy);
    const b = await hoverAt(page, sx + MAP_SAMPLE_PX, sy + MAP_SAMPLE_PX);
    if (!a || !b) throw new Error("the cursor reads no lattice point on the canvas");
    return new ScreenMap(
      page,
      { sx, sy, at: a },
      (b.x - a.x) / MAP_SAMPLE_PX,
      (b.z - a.z) / MAP_SAMPLE_PX,
    );
  }

  async aim(target: Point): Promise<{ readonly sx: number; readonly sy: number }> {
    let sx = this.origin.sx + (target.x - this.origin.at.x) / this.lduPerPxX;
    let sy = this.origin.sy + (target.z - this.origin.at.z) / this.lduPerPxY;
    for (let attempt = 0; attempt < AIM_ATTEMPTS; attempt++) {
      const read = await hoverAt(this.page, sx, sy);
      if (read && read.x === target.x && read.z === target.z) return { sx, sy };
      if (!read) break;
      sx += (target.x - read.x) / this.lduPerPxX;
      sy += (target.z - read.z) / this.lduPerPxY;
    }
    throw new Error(`no screen point reads ${target.x}, ${target.z} LDU`);
  }
}

async function hoverAt(page: Page, sx: number, sy: number): Promise<Point | null> {
  await page.mouse.move(sx, sy);
  await nextFrames(page);
  const value = await editorAttribute(page, "data-hover");
  if (!value) return null;
  const [x, z] = value.split(",").map(Number);
  return x === undefined || z === undefined ? null : { x, z };
}

async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => done()));
      }),
  );
}

async function pick(page: Page, item: string): Promise<void> {
  const button = page.locator(`.palette [data-item="${item}"]`).first();
  await button.click();
  await page.waitForFunction(
    (id) =>
      document.querySelector(`.palette [data-item="${id}"]`)?.getAttribute("aria-pressed") ===
      "true",
    item,
  );
}

function editSample(hud: HudReading, what: string): EditSample {
  const total = LATENCY_TEXT.exec(hud["Last edit latency"] ?? "");
  const split = SPLIT_TEXT.exec(hud["Last edit split"] ?? "");
  if (!total || !split) throw new Error(`${what}'s latency doesn't read`);
  const [rebuild, queue, submit, gpuWait] = split.slice(1).map(Number);
  return {
    totalMs: Number(total[1]),
    rebuildMs: rebuild ?? 0,
    beforeGpuMs: (rebuild ?? 0) + (queue ?? 0) + (submit ?? 0),
    gpuWaitMs: gpuWait ?? 0,
  };
}

class LatencyLog {
  readonly samples = new Map<string, EditSample[]>();
  readonly refused: string[] = [];
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async edit(what: string, act: () => Promise<void>): Promise<boolean> {
    const samples = Number(await editorAttribute(this.page, "data-latency-samples"));
    const refused = Number(await editorAttribute(this.page, "data-refused"));
    await act();
    const started = Date.now();
    for (;;) {
      if (Number(await editorAttribute(this.page, "data-latency-samples")) > samples) break;
      if (Number(await editorAttribute(this.page, "data-refused")) > refused) {
        this.refused.push(`${what}: ${(await readHud(this.page))["Last refusal"] ?? ""}`);
        return false;
      }
      if (Date.now() - started > EDIT_TIMEOUT_MS)
        throw new Error(`${what} recorded no latency sample`);
      await new Promise((done) => setTimeout(done, EDIT_POLL_MS));
    }
    const list = this.samples.get(what) ?? [];
    list.push(editSample(await readHud(this.page), what));
    this.samples.set(what, list);
    return true;
  }

  rows(): ReadonlyArray<EditRow> {
    return [...this.samples].map(([action, samples]) => ({
      action,
      totalMs: distribution(samples.map((sample) => sample.totalMs)),
      beforeGpuMs: distribution(samples.map((sample) => sample.beforeGpuMs)),
      rebuildMs: distribution(samples.map((sample) => sample.rebuildMs)),
      gpuWaitMs: distribution(samples.map((sample) => sample.gpuWaitMs)),
    }));
  }
}

async function setPrecise(page: Page): Promise<void> {
  const control = page.locator('[data-action="placement-mode"]');
  if ((await control.getAttribute("data-placement-mode")) !== "precise") await control.click();
}

async function zoomOnto(page: Page, target: Point): Promise<ScreenMap> {
  await page.getByLabel("Go to x (LDU)").fill(String(target.x));
  await page.getByLabel("Go to z (LDU)").fill(String(target.z));
  await page.getByRole("button", { name: "Go to x, z" }).click();
  const { sx, sy } = await canvasCentre(page);
  await page.mouse.move(sx, sy);
  for (let step = 0; step < EDIT_ZOOM_STEPS; step++) {
    await page.mouse.wheel(0, ZOOM_IN_DELTA);
    await nextFrames(page);
  }
  await page.waitForTimeout(GESTURE_TAIL_MS);
  return ScreenMap.fit(page);
}

async function moduleCycle(
  page: Page,
  map: ScreenMap,
  log: LatencyLog,
  script: EditScript,
): Promise<void> {
  await pick(page, script.module.item);
  const at = await map.aim(script.module.at);
  if (!(await log.edit("place", () => page.mouse.click(at.sx, at.sy)))) return;
  await page.keyboard.press("Escape");
  await page.mouse.click(at.sx, at.sy);
  const nudged =
    (await log.edit("move", () => page.keyboard.press("ArrowRight"))) ||
    (await log.edit("move", () => page.keyboard.press("ArrowLeft")));
  if (!nudged) return;
  await log.edit("delete", () => page.keyboard.press("Delete"));
  await log.edit("undo", () => page.keyboard.press("Control+z"));
  await log.edit("delete", () => page.keyboard.press("Delete"));
}

async function trackCycle(
  page: Page,
  map: ScreenMap,
  log: LatencyLog,
  script: EditScript,
): Promise<void> {
  await page.keyboard.press("Escape");
  await pick(page, script.track.item);
  const from = await map.aim(script.track.from);
  const to = await map.aim(script.track.to);
  const laid = await log.edit("track commit", async () => {
    await page.mouse.move(from.sx, from.sy);
    await page.mouse.down();
    for (let step = 1; step <= DRAG_STEPS; step++) {
      const t = step / DRAG_STEPS;
      await page.mouse.move(from.sx + (to.sx - from.sx) * t, from.sy + (to.sy - from.sy) * t);
    }
    await page.mouse.up();
  });
  if (!laid) return;
  let commits = 1;
  for (let press = 0; press < script.track.extensions; press++) {
    if (await log.edit("track commit", () => page.keyboard.press("w"))) commits++;
  }
  for (let undo = 0; undo < commits; undo++) {
    await log.edit("undo", () => page.keyboard.press("Control+z"));
  }
}

async function hoverHeld(
  browser: Browser,
  page: Page,
  map: ScreenMap,
  script: EditScript,
  gestureMs: number,
): Promise<EditMeasurement["hover"]> {
  await page.keyboard.press("Escape");
  await pick(page, script.module.item);
  const { sy } = await map.aim(script.module.at);
  const { sx } = await canvasCentre(page);
  const reach = (await canvasWidth(page)) * HOVER_SWEEP_FRACTION;
  const events = await traced(browser, page, async () => {
    const started = Date.now();
    for (let elapsed = 0; elapsed < gestureMs; elapsed = Date.now() - started) {
      const phase = (elapsed % PAN_PERIOD_MS) / PAN_PERIOD_MS;
      await page.mouse.move(sx - reach + 2 * reach * phase, sy);
      await page.waitForTimeout(INPUT_INTERVAL_MS);
    }
  });
  await page.keyboard.press("Escape");
  return { pointerMoveMs: dispatchMs(events, "pointermove"), frames: frameTimes(events) };
}

async function measureEdits(
  browser: Browser,
  page: Page,
  script: EditScript,
  repeats: number,
  hoverMs: number,
): Promise<EditMeasurement> {
  const map = await zoomOnto(page, script.module.at);
  await setPrecise(page);
  const log = new LatencyLog(page);
  for (let cycle = 0; cycle < repeats; cycle++) await moduleCycle(page, map, log, script);
  for (let cycle = 0; cycle < repeats; cycle++) await trackCycle(page, map, log, script);
  const hover = await hoverHeld(browser, page, map, script, hoverMs);
  return { rows: log.rows(), refused: log.refused, hover };
}

function stemOf(path: string): string {
  return basename(path).replace(PLAN_ARCHIVE, "").replace(WORLD_ARCHIVE, "");
}

function editScript(path: string): EditScript | null {
  const sidecar = join(dirname(path), `${stemOf(path)}.edits.json`);
  if (!existsSync(sidecar)) return null;
  const parsed: EditScript = JSON.parse(readFileSync(sidecar, "utf8"));
  return parsed;
}

async function measureWorld(
  browser: Browser,
  page: Page,
  baseUrl: string,
  archive: string,
  outDir: string,
): Promise<WorldMeasurement> {
  const settleMs = Number(values["settle-ms"]);
  const gestureMs = Number(values["gesture-ms"]);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${baseUrl}?api=webgl2&tier=far`);
  await page.waitForSelector('.editor[data-status="ready"]', {
    state: "attached",
    timeout: READY_TIMEOUT_MS,
  });
  const open = await openArchive(page, archive);
  await view(page, "orbit");
  await page.getByRole("button", { name: "Fit all" }).click({ timeout: READY_TIMEOUT_MS });
  const world = stemOf(archive);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  const tiers: TierMeasurement[] = [];
  for (const tier of (values.tiers ?? "").split(",").filter((name) => name !== "")) {
    await forceTier(page, tier);
    const reading = await settleAt(page, tier, settleMs);
    if (errors.length > 0) throw new Error(errors.join("\n"));
    tiers.push(await measureTier(page, cdp, world, tier, outDir, reading));
  }
  const plan = await measurePlan(browser, page, cdp, world, outDir, settleMs, gestureMs);
  const script = editScript(archive);
  const edits = script
    ? await measureEdits(browser, page, script, Number(values.repeats), Number(values["hover-ms"]))
    : null;
  const placed = await placements(page);
  await cdp.detach();
  const warmOpen = await reopenWarm(page, baseUrl);
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return {
    world,
    archive: basename(archive),
    placements: placed,
    open,
    warmOpen,
    tiers,
    plan,
    edits,
  };
}

function ms(value: number): string {
  return value.toFixed(1);
}

function spread(d: Distribution): string {
  return `${ms(d.p50)} / ${ms(d.p95)} / ${ms(d.max)}`;
}

function report(rows: ReadonlyArray<WorldMeasurement>): string {
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(
      `### ${row.world} (${row.archive}, ${row.placements.toLocaleString("en-US")} placements)`,
      "",
      "| Open | Placements shown | Every wanted mesh settled | Editor's world open |",
      "|---|---:|---:|---:|",
      `| cold, from the file | ${row.open.placedMs} ms | ${row.open.settledMs} ms | ${row.open.worldOpenMs === null ? "–" : `${ms(row.open.worldOpenMs)} ms`} |`,
      ...(row.warmOpen
        ? [
            `| warm, reload | ${row.warmOpen.placedMs} ms | ${row.warmOpen.settledMs} ms | ${row.warmOpen.worldOpenMs === null ? "–" : `${ms(row.warmOpen.worldOpenMs)} ms`} |`,
          ]
        : []),
      "",
      "| View | Draw calls | Triangles | Chunks near/mid/far | Heap | ArrayBuffers |",
      "|---|---:|---:|---|---:|---:|",
      ...row.tiers.map(
        (tier) =>
          `| 3D, ${tier.tier} tier | ${tier.drawCalls.toLocaleString("en-US")} | ${tier.triangles.toLocaleString("en-US")} | ${tier.chunkTiers} | ${(tier.heapUsedBytes / MB).toFixed(0)} MB | ${(tier.backingStorageBytes / MB).toFixed(0)} MB |`,
      ),
      `| 2D plan, auto tier | ${row.plan.drawCalls.toLocaleString("en-US")} | ${row.plan.triangles.toLocaleString("en-US")} | ${row.plan.chunkTiers} | ${(row.plan.heapUsedBytes / MB).toFixed(0)} MB | ${(row.plan.backingStorageBytes / MB).toFixed(0)} MB |`,
      "",
      `2D plan, GPU-synced frame (M): median ${ms(row.plan.gpuFrames.medianMs)} ms, p95 ${ms(row.plan.gpuFrames.p95Ms)} ms over ${row.plan.gpuFrames.frames} frames at rest.`,
      "",
      "| 2D plan gesture | Frames | fps | Frame interval p50 / p95 / max | Main-thread JS per frame p50 / p95 / max |",
      "|---|---:|---:|---:|---:|",
      `| pan (right-drag) | ${row.plan.pan.frames} | ${row.plan.pan.fps.toFixed(1)} | ${spread(row.plan.pan.intervalMs)} ms | ${spread(row.plan.pan.mainThreadJsMs)} ms |`,
      `| zoom (wheel) | ${row.plan.zoom.frames} | ${row.plan.zoom.fps.toFixed(1)} | ${spread(row.plan.zoom.intervalMs)} ms | ${spread(row.plan.zoom.mainThreadJsMs)} ms |`,
      "",
    );
    if (row.edits) {
      lines.push(
        "| Edit in the 2D plan | Samples | Event to presented frame p50 / p95 / max | Event to submitted frame p50 / p95 / max | Rebuild p50 / p95 / max | GPU wait p50 / p95 / max |",
        "|---|---:|---:|---:|---:|---:|",
        ...row.edits.rows.map(
          (edit) =>
            `| ${edit.action} | ${edit.totalMs.count} | ${spread(edit.totalMs)} ms | ${spread(edit.beforeGpuMs)} ms | ${spread(edit.rebuildMs)} ms | ${spread(edit.gpuWaitMs)} ms |`,
        ),
        "",
        `Hover with a model held: pointermove handler p50 / p95 / max ${spread(row.edits.hover.pointerMoveMs)} ms over ${row.edits.hover.pointerMoveMs.count} events.`,
        "",
        `While hovering: ${row.edits.hover.frames.fps.toFixed(1)} fps, main-thread JS per frame ${spread(row.edits.hover.frames.mainThreadJsMs)} ms.${row.edits.refused.length > 0 ? ` Refused: ${row.edits.refused.join("; ")}.` : ""}`,
        "",
      );
    }
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const worldsDir = values.worlds;
  const outDir = values.out;
  if (!worldsDir || !outDir)
    throw new Error("pass --worlds <dir of .brr.zip or .brrplan.zip files> and --out <dir>");
  mkdirSync(outDir, { recursive: true });
  const archives = readdirSync(worldsDir)
    .filter((name) => WORLD_ARCHIVE.test(name) || PLAN_ARCHIVE.test(name))
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
  const rows: WorldMeasurement[] = [];
  try {
    for (const archive of archives) {
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const measured = await measureWorld(
        browser,
        page,
        `http://127.0.0.1:${port}/`,
        archive,
        outDir,
      );
      await context.close();
      rows.push(measured);
      process.stdout.write(`${report([measured])}\n`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  writeFileSync(join(outDir, "measurements.json"), `${JSON.stringify(rows, null, 2)}\n`);
  writeFileSync(join(outDir, "measurements.md"), `${report(rows)}\n`);
}

await main();

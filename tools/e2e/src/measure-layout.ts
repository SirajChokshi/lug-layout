import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Browser, type CDPSession, type Page } from "playwright-core";
import type { Point } from "./show-world/show-layout.ts";
import type { EditScript } from "./show-world/show-world-builder.ts";

interface TraceEvent {
  readonly name: string;
  readonly ph: string;
  readonly ts: number;
  readonly dur?: number;
  readonly pid: number;
  readonly tid: number;
  readonly args?: {
    readonly name?: string;
    readonly data?: { readonly type?: string };
  };
}

interface Distribution {
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

interface FrameTimes {
  readonly frames: number;
  readonly fps: number;
  readonly intervalMs: Distribution;
  readonly mainThreadJsMs: Distribution;
}

interface Thread {
  readonly pid: number;
  readonly tid: number;
}

const US_PER_MS = 1000;
const MS_PER_SECOND = 1000;
const P50 = 0.5;
const P95 = 0.95;
const RENDERER_MAIN = "CrRendererMain";
const FRAME_START = "BeginMainThreadFrame";
const JS_EVENTS: ReadonlySet<string> = new Set([
  "FunctionCall",
  "EventDispatch",
  "FireAnimationFrame",
  "TimerFire",
  "FireIdleCallback",
  "EvaluateScript",
  "RunMicrotasks",
  "v8.run",
  "v8.callFunction",
]);

function distribution(values: ReadonlyArray<number>): Distribution {
  const sorted = values.toSorted((a, b) => a - b);
  const at = (fraction: number): number =>
    sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)] ?? 0;
  return { count: sorted.length, p50: at(P50), p95: at(P95), max: sorted.at(-1) ?? 0 };
}

function isComplete(event: TraceEvent): event is TraceEvent & { readonly dur: number } {
  return event.ph === "X" && typeof event.dur === "number";
}

function onThread(event: TraceEvent, thread: Thread): boolean {
  return event.pid === thread.pid && event.tid === thread.tid;
}

function rendererMain(events: ReadonlyArray<TraceEvent>): Thread {
  const mains = events.filter(
    (event) =>
      event.ph === "M" && event.name === "thread_name" && event.args?.name === RENDERER_MAIN,
  );
  let best: Thread | null = null;
  let bestFrames = -1;
  for (const thread of mains) {
    const frames = events.filter(
      (event) => event.name === FRAME_START && onThread(event, thread),
    ).length;
    if (frames > bestFrames) {
      best = { pid: thread.pid, tid: thread.tid };
      bestFrames = frames;
    }
  }
  if (best === null) throw new Error("the trace has no renderer main thread");
  return best;
}

function unionWithin(
  intervals: ReadonlyArray<readonly [number, number]>,
  from: number,
  to: number,
): number {
  let total = 0;
  let reach = from;
  for (const [start, end] of intervals) {
    const clippedStart = Math.max(start, reach);
    const clippedEnd = Math.min(end, to);
    if (clippedEnd > clippedStart) total += clippedEnd - clippedStart;
    reach = Math.max(reach, Math.min(end, to));
    if (start >= to) break;
  }
  return total;
}

function frameTimes(events: ReadonlyArray<TraceEvent>): FrameTimes {
  const renderer = rendererMain(events);
  const starts = events
    .filter((event) => event.name === FRAME_START && onThread(event, renderer))
    .map((event) => event.ts)
    .toSorted((a, b) => a - b);
  const js = events
    .filter((event) => JS_EVENTS.has(event.name) && isComplete(event) && onThread(event, renderer))
    .map((event): readonly [number, number] => [event.ts, event.ts + (event.dur ?? 0)])
    .toSorted((a, b) => a[0] - b[0]);
  const intervals: number[] = [];
  const perFrame: number[] = [];
  for (let frame = 0; frame + 1 < starts.length; frame++) {
    const from = starts[frame] ?? 0;
    const to = starts[frame + 1] ?? from;
    intervals.push((to - from) / US_PER_MS);
    const firstJs = js.findIndex(([, end]) => end > from);
    perFrame.push(firstJs < 0 ? 0 : unionWithin(js.slice(firstJs), from, to) / US_PER_MS);
  }
  const spanMs = ((starts.at(-1) ?? 0) - (starts[0] ?? 0)) / US_PER_MS;
  return {
    frames: intervals.length,
    fps: spanMs > 0 ? (intervals.length * MS_PER_SECOND) / spanMs : 0,
    intervalMs: distribution(intervals),
    mainThreadJsMs: distribution(perFrame),
  };
}

function dispatchMs(events: ReadonlyArray<TraceEvent>, type: string): Distribution {
  const renderer = rendererMain(events);
  return distribution(
    events
      .filter(
        (event) =>
          event.name === "EventDispatch" &&
          isComplete(event) &&
          onThread(event, renderer) &&
          event.args?.data?.type === type,
      )
      .map((event) => (event.dur ?? 0) / US_PER_MS),
  );
}

const DEFAULT_CHROME = "/usr/local/bin/google-chrome";
const VIEWPORT = { width: 1600, height: 900 } as const;
const READY_TIMEOUT_MS = 3_600_000;
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
const MAX_EDIT_ZOOM_STEPS = 60;
const EDIT_LDU_PER_PX = 4;
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
  readonly placements: number | null;
  readonly open: OpenTimes | null;
  readonly tiers: ReadonlyArray<TierMeasurement>;
  readonly plan: PlanMeasurement | null;
  readonly edits: EditMeasurement | null;
  readonly warmOpen: OpenTimes | null;
  readonly failure: string | null;
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
  await page.goto(`${baseUrl}?api=webgl2&tier=far`);
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
  readonly lduPerPxX: number;
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

async function zoomOnto(page: Page, script: EditScript): Promise<ScreenMap> {
  const x = (script.module.at.x + script.track.to.x) / 2;
  const z = (script.module.at.z + script.track.to.z) / 2;
  await page.getByLabel("Go to x (LDU)").fill(String(Math.round(x)));
  await page.getByLabel("Go to z (LDU)").fill(String(Math.round(z)));
  await page.getByRole("button", { name: "Go to x, z" }).click();
  const { sx, sy } = await canvasCentre(page);
  for (let step = 0; step < MAX_EDIT_ZOOM_STEPS; step++) {
    const map = await ScreenMap.fit(page);
    if (Math.abs(map.lduPerPxX) <= EDIT_LDU_PER_PX) return map;
    await page.mouse.move(sx, sy);
    await page.mouse.wheel(0, -WHEEL_STEP);
    await page.waitForTimeout(GESTURE_TAIL_MS);
  }
  throw new Error(
    `${MAX_EDIT_ZOOM_STEPS} wheel steps didn't zoom to ${EDIT_LDU_PER_PX} LDU a pixel`,
  );
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
  await log.edit("undo model", () => page.keyboard.press("Control+z"));
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
  const laid = await log.edit("track commit, drag", async () => {
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
    if (await log.edit("track commit, W", () => page.keyboard.press("w"))) commits++;
  }
  for (let undo = 0; undo < commits; undo++) {
    await log.edit("undo track", () => page.keyboard.press("Control+z"));
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
  const map = await zoomOnto(page, script);
  await setPrecise(page);
  await until(() => meshesSettled(page), "the meshes at the edit site");
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
  record: (row: WorldMeasurement) => void,
): Promise<WorldMeasurement> {
  const settleMs = Number(values["settle-ms"]);
  const gestureMs = Number(values["gesture-ms"]);
  const world = basename(archive, ".zip");
  let row: WorldMeasurement = {
    world,
    archive: basename(archive),
    placements: null,
    open: null,
    tiers: [],
    plan: null,
    edits: null,
    warmOpen: null,
    failure: null,
  };
  const update = (patch: Partial<WorldMeasurement>): void => {
    row = { ...row, ...patch };
    record(row);
  };
  const errors: string[] = [];
  const pageErrors = (): void => {
    if (errors.length > 0) throw new Error(errors.join("\n"));
  };
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(READY_TIMEOUT_MS);
  try {
    await page.goto(`${baseUrl}?api=webgl2&tier=far`);
    await page.waitForSelector('.editor[data-status="ready"]', { state: "attached" });
    update({ open: await openArchive(page, archive), placements: await placements(page) });
    await view(page, "orbit");
    await page.getByRole("button", { name: "Fit all" }).click();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("HeapProfiler.enable");
    for (const tier of (values.tiers ?? "").split(",").filter((name) => name !== "")) {
      await forceTier(page, tier);
      const reading = await settleAt(page, tier, settleMs);
      pageErrors();
      update({ tiers: [...row.tiers, await measureTier(page, cdp, world, tier, outDir, reading)] });
    }
    update({ plan: await measurePlan(browser, page, cdp, world, outDir, settleMs, gestureMs) });
    pageErrors();
    const script = editScript(archive);
    if (script) {
      const repeats = Number(values.repeats);
      update({
        edits: await measureEdits(browser, page, script, repeats, Number(values["hover-ms"])),
      });
    }
    pageErrors();
    await cdp.detach();
    update({ warmOpen: await reopenWarm(page, baseUrl) });
    pageErrors();
  } catch (error) {
    update({ failure: error instanceof Error ? error.message : String(error) });
  }
  return row;
}

function ms(value: number): string {
  return value.toFixed(1);
}

function spread(d: Distribution): string {
  return `${ms(d.p50)} / ${ms(d.p95)} / ${ms(d.max)}`;
}

function openRow(label: string, open: OpenTimes): string {
  const editor = open.worldOpenMs === null ? "–" : `${ms(open.worldOpenMs)} ms`;
  return `| ${label} | ${open.placedMs} ms | ${open.settledMs} ms | ${editor} |`;
}

function viewRow(label: string, reading: TierMeasurement | PlanMeasurement): string {
  return `| ${label} | ${reading.drawCalls.toLocaleString("en-US")} | ${reading.triangles.toLocaleString("en-US")} | ${reading.chunkTiers} | ${(reading.heapUsedBytes / MB).toFixed(0)} MB | ${(reading.backingStorageBytes / MB).toFixed(0)} MB |`;
}

function gestureRow(label: string, frames: FrameTimes): string {
  return `| ${label} | ${frames.frames} | ${frames.fps.toFixed(1)} | ${spread(frames.intervalMs)} ms | ${spread(frames.mainThreadJsMs)} ms |`;
}

function report(rows: ReadonlyArray<WorldMeasurement>): string {
  const lines: string[] = [];
  for (const row of rows) {
    const opens: Array<readonly [string, OpenTimes | null]> = [
      ["cold, from the file", row.open],
      ["warm, reload", row.warmOpen],
    ];
    lines.push(
      `### ${row.world} (${row.archive}, ${row.placements?.toLocaleString("en-US") ?? "?"} placements)`,
      "",
      "| Open | Placements shown | Every wanted mesh settled | Editor's world open |",
      "|---|---:|---:|---:|",
      ...opens.flatMap(([label, open]) => (open ? [openRow(label, open)] : [])),
      "",
      "| View | Draw calls | Triangles | Chunks near/mid/far | Heap | ArrayBuffers |",
      "|---|---:|---:|---|---:|---:|",
      ...row.tiers.map((tier) => viewRow(`3D, ${tier.tier} tier`, tier)),
      ...(row.plan ? [viewRow("2D plan, auto tier", row.plan)] : []),
      "",
    );
    if (row.plan) {
      lines.push(
        `2D plan, GPU-synced frame (M): median ${ms(row.plan.gpuFrames.medianMs)} ms, p95 ${ms(row.plan.gpuFrames.p95Ms)} ms over ${row.plan.gpuFrames.frames} frames at rest.`,
        "",
        "| 2D plan gesture | Frames | fps | Frame interval p50 / p95 / max | Main-thread JS per frame p50 / p95 / max |",
        "|---|---:|---:|---:|---:|",
        gestureRow("pan (right-drag)", row.plan.pan),
        gestureRow("zoom (wheel)", row.plan.zoom),
        "",
      );
    }
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
    if (row.failure) lines.push(`Stopped: ${row.failure}`, "");
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
  const flush = (current: WorldMeasurement): void => {
    const all = [...rows, current];
    writeFileSync(join(outDir, "measurements.json"), `${JSON.stringify(all, null, 2)}\n`);
    writeFileSync(join(outDir, "measurements.md"), `${report(all)}\n`);
  };
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
        flush,
      );
      await context.close();
      rows.push(measured);
      process.stdout.write(`${report([measured])}\n`);
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (rows.some((row) => row.failure !== null)) process.exitCode = 1;
}

await main();

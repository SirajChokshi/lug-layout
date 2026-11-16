import { CITY_SCENE, mainThreadModules, type FrameStats } from "@brr/client";
import { Container } from "inversify";
import { readBenchParams } from "./bench-params.ts";
import { installGpuMemoryProbe } from "./gpu-memory-probe.ts";
import { buildResult, measureFrames } from "./measure.ts";

const readGpuMemory = installGpuMemoryProbe();

const ORBIT_PERIOD_MS = 40_000;
const HUD_REFRESH_MS = 500;
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function element<T extends Element>(selector: string): T {
  const found = document.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
}

function renderStats(rows: ReadonlyArray<readonly [string, string]>): void {
  const list = element<HTMLDListElement>("#stats");
  list.replaceChildren(
    ...rows.flatMap(([label, value]) => {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      return [dt, dd];
    }),
  );
}

const params = readBenchParams(location.search);
const canvas = element<HTMLCanvasElement>("#scene");
if (params.width > 0 && params.height > 0) {
  canvas.style.width = `${params.width}px`;
  canvas.style.height = `${params.height}px`;
}

const container = new Container();
container.load(...mainThreadModules({ bundleBaseUrl: new URL("bundle/", document.baseURI).href }));
const scene = container.get(CITY_SCENE);

const backend = await scene.attach({
  canvas,
  api: params.api,
  strategy: params.strategy,
  pixelRatio: 1,
  antialias: true,
});
const loadStart = performance.now();
const summary = await scene.load({
  lod: params.lod,
  targetParts: params.parts,
  partsPerModule: 2_000,
  seed: params.seed,
});
const loadMs = performance.now() - loadStart;

element<HTMLElement>("#credits").textContent =
  `Parts: LDraw parts library (${summary.creditedFiles} files, CCAL 2.0, modified from LDraw: flattened, studs extracted). ${summary.disclaimer}`;

const baseRows: Array<readonly [string, string]> = [
  [
    "API",
    `${backend.activeApi}${backend.activeApi === backend.requestedApi ? "" : ` (asked ${backend.requestedApi})`}`,
  ],
  ["Adapter", backend.adapter],
  ["Strategy", `${backend.strategy}, LOD ${params.lod}`],
  ["Parts", integer.format(summary.parts)],
  ["Modules", integer.format(summary.modules)],
  ["Stud instances", integer.format(summary.studInstances)],
  ["Scene triangles", integer.format(summary.bodyTriangles + summary.studTriangles)],
  ["Load", `${integer.format(loadMs)} ms`],
];

const stats: FrameStats = { drawCalls: 0, triangles: 0 };
const mib = (bytes: number): string => `${(bytes / 1048576).toFixed(1)} MiB`;

window.addEventListener("resize", () => {
  scene.resize(canvas.clientWidth, canvas.clientHeight);
});

async function runMeasurement(): Promise<void> {
  const timings = await measureFrames(scene, params, stats);
  const memory = readGpuMemory();
  const result = buildResult(params, backend, summary, loadMs, timings, stats, memory);
  renderStats([
    ...baseRows,
    ["Median frame (GPU-synced)", `${timings.medianFrameMs.toFixed(1)} ms`],
    ["p95 frame", `${timings.p95FrameMs.toFixed(1)} ms`],
    ["Median CPU submit", `${timings.medianCpuSubmitMs.toFixed(1)} ms`],
    ["fps (1000 / median)", timings.fpsFromMedian.toFixed(2)],
    ["Draw calls", integer.format(stats.drawCalls)],
    ["Drawn triangles", integer.format(stats.triangles)],
    ["GPU buffers", mib(memory.bufferBytes)],
    ["GPU textures", mib(memory.textureBytes)],
  ]);
  const output = element<HTMLPreElement>("#result");
  output.textContent = JSON.stringify(result);
  document.body.dataset["benchDone"] = "1";
}

const startedAt = performance.now();
let frames = 0;
let windowStart = startedAt;

function frame(now: number): void {
  scene.setCamera(params.camera, ((now - startedAt) % ORBIT_PERIOD_MS) / ORBIT_PERIOD_MS);
  scene.renderFrame(stats);
  frames++;
  if (now - windowStart >= HUD_REFRESH_MS) {
    const fps = (frames * 1000) / (now - windowStart);
    renderStats([
      ...baseRows,
      ["Frame rate (rAF)", `${fps.toFixed(1)} fps`],
      ["Draw calls", integer.format(stats.drawCalls)],
      ["Drawn triangles", integer.format(stats.triangles)],
    ]);
    frames = 0;
    windowStart = now;
  }
  requestAnimationFrame(frame);
}

renderStats(baseRows);
if (params.measure) await runMeasurement();
else requestAnimationFrame(frame);

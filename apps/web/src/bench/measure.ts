import type { BackendInfo, CitySceneSummary, FrameStats, ICitySceneService } from "@brr/client";
import type { BenchParams } from "./bench-params.ts";
import type { GpuMemorySnapshot } from "./gpu-memory-probe.ts";

export interface FrameTimings {
  readonly frames: number;
  readonly medianFrameMs: number;
  readonly p95FrameMs: number;
  readonly meanFrameMs: number;
  readonly medianCpuSubmitMs: number;
  readonly fpsFromMedian: number;
  readonly jsHeapGrowthPerFrameBytes: number | null;
}

export interface BenchResult {
  readonly params: BenchParams;
  readonly backend: BackendInfo;
  readonly summary: Omit<CitySceneSummary, "disclaimer">;
  readonly loadMs: number;
  readonly timings: FrameTimings;
  readonly drawCalls: number;
  readonly drawnTriangles: number;
  readonly gpuMemory: GpuMemorySnapshot;
  readonly jsHeapUsedBytes: number | null;
  readonly userAgent: string;
  readonly hardwareConcurrency: number;
}

function percentile(sorted: Float64Array, fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

function jsHeapUsed(): number | null {
  const memory: unknown = Reflect.get(performance, "memory");
  if (typeof memory !== "object" || memory === null) return null;
  const used: unknown = Reflect.get(memory, "usedJSHeapSize");
  return typeof used === "number" ? used : null;
}

export async function measureFrames(
  scene: ICitySceneService,
  params: BenchParams,
  stats: FrameStats,
): Promise<FrameTimings> {
  for (let i = 0; i < params.warmupFrames; i++) {
    scene.setCamera(params.camera, i / params.warmupFrames);
    scene.renderFrame(stats);
    await scene.waitForGpu();
  }
  const frameMs = new Float64Array(params.measuredFrames);
  const cpuMs = new Float64Array(params.measuredFrames);
  const heapBefore = jsHeapUsed();
  const started = performance.now();
  let frames = 0;
  while (frames < params.measuredFrames && performance.now() - started < params.maxMeasureMs) {
    const t0 = performance.now();
    scene.setCamera(params.camera, frames / params.measuredFrames);
    scene.renderFrame(stats);
    const t1 = performance.now();
    await scene.waitForGpu();
    const t2 = performance.now();
    cpuMs[frames] = t1 - t0;
    frameMs[frames] = t2 - t0;
    frames++;
  }
  const heapAfter = jsHeapUsed();
  const frameSorted = frameMs.slice(0, frames).toSorted();
  const cpuSorted = cpuMs.slice(0, frames).toSorted();
  let total = 0;
  for (let i = 0; i < frames; i++) total += frameSorted[i] ?? 0;
  const median = percentile(frameSorted, 0.5);
  return {
    frames,
    medianFrameMs: median,
    p95FrameMs: percentile(frameSorted, 0.95),
    meanFrameMs: total / Math.max(frames, 1),
    medianCpuSubmitMs: percentile(cpuSorted, 0.5),
    fpsFromMedian: 1000 / median,
    jsHeapGrowthPerFrameBytes:
      heapBefore === null || heapAfter === null
        ? null
        : (heapAfter - heapBefore) / Math.max(frames, 1),
  };
}

export function buildResult(
  params: BenchParams,
  backend: BackendInfo,
  summary: CitySceneSummary,
  loadMs: number,
  timings: FrameTimings,
  stats: FrameStats,
  gpuMemory: GpuMemorySnapshot,
): BenchResult {
  const { disclaimer: _disclaimer, ...counts } = summary;
  return {
    params,
    backend,
    summary: counts,
    loadMs,
    timings,
    drawCalls: stats.drawCalls,
    drawnTriangles: stats.triangles,
    gpuMemory,
    jsHeapUsedBytes: jsHeapUsed(),
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency,
  };
}

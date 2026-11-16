import type { FrameStats, IViewerScene } from "@brr/client";
import type { ViewerParams } from "./viewer-params.ts";

export interface FrameTimings {
  readonly frames: number;
  readonly medianFrameMs: number;
  readonly p95FrameMs: number;
  readonly meanFrameMs: number;
  readonly medianCpuSubmitMs: number;
  readonly fpsFromMedian: number;
}

function percentile(sorted: Float64Array, fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

export async function measureFrames(
  scene: IViewerScene,
  params: ViewerParams,
  stats: FrameStats,
): Promise<FrameTimings> {
  for (let i = 0; i < params.warmupFrames; i++) {
    scene.setCamera(i / params.warmupFrames);
    scene.renderFrame(stats);
    await scene.waitForGpu();
  }
  const frameMs = new Float64Array(params.measuredFrames);
  const cpuMs = new Float64Array(params.measuredFrames);
  const started = performance.now();
  let frames = 0;
  while (frames < params.measuredFrames && performance.now() - started < params.maxMeasureMs) {
    const t0 = performance.now();
    scene.setCamera(frames / params.measuredFrames);
    scene.renderFrame(stats);
    const t1 = performance.now();
    await scene.waitForGpu();
    const t2 = performance.now();
    cpuMs[frames] = t1 - t0;
    frameMs[frames] = t2 - t0;
    frames++;
  }
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
  };
}

import type { FrameStats, IViewerScene } from "@brr/client";
import { MIN_SCENE_COVERAGE, type FrameCoverage } from "./frame-coverage.ts";
import type { ViewerParams } from "./viewer-params.ts";

const COVERAGE_SAMPLES = 9;

export interface FrameTimings {
  readonly frames: number;
  readonly medianFrameMs: number;
  readonly p95FrameMs: number;
  readonly meanFrameMs: number;
  readonly medianCpuSubmitMs: number;
  readonly fpsFromMedian: number;
  readonly medianDrawCalls: number;
  readonly medianDrawnTriangles: number;
  readonly sceneCoverage: ReadonlyArray<number>;
}

function percentile(sorted: Float64Array, fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index] ?? Number.NaN;
}

function median(values: Float64Array, count: number): number {
  return percentile(values.slice(0, count).toSorted(), 0.5);
}

function sampleCoverage(
  scene: IViewerScene,
  canvas: HTMLCanvasElement,
  coverage: FrameCoverage,
  stats: FrameStats,
  measuredFrames: number,
): number[] {
  const lastMeasuredPosition = (measuredFrames - 1) / measuredFrames;
  const fractions: number[] = [];
  for (let k = 0; k < COVERAGE_SAMPLES; k++) {
    const t = (lastMeasuredPosition * k) / (COVERAGE_SAMPLES - 1);
    scene.setCamera(t);
    scene.renderFrame(stats);
    const fraction = coverage.sceneFraction(canvas);
    if (fraction < MIN_SCENE_COVERAGE) {
      throw new Error(
        `Measurement rejected: the frame at camera position ${t.toFixed(3)} shows the scene in ${(fraction * 100).toFixed(1)}% of pixels, an essentially empty frame`,
      );
    }
    fractions.push(fraction);
  }
  return fractions;
}

export async function measureFrames(
  scene: IViewerScene,
  params: ViewerParams,
  canvas: HTMLCanvasElement,
  coverage: FrameCoverage,
  stats: FrameStats,
): Promise<FrameTimings> {
  for (let i = 0; i < params.warmupFrames; i++) {
    scene.setCamera(i / params.warmupFrames);
    scene.renderFrame(stats);
    await scene.waitForGpu();
  }
  const frameMs = new Float64Array(params.measuredFrames);
  const cpuMs = new Float64Array(params.measuredFrames);
  const drawCalls = new Float64Array(params.measuredFrames);
  const drawnTriangles = new Float64Array(params.measuredFrames);
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
    drawCalls[frames] = stats.drawCalls;
    drawnTriangles[frames] = stats.triangles;
    frames++;
  }
  const sceneCoverage = sampleCoverage(scene, canvas, coverage, stats, params.measuredFrames);
  const frameSorted = frameMs.slice(0, frames).toSorted();
  let total = 0;
  for (let i = 0; i < frames; i++) total += frameSorted[i] ?? 0;
  const medianFrameMs = percentile(frameSorted, 0.5);
  return {
    frames,
    medianFrameMs,
    p95FrameMs: percentile(frameSorted, 0.95),
    meanFrameMs: total / Math.max(frames, 1),
    medianCpuSubmitMs: median(cpuMs, frames),
    fpsFromMedian: 1000 / medianFrameMs,
    medianDrawCalls: median(drawCalls, frames),
    medianDrawnTriangles: median(drawnTriangles, frames),
    sceneCoverage,
  };
}

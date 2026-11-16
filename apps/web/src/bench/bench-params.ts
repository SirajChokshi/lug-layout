import type { BundleLod, CameraPath, GraphicsApi, InstancingStrategy } from "@brr/client";

export interface BenchParams {
  readonly api: GraphicsApi;
  readonly strategy: InstancingStrategy;
  readonly lod: BundleLod;
  readonly camera: CameraPath;
  readonly parts: number;
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly measure: boolean;
  readonly warmupFrames: number;
  readonly measuredFrames: number;
  readonly maxMeasureMs: number;
}

const DEFAULT_PARTS = 20_000;
const DEFAULT_WARMUP_FRAMES = 20;
const DEFAULT_MEASURED_FRAMES = 120;
const DEFAULT_MAX_MEASURE_MS = 60_000;

function positiveNumber(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return value !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readBenchParams(search: string): BenchParams {
  const params = new URLSearchParams(search);
  return {
    api: params.get("api") === "webgl2" ? "webgl2" : "webgpu",
    strategy: params.get("strategy") === "batched" ? "batched" : "instanced",
    lod: params.get("lod") === "low" ? "low" : "standard",
    camera: params.get("camera") === "street" ? "street" : "aerial",
    parts: positiveNumber(params.get("parts"), DEFAULT_PARTS),
    seed: positiveNumber(params.get("seed"), 1),
    width: positiveNumber(params.get("width"), 0),
    height: positiveNumber(params.get("height"), 0),
    measure: params.get("measure") === "1",
    warmupFrames: positiveNumber(params.get("warmup"), DEFAULT_WARMUP_FRAMES),
    measuredFrames: positiveNumber(params.get("frames"), DEFAULT_MEASURED_FRAMES),
    maxMeasureMs: positiveNumber(params.get("maxMs"), DEFAULT_MAX_MEASURE_MS),
  };
}

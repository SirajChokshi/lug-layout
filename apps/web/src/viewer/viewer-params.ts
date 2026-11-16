import type { BundleLod, GraphicsApi } from "@brr/client";

export interface ViewerParams {
  readonly api: GraphicsApi;
  readonly lod: BundleLod;
  readonly measure: boolean;
  readonly warmupFrames: number;
  readonly measuredFrames: number;
  readonly maxMeasureMs: number;
}

const DEFAULT_WARMUP_FRAMES = 5;
const DEFAULT_MEASURED_FRAMES = 60;
const DEFAULT_MAX_MEASURE_MS = 120_000;

function positiveNumber(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return value !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function readViewerParams(search: string): ViewerParams {
  const params = new URLSearchParams(search);
  return {
    api: params.get("api") === "webgl2" ? "webgl2" : "webgpu",
    lod: params.get("lod") === "low" ? "low" : "standard",
    measure: params.get("measure") === "1",
    warmupFrames: positiveNumber(params.get("warmup"), DEFAULT_WARMUP_FRAMES),
    measuredFrames: positiveNumber(params.get("frames"), DEFAULT_MEASURED_FRAMES),
    maxMeasureMs: positiveNumber(params.get("maxMs"), DEFAULT_MAX_MEASURE_MS),
  };
}

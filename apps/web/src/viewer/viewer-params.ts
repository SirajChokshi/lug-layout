import type { BundleLod, CityCamera, GraphicsApi } from "@brr/client";

export interface ViewerParams {
  readonly api: GraphicsApi;
  readonly lod: BundleLod;
  readonly model: string | null;
  readonly city: boolean;
  readonly parts: number;
  readonly seed: number;
  readonly camera: CityCamera;
  readonly originChunkX: number;
  readonly originChunkZ: number;
  readonly dumpWorld: boolean;
  readonly measure: boolean;
  readonly warmupFrames: number;
  readonly measuredFrames: number;
  readonly maxMeasureMs: number;
}

const DEFAULT_CITY_PARTS = 20_000;
const DEFAULT_SEED = 1;
const DEFAULT_WARMUP_FRAMES = 5;
const DEFAULT_MEASURED_FRAMES = 60;
const DEFAULT_MAX_MEASURE_MS = 120_000;

function positiveNumber(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return value !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function originChunks(value: string | null): readonly [number, number] {
  if (value === null) return [0, 0];
  const [x, z] = value.split(",").map(Number);
  if (x === undefined || z === undefined || !Number.isInteger(x) || !Number.isInteger(z)) {
    throw new Error(`origin=${value} is not two integer chunk coordinates "x,z"`);
  }
  return [x, z];
}

export function readViewerParams(search: string): ViewerParams {
  const params = new URLSearchParams(search);
  const [originChunkX, originChunkZ] = originChunks(params.get("origin"));
  return {
    api: params.get("api") === "webgl2" ? "webgl2" : "webgpu",
    lod: params.get("lod") === "low" ? "low" : "standard",
    model: params.get("model"),
    city: params.get("scene") === "city",
    parts: positiveNumber(params.get("parts"), DEFAULT_CITY_PARTS),
    seed: positiveNumber(params.get("seed"), DEFAULT_SEED),
    camera: params.get("camera") === "street" ? "street" : "aerial",
    originChunkX,
    originChunkZ,
    dumpWorld: params.get("dumpWorld") === "1",
    measure: params.get("measure") === "1",
    warmupFrames: positiveNumber(params.get("warmup"), DEFAULT_WARMUP_FRAMES),
    measuredFrames: positiveNumber(params.get("frames"), DEFAULT_MEASURED_FRAMES),
    maxMeasureMs: positiveNumber(params.get("maxMs"), DEFAULT_MAX_MEASURE_MS),
  };
}

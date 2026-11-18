import {
  DEFAULT_LOOK_FEATURES,
  LOOK_FEATURES,
  type ChunkTier,
  type GraphicsApi,
  type LookFeature,
  type LookSettings,
  type ModelView,
  type PlacementRegion,
} from "@brr/client";
import type { BundleLod } from "@brr/schema/bundle";

export type AppMode = "edit" | "model" | "track" | "import";

export type MeasurePace = "frame" | "tight";

export interface ViewerParams {
  readonly mode: AppMode;
  readonly showEditState: boolean;
  readonly api: GraphicsApi;
  readonly lod: BundleLod;
  readonly model: string | null;
  readonly track: string | null;
  readonly hud: boolean;
  readonly modelView: ModelView;
  readonly tier: ChunkTier | null;
  readonly distanceLdu: number | null;
  readonly zoom: boolean;
  readonly region: PlacementRegion | null;
  readonly measure: boolean;
  readonly warmupFrames: number;
  readonly measuredFrames: number;
  readonly maxMeasureMs: number;
  readonly look: LookSettings;
  readonly pace: MeasurePace;
}

const DEFAULT_WARMUP_FRAMES = 5;
const DEFAULT_MEASURED_FRAMES = 60;
const DEFAULT_MAX_MEASURE_MS = 120_000;

function positiveNumber(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return value !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function placementRegion(value: string | null): PlacementRegion | null {
  if (value === null) return null;
  const bounds = value.split(",").map(Number);
  const [minX, minZ, maxX, maxZ] = bounds;
  if (
    bounds.length !== 4 ||
    minX === undefined ||
    minZ === undefined ||
    maxX === undefined ||
    maxZ === undefined ||
    !bounds.every(Number.isInteger) ||
    minX >= maxX ||
    minZ >= maxZ
  ) {
    throw new Error(`region=${value} is not integer LDU bounds "minX,minZ,maxX,maxZ"`);
  }
  return { minX, minZ, maxX, maxZ };
}

function appMode(params: URLSearchParams): AppMode {
  if (params.get("track") !== null) return "track";
  if (params.get("model") !== null) return "model";
  if (params.get("scene") === "import") return "import";
  return "edit";
}

function isLookFeature(name: string): name is LookFeature {
  return LOOK_FEATURES.some((feature) => feature === name);
}

function lookSettings(value: string | null): LookSettings {
  if (value === null) return lookFrom(new Set(DEFAULT_LOOK_FEATURES));
  const enabled = new Set<LookFeature>(LOOK_FEATURES);
  if (value === "all") return lookFrom(enabled);
  if (value === "none") return lookFrom(new Set());
  const entries = value.split(",").filter((entry) => entry !== "");
  const onlyRemovals = entries.every((entry) => entry.startsWith("-"));
  if (!onlyRemovals) enabled.clear();
  for (const entry of entries) {
    const name = entry.startsWith("-") ? entry.slice(1) : entry;
    if (!isLookFeature(name)) {
      throw new Error(`look=${value}: "${name}" is not one of ${LOOK_FEATURES.join(", ")}`);
    }
    if (entry.startsWith("-")) enabled.delete(name);
    else enabled.add(name);
  }
  return lookFrom(enabled);
}

function lookFrom(enabled: ReadonlySet<LookFeature>): LookSettings {
  return {
    plastic: enabled.has("plastic"),
    gtao: enabled.has("gtao"),
    outlines: enabled.has("outlines"),
    bevel: enabled.has("bevel"),
    shadows: enabled.has("shadows"),
    oit: enabled.has("oit"),
  };
}

function hasPerFramePasses(look: LookSettings): boolean {
  return look.gtao || look.outlines || look.bevel || look.shadows || look.oit;
}

function measurePace(value: string | null, look: LookSettings): MeasurePace {
  if (value === null || value === "frame") return "frame";
  if (value !== "tight") throw new Error(`pace=${value} is not "frame" or "tight"`);
  if (hasPerFramePasses(look)) {
    throw new Error(
      "pace=tight renders frames back to back inside one animation frame, so three.js would not refresh this look's passes and shadow maps; use it only with look=none or look=plastic",
    );
  }
  return "tight";
}

function modelView(params: URLSearchParams): ModelView {
  if (params.get("camera") === "top") return "top";
  return params.get("view") === "below" ? "below" : "orbit";
}

function chunkTier(value: string | null): ChunkTier | null {
  switch (value) {
    case null:
    case "auto":
      return null;
    case "near":
    case "mid":
    case "far":
      return value;
    default:
      throw new Error(`tier=${value} is not one of auto, near, mid, far`);
  }
}

function distance(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`distance=${value} is not a positive number of LDU`);
  }
  return parsed;
}

export function readViewerParams(search: string): ViewerParams {
  const params = new URLSearchParams(search);
  const look = lookSettings(params.get("look"));
  return {
    mode: appMode(params),
    showEditState: params.get("state") === "1",
    api: params.get("api") === "webgl2" ? "webgl2" : "webgpu",
    lod: params.get("lod") === "low" ? "low" : "standard",
    model: params.get("model"),
    track: params.get("track"),
    hud: params.get("hud") !== "0",
    modelView: modelView(params),
    tier: chunkTier(params.get("tier")),
    distanceLdu: distance(params.get("distance")),
    zoom: params.get("zoom") === "1",
    region: placementRegion(params.get("region")),
    measure: params.get("measure") === "1",
    warmupFrames: positiveNumber(params.get("warmup"), DEFAULT_WARMUP_FRAMES),
    measuredFrames: positiveNumber(params.get("frames"), DEFAULT_MEASURED_FRAMES),
    maxMeasureMs: positiveNumber(params.get("maxMs"), DEFAULT_MAX_MEASURE_MS),
    look,
    pace: measurePace(params.get("pace"), look),
  };
}

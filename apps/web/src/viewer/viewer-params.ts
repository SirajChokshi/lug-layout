import {
  DEFAULT_LOOK_FEATURES,
  LOOK_FEATURES,
  type BundleLod,
  type CityCamera,
  type ConsistEntry,
  type GraphicsApi,
  type LookFeature,
  type LookSettings,
  type ModelView,
  type TrainRequest,
} from "@brr/client";

export type AppMode = "edit" | "parts" | "model" | "city" | "track" | "run";

export type MeasurePace = "frame" | "tight";

export interface ViewerParams {
  readonly mode: AppMode;
  readonly showEditState: boolean;
  readonly api: GraphicsApi;
  readonly lod: BundleLod;
  readonly model: string | null;
  readonly track: string | null;
  readonly run: boolean;
  readonly consist: ReadonlyArray<ConsistEntry>;
  readonly trains: ReadonlyArray<TrainRequest>;
  readonly speedLduPerS: number;
  readonly accelerationLduPerS2: number;
  readonly brakingLduPerS2: number;
  readonly follow: boolean;
  readonly followDistanceLdu: number;
  readonly simBenchTicks: number;
  readonly hud: boolean;
  readonly start: boolean;
  readonly autopilotSeed: number | null;
  readonly city: boolean;
  readonly parts: number;
  readonly seed: number;
  readonly camera: CityCamera;
  readonly modelView: ModelView;
  readonly originChunkX: number;
  readonly originChunkZ: number;
  readonly dumpWorld: boolean;
  readonly measure: boolean;
  readonly warmupFrames: number;
  readonly measuredFrames: number;
  readonly maxMeasureMs: number;
  readonly look: LookSettings;
  readonly pace: MeasurePace;
}

const DEFAULT_CITY_PARTS = 20_000;
const DEFAULT_SEED = 1;
const DEFAULT_WARMUP_FRAMES = 5;
const DEFAULT_MEASURED_FRAMES = 60;
const DEFAULT_MAX_MEASURE_MS = 120_000;
const DEFAULT_CONSIST = "10133-1";
const REVERSED_SUFFIX = ":r";
const DEFAULT_TRAINS = "0@0";
const DEFAULT_FOLLOW_DISTANCE_LDU = 1400;
const DEFAULT_SPEED_LDU_PER_S = 400;
const DEFAULT_ACCELERATION_LDU_PER_S2 = 150;
const DEFAULT_BRAKING_LDU_PER_S2 = 300;
const MAX_AUTOPILOT_SEED = 2 ** 32 - 1;
const TRAIN_POSITION = /^(?<edge>\d+)@(?<offset>\d+(?:\.\d+)?)$/u;

function trainRequests(value: string): TrainRequest[] {
  return value.split(";").map((token) => {
    const groups = TRAIN_POSITION.exec(token.trim())?.groups;
    if (groups === undefined) {
      throw new Error(
        `trains=${value}: "${token}" is not a directed edge and offset "edge@offsetLdu"`,
      );
    }
    return { edge: Number(groups["edge"]), offsetLdu: Number(groups["offset"]) };
  });
}

function autopilotSeed(value: string | null): number | null {
  if (value === null) return null;
  const seed = Number(value);
  if (!Number.isInteger(seed) || seed < 1 || seed > MAX_AUTOPILOT_SEED) {
    throw new Error(`autopilot=${value} is not a seed from 1 to ${MAX_AUTOPILOT_SEED}`);
  }
  return seed;
}

function consistEntries(value: string): ConsistEntry[] {
  return value.split(",").map((token) => {
    const trimmed = token.trim();
    const reversed = trimmed.endsWith(REVERSED_SUFFIX);
    const model = reversed ? trimmed.slice(0, -REVERSED_SUFFIX.length) : trimmed;
    if (model.length === 0) throw new Error(`train=${value}: "${token}" names no model`);
    return { model, reversed };
  });
}

function positiveNumber(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return value !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function originChunks(value: string | null): readonly [number, number] {
  if (value === null) return [0, 0];
  const values = value.split(",");
  const [x, z] = values.map((part) => (part.trim() === "" ? Number.NaN : Number(part)));
  if (
    values.length !== 2 ||
    x === undefined ||
    z === undefined ||
    !Number.isInteger(x) ||
    !Number.isInteger(z)
  ) {
    throw new Error(`origin=${value} is not two integer chunk coordinates "x,z"`);
  }
  return [x, z];
}

function appMode(params: URLSearchParams): AppMode {
  const scene = params.get("scene");
  if (scene === "city") return "city";
  if (params.get("track") !== null) return params.get("run") === "1" ? "run" : "track";
  if (params.get("model") !== null) return "model";
  if (scene === "parts") return "parts";
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

export function readViewerParams(search: string): ViewerParams {
  const params = new URLSearchParams(search);
  const look = lookSettings(params.get("look"));
  const [originChunkX, originChunkZ] = originChunks(params.get("origin"));
  return {
    mode: appMode(params),
    showEditState: params.get("state") === "1",
    api: params.get("api") === "webgl2" ? "webgl2" : "webgpu",
    lod: params.get("lod") === "low" ? "low" : "standard",
    model: params.get("model"),
    track: params.get("track"),
    run: params.get("run") === "1",
    consist: consistEntries(params.get("train") ?? DEFAULT_CONSIST),
    trains: trainRequests(params.get("trains") ?? DEFAULT_TRAINS),
    speedLduPerS: positiveNumber(params.get("speed"), DEFAULT_SPEED_LDU_PER_S),
    accelerationLduPerS2: positiveNumber(params.get("accel"), DEFAULT_ACCELERATION_LDU_PER_S2),
    brakingLduPerS2: positiveNumber(params.get("brake"), DEFAULT_BRAKING_LDU_PER_S2),
    follow: params.get("view") === "follow",
    followDistanceLdu: positiveNumber(params.get("follow"), DEFAULT_FOLLOW_DISTANCE_LDU),
    simBenchTicks: positiveNumber(params.get("simBench"), 0),
    hud: params.get("hud") !== "0",
    start: params.get("start") !== "0",
    autopilotSeed: autopilotSeed(params.get("autopilot")),
    city: params.get("scene") === "city",
    parts: positiveNumber(params.get("parts"), DEFAULT_CITY_PARTS),
    seed: positiveNumber(params.get("seed"), DEFAULT_SEED),
    camera: params.get("camera") === "street" ? "street" : "aerial",
    modelView: params.get("camera") === "top" ? "top" : "orbit",
    originChunkX,
    originChunkZ,
    dumpWorld: params.get("dumpWorld") === "1",
    measure: params.get("measure") === "1",
    warmupFrames: positiveNumber(params.get("warmup"), DEFAULT_WARMUP_FRAMES),
    measuredFrames: positiveNumber(params.get("frames"), DEFAULT_MEASURED_FRAMES),
    maxMeasureMs: positiveNumber(params.get("maxMs"), DEFAULT_MAX_MEASURE_MS),
    look,
    pace: measurePace(params.get("pace"), look),
  };
}

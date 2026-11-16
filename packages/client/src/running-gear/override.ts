import type { BakedVehicle, Vec3Tuple, VehicleBogie, VehicleCoupler } from "@brr/catalog";

export const RUNNING_GEAR_OVERRIDE_VERSION = 1;

export interface BogieOverride {
  readonly instances: ReadonlyArray<number>;
  readonly pivot: Vec3Tuple;
}

export interface CouplerOverride {
  readonly instance: number;
  readonly face: Vec3Tuple;
}

export interface VehicleOverride {
  readonly vehicle: number;
  readonly bogies?: ReadonlyArray<BogieOverride>;
  readonly couplers?: ReadonlyArray<CouplerOverride>;
}

export interface RunningGearOverride {
  readonly version: typeof RUNNING_GEAR_OVERRIDE_VERSION;
  readonly modelSha256: string;
  readonly model: string;
  readonly vehicles: ReadonlyArray<VehicleOverride>;
}

export interface EffectiveVehicle {
  readonly vehicle: BakedVehicle | null;
  readonly issues: ReadonlyArray<string>;
}

interface PlanFrame {
  readonly x: number;
  readonly z: number;
  readonly cos: number;
  readonly sin: number;
}

function frameOf(vehicle: BakedVehicle): PlanFrame {
  return {
    x: vehicle.originXLdu,
    z: vehicle.originZLdu,
    cos: Math.cos(vehicle.yawRadians),
    sin: Math.sin(vehicle.yawRadians),
  };
}

export function toModelFrame(vehicle: BakedVehicle, local: Vec3Tuple): Vec3Tuple {
  const f = frameOf(vehicle);
  return [
    f.x + local[0] * f.cos - local[2] * f.sin,
    local[1],
    f.z + local[0] * f.sin + local[2] * f.cos,
  ];
}

function toFrame(f: PlanFrame, model: Vec3Tuple): Vec3Tuple {
  const dx = model[0] - f.x;
  const dz = model[2] - f.z;
  return [dx * f.cos + dz * f.sin, model[1], -dx * f.sin + dz * f.cos];
}

export function vehicleInstances(vehicle: BakedVehicle): ReadonlyArray<number> {
  const all = [...vehicle.body];
  for (const bogie of vehicle.bogies) all.push(...bogie.instances);
  return all.toSorted((a, b) => a - b);
}

export function detectedBogies(vehicle: BakedVehicle): ReadonlyArray<BogieOverride> {
  return vehicle.bogies.map((bogie) => ({
    instances: [...bogie.instances],
    pivot: toModelFrame(vehicle, bogie.pivot),
  }));
}

function along(f: PlanFrame, p: Vec3Tuple): number {
  return (p[0] - f.x) * f.cos + (p[2] - f.z) * f.sin;
}

interface ModelGuides {
  readonly front: Vec3Tuple;
  readonly rear: Vec3Tuple;
}

function chooseGuides(
  detected: PlanFrame,
  pivots: ReadonlyArray<Vec3Tuple>,
  fixed: ReadonlyArray<Vec3Tuple>,
): ModelGuides | string {
  const ordered = (a: Vec3Tuple, b: Vec3Tuple): ModelGuides =>
    along(detected, a) >= along(detected, b) ? { front: a, rear: b } : { front: b, rear: a };
  const [p0, p1] = pivots;
  if (pivots.length === 2 && p0 && p1) return ordered(p0, p1);
  if (pivots.length === 0 && fixed.length >= 2) {
    const sorted = fixed.toSorted((a, b) => along(detected, b) - along(detected, a));
    const front = sorted[0];
    const rear = sorted.at(-1);
    if (front && rear) return { front, rear };
  }
  return `running gear needs two bogies, or no bogies and at least two fixed axles; it has ${pivots.length} bogies and ${fixed.length} fixed axles`;
}

export function effectiveVehicle(
  baked: BakedVehicle,
  override: VehicleOverride | undefined,
): EffectiveVehicle {
  if (!override) return { vehicle: baked, issues: [] };
  const issues: string[] = [];
  const members = new Set(vehicleInstances(baked));
  const bogies = override.bogies ?? detectedBogies(baked);
  const owner = new Map<number, number>();
  bogies.forEach((bogie, b) => {
    for (const instance of bogie.instances) {
      if (!members.has(instance))
        issues.push(`bogie ${b + 1}: part ${instance} is not in this vehicle`);
      else if (owner.has(instance)) issues.push(`part ${instance} is in two bogies`);
      else owner.set(instance, b);
    }
  });
  const wheelsets = baked.wheelsets.map((w) => ({
    instance: w.instance,
    centre: toModelFrame(baked, w.centre),
  }));
  const bogieAxles = bogies.map((_, b) =>
    wheelsets.filter((w) => owner.get(w.instance) === b).map((w) => w.centre),
  );
  bogieAxles.forEach((axles, b) => {
    if (axles.length === 0) issues.push(`bogie ${b + 1} carries no wheelset`);
  });
  const fixed = wheelsets.filter((w) => !owner.has(w.instance)).map((w) => w.centre);
  const detected = frameOf(baked);
  const guides = chooseGuides(
    detected,
    bogies.map((bogie) => bogie.pivot),
    fixed,
  );
  if (typeof guides === "string") issues.push(guides);
  if (issues.length > 0 || typeof guides === "string") return { vehicle: null, issues };
  const yaw = Math.atan2(guides.front[2] - guides.rear[2], guides.front[0] - guides.rear[0]);
  const frame: PlanFrame = {
    x: (guides.front[0] + guides.rear[0]) / 2,
    z: (guides.front[2] + guides.rear[2]) / 2,
    cos: Math.cos(yaw),
    sin: Math.sin(yaw),
  };
  const half = Math.hypot(guides.front[0] - guides.rear[0], guides.front[2] - guides.rear[2]) / 2;
  const faces = new Map((override.couplers ?? []).map((c) => [c.instance, c.face]));
  const couplers: VehicleCoupler[] = [];
  for (const coupler of [baked.frontCoupler, baked.rearCoupler]) {
    if (!coupler) continue;
    const face = faces.get(coupler.instance) ?? toModelFrame(baked, coupler.face);
    couplers.push({
      instance: coupler.instance,
      face: toFrame(frame, face),
      bogie: owner.get(coupler.instance) ?? null,
      obsoleteSources: coupler.obsoleteSources,
    });
  }
  const frontCoupler = couplers.find((c) => c.face[0] > 0) ?? null;
  const rearCoupler = couplers.find((c) => c.face[0] < 0) ?? null;
  if (couplers.length === 2 && (!frontCoupler || !rearCoupler)) {
    return { vehicle: null, issues: ["both coupling faces sit at the same end of the vehicle"] };
  }
  const effectiveBogies: VehicleBogie[] = bogies.map((bogie, b) => ({
    instances: Uint32Array.from(bogie.instances.toSorted((x, y) => x - y)),
    pivot: toFrame(frame, bogie.pivot),
    axles: (bogieAxles[b] ?? []).map((axle) => toFrame(frame, axle)),
  }));
  return {
    vehicle: {
      ...baked,
      originXLdu: frame.x,
      originZLdu: frame.z,
      yawRadians: yaw,
      guideKind: bogies.length === 2 ? "bogiePivot" : "fixedAxle",
      frontGuideLdu: half,
      rearGuideLdu: -half,
      body: Uint32Array.from([...members].filter((i) => !owner.has(i))),
      bogies: effectiveBogies,
      fixedAxles: fixed.map((axle) => toFrame(frame, axle)),
      wheelsets: wheelsets.map((w) => ({ instance: w.instance, centre: toFrame(frame, w.centre) })),
      frontCoupler,
      rearCoupler,
    },
    issues: [],
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function vec3(value: unknown): Vec3Tuple | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const [x, y, z] = value;
  return typeof x === "number" && typeof y === "number" && typeof z === "number" ? [x, y, z] : null;
}

function indices(value: unknown): ReadonlyArray<number> | null {
  if (!Array.isArray(value)) return null;
  return value.every((v) => Number.isInteger(v) && v >= 0) ? (value as number[]) : null;
}

function parseVehicle(value: unknown): VehicleOverride | null {
  const raw = record(value);
  if (!raw || !Number.isInteger(raw["vehicle"])) return null;
  const vehicle = Number(raw["vehicle"]);
  let bogies: BogieOverride[] | undefined;
  if (raw["bogies"] !== undefined) {
    if (!Array.isArray(raw["bogies"])) return null;
    bogies = [];
    for (const entry of raw["bogies"]) {
      const bogie = record(entry);
      const instances = indices(bogie?.["instances"]);
      const pivot = vec3(bogie?.["pivot"]);
      if (!instances || !pivot) return null;
      bogies.push({ instances, pivot });
    }
  }
  let couplers: CouplerOverride[] | undefined;
  if (raw["couplers"] !== undefined) {
    if (!Array.isArray(raw["couplers"])) return null;
    couplers = [];
    for (const entry of raw["couplers"]) {
      const coupler = record(entry);
      const face = vec3(coupler?.["face"]);
      const instance = coupler?.["instance"];
      if (!face || !Number.isInteger(instance)) return null;
      couplers.push({ instance: Number(instance), face });
    }
  }
  return {
    vehicle,
    ...(bogies ? { bogies } : {}),
    ...(couplers ? { couplers } : {}),
  };
}

export function parseRunningGearOverride(value: unknown): RunningGearOverride | null {
  const raw = record(value);
  if (
    !raw ||
    raw["version"] !== RUNNING_GEAR_OVERRIDE_VERSION ||
    typeof raw["modelSha256"] !== "string" ||
    typeof raw["model"] !== "string" ||
    !Array.isArray(raw["vehicles"])
  ) {
    return null;
  }
  const vehicles: VehicleOverride[] = [];
  for (const entry of raw["vehicles"]) {
    const vehicle = parseVehicle(entry);
    if (!vehicle) return null;
    vehicles.push(vehicle);
  }
  return {
    version: RUNNING_GEAR_OVERRIDE_VERSION,
    modelSha256: raw["modelSha256"],
    model: raw["model"],
    vehicles,
  };
}

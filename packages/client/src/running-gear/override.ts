import type { BakedVehicle, Vec3Tuple, VehicleBogie, VehicleCoupler } from "@brr/catalog";
import { runningGearSpanProblem } from "@brr/domain";
import { vehicleSpec } from "../sim/consist.ts";
import { distanceOutside, planBox, unionBox, type PlanBox } from "./instance-boxes.ts";

export const RUNNING_GEAR_OVERRIDE_VERSION = 2;
const MODEL_FRAME_OVERRIDE_VERSION = 1;

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
  readonly version: typeof RUNNING_GEAR_OVERRIDE_VERSION | typeof MODEL_FRAME_OVERRIDE_VERSION;
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
    pivot: [...bogie.pivot],
  }));
}

export function inVehicleFrame(
  override: RunningGearOverride,
  vehicles: ReadonlyArray<BakedVehicle>,
): RunningGearOverride {
  if (override.version === RUNNING_GEAR_OVERRIDE_VERSION) return override;
  return {
    ...override,
    version: RUNNING_GEAR_OVERRIDE_VERSION,
    vehicles: override.vehicles.map((entry) => {
      const vehicle = vehicles[entry.vehicle];
      if (!vehicle) return entry;
      const local = (model: Vec3Tuple): Vec3Tuple => toFrame(frameOf(vehicle), model);
      return {
        vehicle: entry.vehicle,
        ...(entry.bogies
          ? { bogies: entry.bogies.map((b) => ({ ...b, pivot: local(b.pivot) })) }
          : {}),
        ...(entry.couplers
          ? { couplers: entry.couplers.map((c) => ({ ...c, face: local(c.face) })) }
          : {}),
      };
    }),
  };
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
  boxes: Float64Array,
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
  const modelPivots = bogies.map((bogie) => toModelFrame(baked, bogie.pivot));
  const guides = chooseGuides(detected, modelPivots, fixed);
  if (typeof guides === "string") issues.push(guides);
  const faces = new Map((override.couplers ?? []).map((c) => [c.instance, c.face]));
  issues.push(...partBoundsIssues(baked, bogies, faces, boxes));
  if (issues.length > 0 || typeof guides === "string") return { vehicle: null, issues };
  const yaw = Math.atan2(guides.front[2] - guides.rear[2], guides.front[0] - guides.rear[0]);
  const frame: PlanFrame = {
    x: (guides.front[0] + guides.rear[0]) / 2,
    z: (guides.front[2] + guides.rear[2]) / 2,
    cos: Math.cos(yaw),
    sin: Math.sin(yaw),
  };
  const half = Math.hypot(guides.front[0] - guides.rear[0], guides.front[2] - guides.rear[2]) / 2;
  const placed = (coupler: VehicleCoupler | null): VehicleCoupler | null =>
    coupler && {
      instance: coupler.instance,
      face: toFrame(frame, toModelFrame(baked, faces.get(coupler.instance) ?? coupler.face)),
      bogie: owner.get(coupler.instance) ?? null,
      obsoleteSources: coupler.obsoleteSources,
    };
  const frontCoupler = placed(baked.frontCoupler);
  const rearCoupler = placed(baked.rearCoupler);
  const effectiveBogies: VehicleBogie[] = bogies.map((bogie, b) => ({
    instances: Uint32Array.from(bogie.instances.toSorted((x, y) => x - y)),
    pivot: toFrame(frame, modelPivots[b] ?? bogie.pivot),
    axles: (bogieAxles[b] ?? []).map((axle) => toFrame(frame, axle)),
  }));
  const vehicle: BakedVehicle = {
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
  };
  const problem = runningGearProblem(vehicle);
  return problem ? { vehicle: null, issues: [problem] } : { vehicle, issues: [] };
}

function ldu(value: number): string {
  return `${Number(value.toPrecision(3))} LDU`;
}

function boxInFrame(f: PlanFrame, box: PlanBox): PlanBox {
  const corners = [
    toFrame(f, [box.minX, 0, box.minZ]),
    toFrame(f, [box.minX, 0, box.maxZ]),
    toFrame(f, [box.maxX, 0, box.minZ]),
    toFrame(f, [box.maxX, 0, box.maxZ]),
  ];
  return {
    minX: Math.min(...corners.map((c) => c[0])),
    maxX: Math.max(...corners.map((c) => c[0])),
    minZ: Math.min(...corners.map((c) => c[2])),
    maxZ: Math.max(...corners.map((c) => c[2])),
  };
}

function partBoundsIssues(
  baked: BakedVehicle,
  bogies: ReadonlyArray<BogieOverride>,
  faces: ReadonlyMap<number, Vec3Tuple>,
  boxes: Float64Array,
): string[] {
  const detected = frameOf(baked);
  const issues: string[] = [];
  const localBox = (instance: number): PlanBox | null => {
    const box = planBox(boxes, instance);
    return box && boxInFrame(detected, box);
  };
  for (const coupler of [baked.frontCoupler, baked.rearCoupler]) {
    if (!coupler) continue;
    const box = localBox(coupler.instance);
    const face = faces.get(coupler.instance) ?? coupler.face;
    if (!box) issues.push(`part ${coupler.instance} has no box to bound its coupling face`);
    else {
      const outside = distanceOutside(box, face[0], face[2]);
      if (outside > 0) {
        issues.push(
          `the coupling face of part ${coupler.instance} lies ${ldu(outside)} outside that part's box`,
        );
      }
    }
  }
  bogies.forEach((bogie, b) => {
    const parts = bogie.instances.map(localBox);
    if (parts.length === 0) return;
    const footprint = parts.every((box) => box !== null) ? unionBox(parts) : null;
    if (!footprint) {
      issues.push(`bogie ${b + 1} has a part with no box to bound its pivot`);
      return;
    }
    const outside = distanceOutside(footprint, bogie.pivot[0], bogie.pivot[2]);
    if (outside > 0) {
      issues.push(`bogie ${b + 1}'s pivot lies ${ldu(outside)} outside the footprint of its parts`);
    }
  });
  return issues;
}

function runningGearProblem(vehicle: BakedVehicle): string | null {
  const { frontCoupler, rearCoupler } = vehicle;
  if (frontCoupler && rearCoupler) {
    try {
      return runningGearSpanProblem(vehicleSpec(vehicle, false));
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  if (frontCoupler && !(frontCoupler.face[0] > 0)) {
    return `the front coupling face (part ${frontCoupler.instance}) must stay ahead of the midpoint between the guides`;
  }
  if (rearCoupler && !(rearCoupler.face[0] < 0)) {
    return `the rear coupling face (part ${rearCoupler.instance}) must stay behind the midpoint between the guides`;
  }
  return null;
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
    (raw["version"] !== RUNNING_GEAR_OVERRIDE_VERSION &&
      raw["version"] !== MODEL_FRAME_OVERRIDE_VERSION) ||
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
    version: raw["version"],
    modelSha256: raw["modelSha256"],
    model: raw["model"],
    vehicles,
  };
}

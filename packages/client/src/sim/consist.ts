import type { PartModel } from "@brr/catalog";
import type { CouplerGeometry, CouplerMount, GuideGeometry, VehicleGeometry } from "@brr/domain";
import { exactRationalToFloat64, parseExactRational } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import type { ModelRunningGear, ModelVehicle, Vec3, VehicleCoupling } from "@brr/schema/bundle";
import type { VehicleSpec } from "@brr/sim";
import { BOX_FLOATS } from "../edit/local-box.ts";
import { toVehicleFrame } from "../running-gear/vehicle-frame.ts";

export interface RigidBodyInstances {
  readonly instances: Uint32Array;
  readonly matrices: Float32Array;
  readonly transforms: Float64Array;
}

export interface ConsistVehicle {
  readonly model: string;
  readonly vehicle: number;
  readonly reversed: boolean;
  readonly spec: VehicleSpec;
  readonly body: RigidBodyInstances;
  readonly frontBogie: RigidBodyInstances | null;
  readonly rearBogie: RigidBodyInstances | null;
  readonly railTopY: number;
  readonly wheelsets: number;
}

export interface PlannedVehicle {
  readonly vehicle: number;
  readonly spec: VehicleSpec;
}

type End = "front" | "rear";

interface Orientation {
  readonly vehicle: ModelVehicle;
  readonly sign: number;
}

interface PlanePoint {
  readonly x: number;
  readonly z: number;
}

function inPlan({ vehicle, sign }: Orientation, model: Vec3): PlanePoint {
  const [x, , z] = toVehicleFrame(vehicle, model);
  return { x: sign * x, z: sign * z };
}

function guideAt({ vehicle, sign }: Orientation, end: End): ModelVehicle["guides"][number] {
  const [leading, trailing] = sign > 0 ? vehicle.guides : [vehicle.guides[1], vehicle.guides[0]];
  return end === "front" ? leading : trailing;
}

function axleCentre(vehicle: ModelVehicle, wheelset: number): Vec3 {
  const line = vehicle.wheelsets[wheelset]?.axisLine;
  if (!line) throw new Error(`the vehicle has no wheelset ${wheelset}`);
  const [near, far] = line;
  return [(near[0] + far[0]) / 2, (near[1] + far[1]) / 2, (near[2] + far[2]) / 2];
}

function guideBogie(orientation: Orientation, end: End): number | null {
  const guide = guideAt(orientation, end);
  return guide.kind === "bogiePivot" ? guide.bogie : null;
}

function guideGeometry(orientation: Orientation, end: End): GuideGeometry {
  const { vehicle } = orientation;
  const guide = guideAt(orientation, end);
  const bogie = guide.bogie === null ? undefined : vehicle.bogies[guide.bogie];
  if (guide.kind === "bogiePivot" && bogie) {
    const pivot = inPlan(orientation, bogie.pivot);
    const axles = bogie.wheelsets.map((w) => inPlan(orientation, axleCentre(vehicle, w)));
    if (axles.length === 0) throw new Error(`the vehicle's ${end} bogie has no wheelset`);
    return {
      pivotXLdu: pivot.x,
      pivotZLdu: pivot.z,
      leadAxleXLdu: Math.max(...axles.map((axle) => axle.x)),
      trailAxleXLdu: Math.min(...axles.map((axle) => axle.x)),
      axleZLdu: axles.reduce((sum, axle) => sum + axle.z, 0) / axles.length,
      pivots: true,
    };
  }
  if (guide.wheelset === null) throw new Error(`the vehicle's ${end} guide names no wheelset`);
  const axle = inPlan(orientation, axleCentre(vehicle, guide.wheelset));
  return {
    pivotXLdu: axle.x,
    pivotZLdu: axle.z,
    leadAxleXLdu: axle.x,
    trailAxleXLdu: axle.x,
    axleZLdu: axle.z,
    pivots: false,
  };
}

function bogieMount(orientation: Orientation, bogie: number): CouplerMount {
  const pivot = orientation.vehicle.bogies[bogie]?.pivot;
  if (!pivot) throw new Error(`the vehicle has no bogie ${bogie}`);
  return inPlan(orientation, pivot).x > 0 ? "frontBogie" : "rearBogie";
}

function bogieHolding(vehicle: ModelVehicle, instances: ReadonlySet<number>): number | null {
  const index = vehicle.bogies.findIndex((bogie) => bogie.instances.some((i) => instances.has(i)));
  return index < 0 ? null : index;
}

function boundsEnd(orientation: Orientation, boxes: Float64Array, end: End): CouplerGeometry {
  const { vehicle } = orientation;
  const outward = end === "front" ? 1 : -1;
  let extreme = Number.NEGATIVE_INFINITY;
  let holder = -1;
  const consider = (instance: number) => {
    const o = instance * BOX_FLOATS;
    for (const x of [boxes[o] ?? 0, boxes[o + 3] ?? 0]) {
      for (const z of [boxes[o + 2] ?? 0, boxes[o + 5] ?? 0]) {
        const reach = outward * inPlan(orientation, [x, 0, z]).x;
        if (reach > extreme) {
          extreme = reach;
          holder = instance;
        }
      }
    }
  };
  for (const instance of vehicle.body) consider(instance);
  for (const bogie of vehicle.bogies) for (const instance of bogie.instances) consider(instance);
  if (!Number.isFinite(extreme))
    throw new Error(`the vehicle's parts have no bounds at its ${end}`);
  const bogie = bogieHolding(vehicle, new Set([holder]));
  return {
    xLdu: outward * extreme,
    zLdu: 0,
    mount: bogie === null ? "body" : bogieMount(orientation, bogie),
  };
}

function couplingEnd(
  orientation: Orientation,
  coupling: VehicleCoupling,
  pivot: Vec3,
): CouplerGeometry {
  const linked = new Set(
    coupling.mates.flatMap((mate) => [mate.male.instance, mate.female.instance]),
  );
  const bogie = bogieHolding(orientation.vehicle, linked);
  const point = inPlan(orientation, pivot);
  return {
    xLdu: point.x,
    zLdu: point.z,
    mount: bogie === null ? "body" : bogieMount(orientation, bogie),
  };
}

function specOf(
  orientation: Orientation,
  front: CouplerGeometry,
  rear: CouplerGeometry,
): VehicleSpec {
  const geometry: VehicleGeometry = {
    front: guideGeometry(orientation, "front"),
    rear: guideGeometry(orientation, "rear"),
    frontCoupler: front,
    rearCoupler: rear,
  };
  return {
    lengthLdu: front.xLdu - rear.xLdu,
    frontBogieLdu: front.xLdu - geometry.front.pivotXLdu,
    rearBogieLdu: front.xLdu - geometry.rear.pivotXLdu,
    geometry,
  };
}

function travelOrder(vehicles: ReadonlyArray<ModelVehicle>, reversed: boolean): number[] {
  const first = vehicles[0];
  const forwardX = Math.cos(first?.yaw ?? 0);
  const forwardZ = Math.sin(first?.yaw ?? 0);
  return vehicles
    .map((vehicle, index) => ({
      index,
      ahead: vehicle.origin[0] * forwardX + vehicle.origin[1] * forwardZ,
    }))
    .toSorted((a, b) => (reversed ? a.ahead - b.ahead : b.ahead - a.ahead))
    .map(({ index }) => index);
}

function pivotLink(
  couplings: ReadonlyArray<VehicleCoupling>,
  a: number | undefined,
  b: number | undefined,
): { readonly coupling: VehicleCoupling; readonly pivot: Vec3 } | null {
  for (const coupling of couplings) {
    const [x, y] = coupling.vehicles;
    if (coupling.pivot && ((x === a && y === b) || (x === b && y === a))) {
      return { coupling, pivot: coupling.pivot };
    }
  }
  return null;
}

export function plannedConsist(
  gear: ModelRunningGear,
  boxes: Float64Array,
  reversed: boolean,
): ReadonlyArray<PlannedVehicle> {
  const { vehicles, vehicleCouplings } = gear;
  if (vehicles.length === 0) throw new Error("the model has no vehicle");
  const order = travelOrder(vehicles, reversed);
  const sign = reversed ? -1 : 1;
  return order.map((index, k) => {
    const vehicle = vehicles[index];
    if (!vehicle) throw new Error(`the model has no vehicle ${index}`);
    const orientation: Orientation = { vehicle, sign };
    const ahead = pivotLink(vehicleCouplings, order[k - 1], index);
    const behind = pivotLink(vehicleCouplings, index, order[k + 1]);
    return {
      vehicle: index,
      spec: specOf(
        orientation,
        ahead
          ? couplingEnd(orientation, ahead.coupling, ahead.pivot)
          : boundsEnd(orientation, boxes, "front"),
        behind
          ? couplingEnd(orientation, behind.coupling, behind.pivot)
          : boundsEnd(orientation, boxes, "rear"),
      ),
    };
  });
}

function writeLocal(
  source: ArrayLike<number>,
  instances: Uint32Array,
  vehicle: ModelVehicle,
  sign: number,
  pivot: PlanePoint,
  out: Float32Array | Float64Array,
): void {
  const cos = Math.cos(vehicle.yaw);
  const sin = Math.sin(vehicle.yaw);
  for (let k = 0; k < instances.length; k++) {
    const i = (instances[k] ?? 0) * INSTANCE_MATRIX_FLOATS;
    const o = k * INSTANCE_MATRIX_FLOATS;
    for (let col = 0; col < 4; col++) {
      const x = (source[i + col] ?? 0) - (col === 3 ? vehicle.origin[0] : 0);
      const y = source[i + 4 + col] ?? 0;
      const z = (source[i + 8 + col] ?? 0) - (col === 3 ? vehicle.origin[1] : 0);
      out[o + col] = sign * (x * cos + z * sin) - (col === 3 ? pivot.x : 0);
      out[o + 4 + col] = y;
      out[o + 8 + col] = sign * (-x * sin + z * cos) - (col === 3 ? pivot.z : 0);
    }
  }
}

function rigidBody(
  model: Omit<PartModel, "studCover">,
  instances: Uint32Array,
  vehicle: ModelVehicle,
  sign: number,
  pivot: PlanePoint,
): RigidBodyInstances {
  const matrices = new Float32Array(instances.length * INSTANCE_MATRIX_FLOATS);
  const transforms = new Float64Array(instances.length * INSTANCE_MATRIX_FLOATS);
  writeLocal(model.matrices, instances, vehicle, sign, pivot, matrices);
  writeLocal(model.partTransforms, instances, vehicle, sign, pivot, transforms);
  return { instances, matrices, transforms };
}

export interface StandingRemainder {
  readonly vehicle: number;
  readonly body: RigidBodyInstances;
  readonly lowestY: number;
}

const BOX_MIN_Y = 1;
const PLAN_ORIGIN: PlanePoint = { x: 0, z: 0 };

function ridingInstances(vehicles: ReadonlyArray<ModelVehicle>, count: number): Uint8Array {
  const riding = new Uint8Array(count);
  for (const vehicle of vehicles) {
    for (const i of vehicle.body) riding[i] = 1;
    for (const bogie of vehicle.bogies) for (const i of bogie.instances) riding[i] = 1;
  }
  return riding;
}

function planCentre(instances: Uint32Array, boxes: Float64Array): readonly [number, number] {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const i of instances) {
    const b = i * BOX_FLOATS;
    minX = Math.min(minX, boxes[b] ?? 0);
    minZ = Math.min(minZ, boxes[b + 2] ?? 0);
    maxX = Math.max(maxX, boxes[b + 3] ?? 0);
    maxZ = Math.max(maxZ, boxes[b + 5] ?? 0);
  }
  return [(minX + maxX) / 2, (minZ + maxZ) / 2];
}

function nearestVehicle(
  consist: ReadonlyArray<ConsistVehicle>,
  vehicles: ReadonlyArray<ModelVehicle>,
  x: number,
  z: number,
): number {
  let nearest = 0;
  let best = Number.POSITIVE_INFINITY;
  consist.forEach((standing, v) => {
    const origin = vehicles[standing.vehicle]?.origin;
    if (!origin) return;
    const distance = Math.hypot(origin[0] - x, origin[1] - z);
    if (distance < best) {
      best = distance;
      nearest = v;
    }
  });
  return nearest;
}

export function standingRemainder(
  model: Omit<PartModel, "studCover">,
  consist: ReadonlyArray<ConsistVehicle>,
  instanceBoxes: Float64Array,
): StandingRemainder | null {
  const { vehicles } = model.runningGear;
  const riding = ridingInstances(vehicles, model.instanceCount);
  const left: number[] = [];
  for (let i = 0; i < model.instanceCount; i++) if (riding[i] === 0) left.push(i);
  if (left.length === 0) return null;
  const instances = Uint32Array.from(left);
  const [x, z] = planCentre(instances, instanceBoxes);
  const at = nearestVehicle(consist, vehicles, x, z);
  const standing = consist[at];
  const vehicle = standing ? vehicles[standing.vehicle] : undefined;
  if (!standing || !vehicle) throw new Error("a train with parts left over has no vehicle");
  let lowestY = Number.POSITIVE_INFINITY;
  for (const i of instances) {
    lowestY = Math.min(lowestY, instanceBoxes[i * BOX_FLOATS + BOX_MIN_Y] ?? 0);
  }
  return {
    vehicle: at,
    body: rigidBody(model, instances, vehicle, standing.reversed ? -1 : 1, PLAN_ORIGIN),
    lowestY,
  };
}

function seatedWheelsets(vehicle: ModelVehicle): number[] {
  const guides = vehicle.guides.flatMap((guide) =>
    guide.wheelset === null ? [] : [guide.wheelset],
  );
  return [
    ...new Set([...vehicle.fixedAxles, ...vehicle.bogies.flatMap((b) => b.wheelsets), ...guides]),
  ];
}

export function railTopOn(vehicle: ModelVehicle, rail: number): number | null {
  let top = Number.POSITIVE_INFINITY;
  for (const w of seatedWheelsets(vehicle)) {
    const radius = vehicle.wheelsets[w]?.rollingRadiusOnRail[rail] ?? null;
    if (radius === null) return null;
    const axleY = axleCentre(vehicle, w)[1];
    top = Math.min(top, axleY - exactRationalToFloat64(parseExactRational(radius)));
  }
  return Number.isFinite(top) ? top : null;
}

function standingRailTop(vehicle: ModelVehicle, rail: number, label: string): number {
  const top = railTopOn(vehicle, rail);
  if (top === null) {
    throw new Error(`${label} has a wheelset that doesn't meet the rail this track is laid with`);
  }
  return top;
}

export function consistVehicles(
  model: Omit<PartModel, "studCover">,
  name: string,
  reversed: boolean,
  rail: number,
  instanceBoxes: Float64Array,
): ConsistVehicle[] {
  const { vehicles } = model.runningGear;
  if (vehicles.length === 0) throw new Error(`model ${name} has no vehicle`);
  const sign = reversed ? -1 : 1;
  return plannedConsist(model.runningGear, instanceBoxes, reversed).map(
    ({ vehicle: index, spec }) => {
      const vehicle = vehicles[index];
      if (!vehicle) throw new Error(`model ${name} has no vehicle ${index}`);
      const orientation: Orientation = { vehicle, sign };
      const bogieBody = (end: End): RigidBodyInstances | null => {
        const b = guideBogie(orientation, end);
        const bogie = b === null ? undefined : vehicle.bogies[b];
        if (!bogie) return null;
        return rigidBody(
          model,
          Uint32Array.from(bogie.instances),
          vehicle,
          sign,
          inPlan(orientation, bogie.pivot),
        );
      };
      return {
        model: name,
        vehicle: index,
        reversed,
        spec,
        body: rigidBody(model, Uint32Array.from(vehicle.body), vehicle, sign, PLAN_ORIGIN),
        frontBogie: bogieBody("front"),
        rearBogie: bogieBody("rear"),
        railTopY: standingRailTop(vehicle, rail, `Vehicle ${index + 1} of ${name}`),
        wheelsets: seatedWheelsets(vehicle).length,
      };
    },
  );
}

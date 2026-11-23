import type { PartModel, PartVehicle } from "@brr/catalog";
import type { VehicleCoupler } from "@brr/schema/bundle";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import type { CouplerGeometry, CouplerMount, GuideGeometry, VehicleGeometry } from "@brr/domain";
import type { VehicleSpec } from "@brr/sim";
import { BOX_FLOATS } from "../edit/local-box.ts";

export interface RigidBodyInstances {
  readonly instances: Uint32Array;
  readonly matrices: Float32Array;
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

interface Orientation {
  readonly vehicle: PartVehicle;
  readonly sign: number;
}

function along(orientation: Orientation, x: number): number {
  return orientation.sign * x;
}

function couplerAt(orientation: Orientation, end: "front" | "rear"): VehicleCoupler {
  const { vehicle, sign } = orientation;
  const leading = sign > 0 ? vehicle.frontCoupler : vehicle.rearCoupler;
  const trailing = sign > 0 ? vehicle.rearCoupler : vehicle.frontCoupler;
  const coupler = end === "front" ? leading : trailing;
  if (!coupler) throw new Error(`the vehicle has no ${end} coupler, so it cannot join a train`);
  return coupler;
}

function bogieAt(orientation: Orientation, end: "front" | "rear"): number | null {
  const { vehicle } = orientation;
  if (vehicle.guideKind !== "bogiePivot") return null;
  const index = vehicle.bogies.findIndex((bogie) => {
    const x = along(orientation, bogie.pivot[0]);
    return end === "front" ? x > 0 : x < 0;
  });
  if (index < 0) throw new Error(`the vehicle has no ${end} bogie`);
  return index;
}

function guideGeometry(orientation: Orientation, end: "front" | "rear"): GuideGeometry {
  const { vehicle } = orientation;
  const b = bogieAt(orientation, end);
  const bogie = b === null ? undefined : vehicle.bogies[b];
  if (bogie) {
    const xs = bogie.axles.map((axle) => along(orientation, axle[0]));
    const zs = bogie.axles.map((axle) => along(orientation, axle[2]));
    return {
      pivotXLdu: along(orientation, bogie.pivot[0]),
      pivotZLdu: along(orientation, bogie.pivot[2]),
      leadAxleXLdu: Math.max(...xs),
      trailAxleXLdu: Math.min(...xs),
      axleZLdu: zs.reduce((sum, z) => sum + z, 0) / zs.length,
      pivots: true,
    };
  }
  const axles = vehicle.fixedAxles.map((axle) => ({
    x: along(orientation, axle[0]),
    z: along(orientation, axle[2]),
  }));
  const outermost = axles.reduce<{ x: number; z: number } | undefined>(
    (best, axle) =>
      best === undefined || (end === "front" ? axle.x > best.x : axle.x < best.x) ? axle : best,
    undefined,
  );
  if (!outermost) throw new Error(`the vehicle has no ${end} guide`);
  return {
    pivotXLdu: outermost.x,
    pivotZLdu: outermost.z,
    leadAxleXLdu: outermost.x,
    trailAxleXLdu: outermost.x,
    axleZLdu: outermost.z,
    pivots: false,
  };
}

function couplerGeometry(orientation: Orientation, end: "front" | "rear"): CouplerGeometry {
  const coupler = couplerAt(orientation, end);
  const bogie = coupler.bogie === null ? undefined : orientation.vehicle.bogies[coupler.bogie];
  const mount: CouplerMount =
    bogie === undefined
      ? "body"
      : along(orientation, bogie.pivot[0]) > 0
        ? "frontBogie"
        : "rearBogie";
  return {
    xLdu: along(orientation, coupler.face[0]),
    zLdu: along(orientation, coupler.face[2]),
    mount,
  };
}

export function vehicleSpec(vehicle: PartVehicle, reversed: boolean): VehicleSpec {
  const orientation: Orientation = { vehicle, sign: reversed ? -1 : 1 };
  const geometry: VehicleGeometry = {
    front: guideGeometry(orientation, "front"),
    rear: guideGeometry(orientation, "rear"),
    frontCoupler: couplerGeometry(orientation, "front"),
    rearCoupler: couplerGeometry(orientation, "rear"),
  };
  const front = geometry.frontCoupler.xLdu;
  return {
    lengthLdu: front - geometry.rearCoupler.xLdu,
    frontBogieLdu: front - geometry.front.pivotXLdu,
    rearBogieLdu: front - geometry.rear.pivotXLdu,
    geometry,
  };
}

function localMatrices(
  model: Omit<PartModel, "studCover">,
  instances: Uint32Array,
  vehicle: PartVehicle,
  sign: number,
  pivotX: number,
  pivotZ: number,
): Float32Array {
  const cos = Math.cos(vehicle.yaw);
  const sin = Math.sin(vehicle.yaw);
  const out = new Float32Array(instances.length * INSTANCE_MATRIX_FLOATS);
  for (let k = 0; k < instances.length; k++) {
    const i = (instances[k] ?? 0) * INSTANCE_MATRIX_FLOATS;
    const o = k * INSTANCE_MATRIX_FLOATS;
    const m = model.matrices;
    for (let col = 0; col < 4; col++) {
      const x = (m[i + col] ?? 0) - (col === 3 ? vehicle.origin[0] : 0);
      const y = m[i + 4 + col] ?? 0;
      const z = (m[i + 8 + col] ?? 0) - (col === 3 ? vehicle.origin[1] : 0);
      const u = sign * (x * cos + z * sin) - (col === 3 ? pivotX : 0);
      const v = sign * (-x * sin + z * cos) - (col === 3 ? pivotZ : 0);
      out[o + col] = u;
      out[o + 4 + col] = y;
      out[o + 8 + col] = v;
    }
  }
  return out;
}

export interface StandingRemainder {
  readonly vehicle: number;
  readonly body: RigidBodyInstances;
  readonly lowestY: number;
}

const BOX_MIN_Y = 1;

function ridingInstances(vehicles: ReadonlyArray<PartVehicle>, count: number): Uint8Array {
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
  vehicles: ReadonlyArray<PartVehicle>,
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
  vehicles: ReadonlyArray<PartVehicle>,
  instanceBoxes: Float64Array,
): StandingRemainder | null {
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
  const sign = standing.reversed ? -1 : 1;
  return {
    vehicle: at,
    body: { instances, matrices: localMatrices(model, instances, vehicle, sign, 0, 0) },
    lowestY,
  };
}

function railTopFor(vehicle: PartVehicle, railPart: string): number {
  const contact = vehicle.railContacts.find((c) => c.railPart === railPart);
  if (!contact) throw new Error(`the vehicle has no wheel contact measured on rail ${railPart}`);
  return contact.railTopY;
}

export function consistVehicles(
  model: Omit<PartModel, "studCover">,
  name: string,
  reversed: boolean,
  railPart: string,
  vehicles: ReadonlyArray<PartVehicle> = model.vehicles,
): ConsistVehicle[] {
  if (vehicles.length === 0) throw new Error(`model ${name} has no vehicle`);
  const first = vehicles[0];
  const forwardX = Math.cos(first?.yaw ?? 0);
  const forwardZ = Math.sin(first?.yaw ?? 0);
  const order = vehicles
    .map((vehicle, index) => ({
      index,
      ahead: vehicle.origin[0] * forwardX + vehicle.origin[1] * forwardZ,
    }))
    .toSorted((a, b) => (reversed ? a.ahead - b.ahead : b.ahead - a.ahead));
  return order.map(({ index }) => {
    const vehicle = vehicles[index];
    if (!vehicle) throw new Error(`model ${name} has no vehicle ${index}`);
    const sign = reversed ? -1 : 1;
    const orientation: Orientation = { vehicle, sign };
    const bogieBody = (end: "front" | "rear"): RigidBodyInstances | null => {
      const b = bogieAt(orientation, end);
      const bogie = b === null ? undefined : vehicle.bogies[b];
      if (!bogie) return null;
      return {
        instances: bogie.instances,
        matrices: localMatrices(
          model,
          bogie.instances,
          vehicle,
          sign,
          sign * bogie.pivot[0],
          sign * bogie.pivot[2],
        ),
      };
    };
    const wheelsets =
      vehicle.fixedAxles.length +
      vehicle.bogies.reduce((sum, bogie) => sum + bogie.axles.length, 0);
    return {
      model: name,
      vehicle: index,
      reversed,
      spec: vehicleSpec(vehicle, reversed),
      body: {
        instances: vehicle.body,
        matrices: localMatrices(model, vehicle.body, vehicle, sign, 0, 0),
      },
      frontBogie: bogieBody("front"),
      rearBogie: bogieBody("rear"),
      railTopY: railTopFor(vehicle, railPart),
      wheelsets,
    };
  });
}

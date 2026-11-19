import type { ModelRunningGear, PartModel, PartVehicle } from "@brr/catalog";
import type { Vec3, VehicleCoupling } from "@brr/schema/bundle";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import type {
  CouplerGeometry,
  CouplerMount,
  GuideGeometry,
  GuideWheelset,
  VehicleGeometry,
  VehicleSpec,
} from "@brr/sim";
import { BOX_FLOATS } from "../edit/local-box.ts";
import { toVehicleFrame } from "../running-gear/vehicle-frame.ts";

export interface RigidBodyInstances {
  readonly instances: Uint32Array;
  readonly matrices: Float32Array;
}

export interface ConsistVehicle {
  readonly spec: VehicleSpec;
  readonly body: RigidBodyInstances;
  readonly frontBogie: RigidBodyInstances | null;
  readonly rearBogie: RigidBodyInstances | null;
}

export interface PlannedVehicle {
  readonly vehicle: number;
  readonly spec: VehicleSpec;
}

type End = "front" | "rear";

interface PlanePoint {
  readonly x: number;
  readonly z: number;
}

function inPlan(vehicle: PartVehicle, model: Vec3): PlanePoint {
  const [x, , z] = toVehicleFrame(vehicle, model);
  return { x, z };
}

function guideAt(vehicle: PartVehicle, end: End): PartVehicle["guides"][number] {
  const [front, rear] = vehicle.guides;
  return end === "front" ? front : rear;
}

function axlePoint(vehicle: PartVehicle, wheelset: number): PlanePoint {
  const line = vehicle.wheelsets[wheelset]?.axisLine;
  if (!line) throw new Error(`the vehicle has no wheelset ${wheelset}`);
  const [near, far] = line;
  return inPlan(vehicle, [(near[0] + far[0]) / 2, (near[1] + far[1]) / 2, (near[2] + far[2]) / 2]);
}

function guideGeometry(vehicle: PartVehicle, end: End): GuideGeometry {
  const guide = guideAt(vehicle, end);
  const bogie = guide.bogie === null ? undefined : vehicle.bogies[guide.bogie];
  if (guide.kind === "bogiePivot" && bogie) {
    const pivot = inPlan(vehicle, bogie.pivot);
    const axles = bogie.wheelsets.map((w) => axlePoint(vehicle, w));
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
  const axle = axlePoint(vehicle, guide.wheelset);
  return {
    pivotXLdu: axle.x,
    pivotZLdu: axle.z,
    leadAxleXLdu: axle.x,
    trailAxleXLdu: axle.x,
    axleZLdu: axle.z,
    pivots: false,
  };
}

function guideWheelset(vehicle: PartVehicle, end: End): GuideWheelset {
  const guide = guideAt(vehicle, end);
  const rows =
    guide.kind === "bogiePivot" && guide.bogie !== null
      ? (vehicle.bogies[guide.bogie]?.wheelsets ?? [])
      : guide.wheelset === null
        ? []
        : [guide.wheelset];
  const first = rows.toSorted((a, b) => a - b)[0];
  const wheelset = first === undefined ? undefined : vehicle.wheelsets[first];
  if (!wheelset) throw new Error(`the vehicle's ${end} guide has no wheelset`);
  const [near, far] = wheelset.axisLine;
  return { axleYLdu: (near[1] + far[1]) / 2, rollingRadius: wheelset.rollingRadius };
}

function vehicleInstances(vehicle: PartVehicle): Uint32Array {
  const all = [...vehicle.body];
  for (const bogie of vehicle.bogies) all.push(...bogie.instances);
  return Uint32Array.from(all);
}

function boundsEnd(vehicle: PartVehicle, boxes: Float64Array, end: End): CouplerGeometry {
  let extreme = end === "front" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  for (const instance of vehicleInstances(vehicle)) {
    const o = instance * BOX_FLOATS;
    for (const x of [boxes[o] ?? 0, boxes[o + 3] ?? 0]) {
      for (const z of [boxes[o + 2] ?? 0, boxes[o + 5] ?? 0]) {
        const along = inPlan(vehicle, [x, 0, z]).x;
        if (!Number.isFinite(along)) continue;
        extreme = end === "front" ? Math.max(extreme, along) : Math.min(extreme, along);
      }
    }
  }
  if (!Number.isFinite(extreme))
    throw new Error(`the vehicle's parts have no bounds at its ${end}`);
  return { xLdu: extreme, zLdu: 0, mount: "body" };
}

function mountOf(vehicle: PartVehicle, coupling: VehicleCoupling): CouplerMount {
  const linked = new Set(
    coupling.mates.flatMap((mate) => [mate.male.instance, mate.female.instance]),
  );
  const bogie = vehicle.bogies.find((candidate) =>
    candidate.instances.some((instance) => linked.has(instance)),
  );
  if (!bogie) return "body";
  return inPlan(vehicle, bogie.pivot).x > 0 ? "frontBogie" : "rearBogie";
}

function couplingEnd(
  vehicle: PartVehicle,
  coupling: VehicleCoupling,
  pivot: Vec3,
): CouplerGeometry {
  const point = inPlan(vehicle, pivot);
  return { xLdu: point.x, zLdu: point.z, mount: mountOf(vehicle, coupling) };
}

function specOf(vehicle: PartVehicle, front: CouplerGeometry, rear: CouplerGeometry): VehicleSpec {
  const geometry: VehicleGeometry = {
    front: guideGeometry(vehicle, "front"),
    rear: guideGeometry(vehicle, "rear"),
    frontCoupler: front,
    rearCoupler: rear,
  };
  return {
    lengthLdu: front.xLdu - rear.xLdu,
    frontBogieLdu: front.xLdu - geometry.front.pivotXLdu,
    rearBogieLdu: front.xLdu - geometry.rear.pivotXLdu,
    geometry,
    guideWheelsets: {
      front: guideWheelset(vehicle, "front"),
      rear: guideWheelset(vehicle, "rear"),
    },
  };
}

function travelOrder(vehicles: ReadonlyArray<PartVehicle>): number[] {
  const first = vehicles[0];
  const forwardX = Math.cos(first?.yaw ?? 0);
  const forwardZ = Math.sin(first?.yaw ?? 0);
  return vehicles
    .map((vehicle, index) => ({
      index,
      ahead: vehicle.origin[0] * forwardX + vehicle.origin[1] * forwardZ,
    }))
    .toSorted((a, b) => b.ahead - a.ahead)
    .map(({ index }) => index);
}

function sharedPivot(
  couplings: ReadonlyArray<VehicleCoupling>,
  a: number,
  b: number,
): { readonly coupling: VehicleCoupling; readonly pivot: Vec3 } | null {
  for (const coupling of couplings) {
    const [x, y] = coupling.vehicles;
    if (coupling.pivot && ((x === a && y === b) || (x === b && y === a))) {
      return { coupling, pivot: coupling.pivot };
    }
  }
  return null;
}

export function plannedConsists(
  gear: ModelRunningGear,
  boxes: Float64Array,
): ReadonlyArray<ReadonlyArray<PlannedVehicle>> {
  const { vehicles, vehicleCouplings } = gear;
  if (vehicles.length === 0) throw new Error("the model has no vehicle");
  const order = travelOrder(vehicles);
  const consists: PlannedVehicle[][] = [];
  order.forEach((index, k) => {
    const vehicle = vehicles[index];
    if (!vehicle) throw new Error(`the model has no vehicle ${index}`);
    const ahead = k > 0 ? sharedPivot(vehicleCouplings, order[k - 1] ?? -1, index) : null;
    const behind =
      k + 1 < order.length ? sharedPivot(vehicleCouplings, index, order[k + 1] ?? -1) : null;
    const front = ahead
      ? couplingEnd(vehicle, ahead.coupling, ahead.pivot)
      : boundsEnd(vehicle, boxes, "front");
    const rear = behind
      ? couplingEnd(vehicle, behind.coupling, behind.pivot)
      : boundsEnd(vehicle, boxes, "rear");
    const planned = { vehicle: index, spec: specOf(vehicle, front, rear) };
    const current = consists.at(-1);
    if (ahead && current) current.push(planned);
    else consists.push([planned]);
  });
  return consists;
}

function localMatrices(
  model: PartModel,
  instances: Uint32Array,
  vehicle: PartVehicle,
  pivot: PlanePoint,
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
      out[o + col] = x * cos + z * sin - (col === 3 ? pivot.x : 0);
      out[o + 4 + col] = y;
      out[o + 8 + col] = -x * sin + z * cos - (col === 3 ? pivot.z : 0);
    }
  }
  return out;
}

function bogieBody(model: PartModel, vehicle: PartVehicle, end: End): RigidBodyInstances | null {
  const guide = guideAt(vehicle, end);
  const bogie =
    guide.kind === "bogiePivot" && guide.bogie !== null ? vehicle.bogies[guide.bogie] : undefined;
  if (!bogie) return null;
  return {
    instances: bogie.instances,
    matrices: localMatrices(model, bogie.instances, vehicle, inPlan(vehicle, bogie.pivot)),
  };
}

export function consistsOf(model: PartModel, boxes: Float64Array): ConsistVehicle[][] {
  return plannedConsists(model, boxes).map((consist) =>
    consist.map(({ vehicle: index, spec }) => {
      const vehicle = model.vehicles[index];
      if (!vehicle) throw new Error(`the model has no vehicle ${index}`);
      return {
        spec,
        body: {
          instances: vehicle.body,
          matrices: localMatrices(model, vehicle.body, vehicle, { x: 0, z: 0 }),
        },
        frontBogie: bogieBody(model, vehicle, "front"),
        rearBogie: bogieBody(model, vehicle, "rear"),
      };
    }),
  );
}

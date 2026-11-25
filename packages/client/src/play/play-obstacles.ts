import {
  SOLID_BOX_FLOATS,
  SOLID_MATRIX_FLOATS,
  SOLID_TRIANGLE_FLOATS,
  SPOT_DISTANCE,
  posedBoxBounds,
  type PartSolid,
  type StudSolid,
} from "@brr/domain";
import { PLATE_LDU } from "@brr/math";
import type { SimObstacles, SimSolids } from "@brr/sim";
import type { IPartSolids } from "../catalog/part-solids.ts";
import type { ConsistVehicle } from "../sim/consist.ts";
import { rigidBodies } from "../trains/consist-bodies.ts";
import { PosedPlaceable } from "../trains/part-clash.ts";
import type { ObstacleModels } from "../trains/rail-yard.ts";
import type { RailTrack } from "../trains/rail-track.ts";
import type { PlayModel } from "./play-models.ts";

export interface PlayConsist {
  readonly vehicles: ReadonlyArray<ConsistVehicle>;
  readonly vehicleModels: ReadonlyArray<PlayModel>;
}

export interface PlayObstacles {
  readonly obstacles: SimObstacles;
  readonly labels: ReadonlyArray<string>;
}

export interface ObstacleSources {
  readonly consists: ReadonlyArray<PlayConsist>;
  readonly rails: RailTrack;
  readonly models: ObstacleModels;
  readonly solids: IPartSolids;
  readonly loadSolids: (partIndices: ReadonlySet<number>) => Promise<void>;
  readonly partTitle: (partIndex: number) => string;
}

const MAX = 3;
const RIGID_BODY = 0;
const PLAN_CORNERS = 4;

interface VehicleParts {
  readonly start: number[];
  readonly local: number[];
  readonly part: number[];
  readonly rigid: number[];
  readonly lift: number[];
}

function vehicleParts(consists: ReadonlyArray<PlayConsist>, railTopY: number): VehicleParts {
  const parts: VehicleParts = { start: [], local: [], part: [], rigid: [], lift: [] };
  for (const { vehicles, vehicleModels } of consists) {
    vehicles.forEach((vehicle, v) => {
      parts.start.push(parts.part.length);
      const partIndex = vehicleModels[v]?.model.partIndex;
      rigidBodies(vehicle).forEach((rigid, body) => {
        if (!rigid) return;
        for (let k = 0; k < rigid.instances.length; k++) {
          for (let f = 0; f < SOLID_MATRIX_FLOATS; f++) {
            parts.local.push(rigid.transforms[k * SOLID_MATRIX_FLOATS + f] ?? 0);
          }
          parts.part.push(partIndex?.[rigid.instances[k] ?? 0] ?? 0);
          parts.rigid.push(body);
          parts.lift.push(railTopY - vehicle.railTopY);
        }
      });
    });
  }
  parts.start.push(parts.part.length);
  return parts;
}

function frontPivotOffTrack(vehicle: ConsistVehicle): number {
  const front = vehicle.spec.geometry?.front;
  return front ? Math.abs(front.pivotZLdu - front.axleZLdu) : 0;
}

function frontPivot(vehicle: ConsistVehicle): readonly [number, number] {
  const front = vehicle.spec.geometry?.front;
  return front ? [front.pivotXLdu, front.pivotZLdu] : [0, 0];
}

interface Reach {
  plan: number;
  bottom: number;
  top: number;
}

function vehicleReach(
  consists: ReadonlyArray<PlayConsist>,
  parts: VehicleParts,
  solids: IPartSolids,
): Reach {
  const reach: Reach = {
    plan: 0,
    bottom: Number.POSITIVE_INFINITY,
    top: Number.NEGATIVE_INFINITY,
  };
  const box = new Float64Array(SOLID_BOX_FLOATS);
  const local = Float64Array.from(parts.local);
  let v = 0;
  for (const { vehicles } of consists) {
    for (const vehicle of vehicles) {
      const [pivotX, pivotZ] = frontPivot(vehicle);
      const offTrack = frontPivotOffTrack(vehicle);
      for (let e = parts.start[v] ?? 0; e < (parts.start[v + 1] ?? 0); e++) {
        posedBoxBounds(local, e * SOLID_MATRIX_FLOATS, solids.box(parts.part[e] ?? 0), 0, box, 0);
        const fromX = parts.rigid[e] === RIGID_BODY ? pivotX : 0;
        const fromZ = parts.rigid[e] === RIGID_BODY ? pivotZ : 0;
        for (let corner = 0; corner < PLAN_CORNERS; corner++) {
          const x = (corner & 1 ? (box[MAX] ?? 0) : (box[0] ?? 0)) - fromX;
          const z = (corner & 2 ? (box[MAX + 2] ?? 0) : (box[2] ?? 0)) - fromZ;
          reach.plan = Math.max(reach.plan, Math.sqrt(x * x + z * z) + offTrack);
        }
        const lift = parts.lift[e] ?? 0;
        reach.bottom = Math.min(reach.bottom, lift + (box[1] ?? 0));
        reach.top = Math.max(reach.top, lift + (box[MAX + 1] ?? 0));
      }
      v++;
    }
  }
  return reach;
}

interface ModelParts {
  readonly matrices: number[];
  readonly boxes: number[];
  readonly part: number[];
  readonly owner: number[];
  readonly labels: string[];
}

function nearTrack(
  rails: RailTrack,
  box: ArrayLike<number>,
  at: number,
  reach: Reach,
  spot: Float64Array,
): boolean {
  if ((box[at + MAX + 1] ?? 0) <= reach.bottom || (box[at + 1] ?? 0) >= reach.top) return false;
  const halfX = ((box[at + MAX] ?? 0) - (box[at] ?? 0)) / 2;
  const halfZ = ((box[at + MAX + 2] ?? 0) - (box[at + 2] ?? 0)) / 2;
  const centreX = (box[at] ?? 0) + halfX;
  const centreZ = (box[at + 2] ?? 0) + halfZ;
  if (!rails.network.nearest(centreX, centreZ, spot)) return false;
  return (spot[SPOT_DISTANCE] ?? 0) - Math.sqrt(halfX * halfX + halfZ * halfZ) < reach.plan;
}

function modelParts(sources: ObstacleSources, reach: Reach): ModelParts {
  const { rails, models, solids } = sources;
  const parts: ModelParts = { matrices: [], boxes: [], part: [], owner: [], labels: [] };
  const posed = new PosedPlaceable();
  const spot = new Float64Array(3);
  const studReach = solids.studReach();
  for (const model of models.models()) {
    const { box } = model;
    const modelBox = [
      box.minX - studReach,
      box.minY - studReach,
      box.minZ - studReach,
      box.maxX + studReach,
      box.maxY + studReach,
      box.maxZ + studReach,
    ];
    if (!nearTrack(rails, modelBox, 0, reach, spot)) continue;
    const { x, z, yPlates, rot } = model.handle;
    posed.place(model.placeable, x, z, yPlates * PLATE_LDU, rot, solids);
    const carried = models.carriedParts(model.placeable);
    const owner = parts.labels.length;
    let kept = false;
    for (let i = 0; i < posed.count; i++) {
      if (carried.has(i) || !nearTrack(rails, posed.boxes, i * SOLID_BOX_FLOATS, reach, spot)) {
        continue;
      }
      for (let f = 0; f < SOLID_MATRIX_FLOATS; f++) {
        parts.matrices.push(posed.matrices[i * SOLID_MATRIX_FLOATS + f] ?? 0);
      }
      for (let f = 0; f < SOLID_BOX_FLOATS; f++) {
        parts.boxes.push(posed.boxes[i * SOLID_BOX_FLOATS + f] ?? 0);
      }
      parts.part.push(posed.partIndex[i] ?? 0);
      parts.owner.push(owner);
      kept = true;
    }
    if (kept) parts.labels.push(model.placeable.label);
  }
  return parts;
}

function packedSolids(order: ReadonlyArray<number>, solids: IPartSolids): SimSolids {
  const unpacked = order.map((part) => solids.solid(part));
  const primitives: ReadonlyArray<StudSolid> = unpacked[0]?.primitives ?? [];
  const triangleStart = new Int32Array(unpacked.length + 1);
  const studStart = new Int32Array(unpacked.length + 1);
  unpacked.forEach((solid, s) => {
    triangleStart[s + 1] = (triangleStart[s] ?? 0) + solid.triangles.length / SOLID_TRIANGLE_FLOATS;
    studStart[s + 1] = (studStart[s] ?? 0) + solid.studPrimitive.length;
  });
  const boxes = new Float64Array(unpacked.length * SOLID_BOX_FLOATS);
  const bodyTriangles = new Int32Array(unpacked.length);
  const triangles = new Float64Array((triangleStart[unpacked.length] ?? 0) * SOLID_TRIANGLE_FLOATS);
  const studFrames = new Float64Array((studStart[unpacked.length] ?? 0) * SOLID_MATRIX_FLOATS);
  const studPrimitive = new Uint8Array(studStart[unpacked.length] ?? 0);
  unpacked.forEach((solid: PartSolid, s) => {
    boxes.set(solid.box, s * SOLID_BOX_FLOATS);
    bodyTriangles[s] = solid.bodyTriangles;
    triangles.set(solid.triangles, (triangleStart[s] ?? 0) * SOLID_TRIANGLE_FLOATS);
    studFrames.set(solid.studFrames, (studStart[s] ?? 0) * SOLID_MATRIX_FLOATS);
    studPrimitive.set(solid.studPrimitive, studStart[s] ?? 0);
  });
  const primitiveStart = new Int32Array(primitives.length + 1);
  primitives.forEach((primitive, p) => {
    primitiveStart[p + 1] =
      (primitiveStart[p] ?? 0) + primitive.triangles.length / SOLID_TRIANGLE_FLOATS;
  });
  const primitiveBoxes = new Float64Array(primitives.length * SOLID_BOX_FLOATS);
  const primitiveTriangles = new Float64Array(
    (primitiveStart[primitives.length] ?? 0) * SOLID_TRIANGLE_FLOATS,
  );
  primitives.forEach((primitive, p) => {
    primitiveBoxes.set(primitive.box, p * SOLID_BOX_FLOATS);
    primitiveTriangles.set(primitive.triangles, (primitiveStart[p] ?? 0) * SOLID_TRIANGLE_FLOATS);
  });
  return {
    boxes,
    triangleStart,
    bodyTriangles,
    triangles,
    studStart,
    studFrames,
    studPrimitive,
    primitiveStart,
    primitiveBoxes,
    primitiveTriangles,
  };
}

function solidIndex(order: number[], indexOf: Map<number, number>, part: number): number {
  const known = indexOf.get(part);
  if (known !== undefined) return known;
  indexOf.set(part, order.length);
  order.push(part);
  return order.length - 1;
}

export async function playObstacles(sources: ObstacleSources): Promise<PlayObstacles> {
  const { consists, rails, solids } = sources;
  const vehicles = vehicleParts(consists, rails.railTopY);
  const reach = vehicleReach(consists, vehicles, solids);
  const models = modelParts(sources, reach);
  const order: number[] = [];
  const indexOf = new Map<number, number>();
  const vehicleSolid = Int32Array.from(vehicles.part, (part) => solidIndex(order, indexOf, part));
  const modelSolid = Int32Array.from(models.part, (part) => solidIndex(order, indexOf, part));
  await sources.loadSolids(new Set(order));
  const missing = order.find((part) => solids.readiness(part) !== "ready");
  if (missing !== undefined) {
    throw new Error(
      `${sources.partTitle(missing)}'s shape didn't load, so trains can't be checked against models`,
    );
  }
  return {
    obstacles: {
      solids: packedSolids(order, solids),
      modelMatrices: Float64Array.from(models.matrices),
      modelBoxes: Float64Array.from(models.boxes),
      modelSolid,
      modelOwner: Int32Array.from(models.owner),
      vehiclePartStart: Int32Array.from(vehicles.start),
      vehicleLocal: Float64Array.from(vehicles.local),
      vehicleSolid,
      vehicleRigid: Uint8Array.from(vehicles.rigid),
      vehicleLift: Float64Array.from(vehicles.lift),
    },
    labels: models.labels,
  };
}

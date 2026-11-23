import {
  SOLID_BOX_FLOATS,
  SOLID_MATRIX_FLOATS,
  SOLID_TRIANGLE_FLOATS,
  VEHICLE_POSE_FLOATS,
  boxesCross,
  composeAffine,
  posedBoxBounds,
  solidsCross,
  type PartSolid,
  type StudSolid,
} from "@brr/domain";

export interface SimSolids {
  readonly boxes: Float64Array;
  readonly triangleStart: Int32Array;
  readonly bodyTriangles: Int32Array;
  readonly triangles: Float64Array;
  readonly studStart: Int32Array;
  readonly studFrames: Float64Array;
  readonly studPrimitive: Uint8Array;
  readonly primitiveStart: Int32Array;
  readonly primitiveBoxes: Float64Array;
  readonly primitiveTriangles: Float64Array;
}

export interface SimObstacles {
  readonly solids: SimSolids;
  readonly modelMatrices: Float64Array;
  readonly modelBoxes: Float64Array;
  readonly modelSolid: Int32Array;
  readonly modelOwner: Int32Array;
  readonly vehiclePartStart: Int32Array;
  readonly vehicleLocal: Float64Array;
  readonly vehicleSolid: Int32Array;
  readonly vehicleRigid: Uint8Array;
  readonly vehicleLift: Float64Array;
}

export const NO_OWNER = -1;
const MAX = 3;
const AXES = 3;
const RIGID_POSE_FLOATS = 3;

function boxesMeet(a: Float64Array, aAt: number, b: Float64Array, bAt: number): boolean {
  for (let axis = 0; axis < AXES; axis++) {
    if ((a[aAt + MAX + axis] ?? 0) <= (b[bAt + axis] ?? 0)) return false;
    if ((b[bAt + MAX + axis] ?? 0) <= (a[aAt + axis] ?? 0)) return false;
  }
  return true;
}

function unpackedSolids(solids: SimSolids): ReadonlyArray<PartSolid> {
  const primitives: StudSolid[] = [];
  for (let p = 0; p + 1 < solids.primitiveStart.length; p++) {
    const from = (solids.primitiveStart[p] ?? 0) * SOLID_TRIANGLE_FLOATS;
    const to = (solids.primitiveStart[p + 1] ?? 0) * SOLID_TRIANGLE_FLOATS;
    primitives.push({
      box: solids.primitiveBoxes.subarray(p * SOLID_BOX_FLOATS, (p + 1) * SOLID_BOX_FLOATS),
      triangles: solids.primitiveTriangles.subarray(from, to),
    });
  }
  const out: PartSolid[] = [];
  for (let s = 0; s + 1 < solids.triangleStart.length; s++) {
    const studFrom = solids.studStart[s] ?? 0;
    const studTo = solids.studStart[s + 1] ?? 0;
    out.push({
      box: solids.boxes.subarray(s * SOLID_BOX_FLOATS, (s + 1) * SOLID_BOX_FLOATS),
      triangles: solids.triangles.subarray(
        (solids.triangleStart[s] ?? 0) * SOLID_TRIANGLE_FLOATS,
        (solids.triangleStart[s + 1] ?? 0) * SOLID_TRIANGLE_FLOATS,
      ),
      bodyTriangles: solids.bodyTriangles[s] ?? 0,
      studFrames: solids.studFrames.subarray(
        studFrom * SOLID_MATRIX_FLOATS,
        studTo * SOLID_MATRIX_FLOATS,
      ),
      studPrimitive: solids.studPrimitive.subarray(studFrom, studTo),
      primitives,
    });
  }
  return out;
}

export class TrainClearance {
  private readonly solids: ReadonlyArray<PartSolid>;
  private readonly matrices: Float64Array;
  private readonly boxes: Float64Array;
  private readonly bounds = new Float64Array(SOLID_BOX_FLOATS);
  private readonly frame = new Float64Array(SOLID_MATRIX_FLOATS);

  constructor(private readonly obstacles: SimObstacles) {
    this.solids = unpackedSolids(obstacles.solids);
    this.matrices = new Float64Array(obstacles.vehicleSolid.length * SOLID_MATRIX_FLOATS);
    this.boxes = new Float64Array(obstacles.vehicleSolid.length * SOLID_BOX_FLOATS);
  }

  firstOwnerMet(poses: Float64Array, firstVehicle: number, vehicles: number): number {
    const { obstacles } = this;
    const from = obstacles.vehiclePartStart[firstVehicle] ?? 0;
    const to = obstacles.vehiclePartStart[firstVehicle + vehicles] ?? from;
    if (to === from || obstacles.modelOwner.length === 0) return NO_OWNER;
    this.poseVehicleParts(poses, firstVehicle, vehicles);
    for (let m = 0; m < obstacles.modelOwner.length; m++) {
      const mb = m * SOLID_BOX_FLOATS;
      if (!boxesMeet(obstacles.modelBoxes, mb, this.bounds, 0)) continue;
      const modelSolid = this.solids[obstacles.modelSolid[m] ?? 0];
      if (!modelSolid) continue;
      for (let e = from; e < to; e++) {
        if (!boxesMeet(obstacles.modelBoxes, mb, this.boxes, e * SOLID_BOX_FLOATS)) continue;
        const vehicleSolid = this.solids[obstacles.vehicleSolid[e] ?? 0];
        if (!vehicleSolid) continue;
        const mm = m * SOLID_MATRIX_FLOATS;
        const em = e * SOLID_MATRIX_FLOATS;
        if (
          !boxesCross(
            obstacles.modelMatrices,
            mm,
            modelSolid.box,
            0,
            this.matrices,
            em,
            vehicleSolid.box,
            0,
          )
        ) {
          continue;
        }
        if (solidsCross(modelSolid, obstacles.modelMatrices, mm, vehicleSolid, this.matrices, em)) {
          return obstacles.modelOwner[m] ?? NO_OWNER;
        }
      }
    }
    return NO_OWNER;
  }

  private poseVehicleParts(poses: Float64Array, firstVehicle: number, vehicles: number): void {
    const { obstacles, frame, bounds } = this;
    bounds.fill(Number.POSITIVE_INFINITY, 0, MAX);
    bounds.fill(Number.NEGATIVE_INFINITY, MAX, SOLID_BOX_FLOATS);
    for (let v = firstVehicle; v < firstVehicle + vehicles; v++) {
      const base = v * VEHICLE_POSE_FLOATS;
      for (
        let e = obstacles.vehiclePartStart[v] ?? 0;
        e < (obstacles.vehiclePartStart[v + 1] ?? 0);
        e++
      ) {
        const at = base + (obstacles.vehicleRigid[e] ?? 0) * RIGID_POSE_FLOATS;
        const heading = poses[at + 2] ?? 0;
        const cos = Math.cos(heading);
        const sin = Math.sin(heading);
        frame[0] = cos;
        frame[2] = -sin;
        frame[3] = poses[at] ?? 0;
        frame[5] = 1;
        frame[7] = obstacles.vehicleLift[e] ?? 0;
        frame[8] = sin;
        frame[10] = cos;
        frame[11] = poses[at + 1] ?? 0;
        const m = e * SOLID_MATRIX_FLOATS;
        const b = e * SOLID_BOX_FLOATS;
        composeAffine(frame, 0, obstacles.vehicleLocal, m, this.matrices, m);
        const solid = this.solids[obstacles.vehicleSolid[e] ?? 0];
        if (!solid) continue;
        posedBoxBounds(this.matrices, m, solid.box, 0, this.boxes, b);
        for (let axis = 0; axis < AXES; axis++) {
          bounds[axis] = Math.min(bounds[axis] ?? 0, this.boxes[b + axis] ?? 0);
          bounds[MAX + axis] = Math.max(bounds[MAX + axis] ?? 0, this.boxes[b + MAX + axis] ?? 0);
        }
      }
    }
  }
}

import type { PartAsset, TrackPartFrame } from "@brr/catalog";
import { PLAN_TRIANGLE_FLOATS, planTriangleCells, type BaseCells } from "@brr/domain";
import { STUD_LDU, ZETA16_ORDER, zeta16ToStuds, type Pose16 } from "@brr/math";

const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_RADIANS / 2;
const POSITION_FLOATS = 3;

export function localPlanTriangles(part: PartAsset): Float64Array {
  const { positions, groups } = part.mesh;
  let triangles = 0;
  for (const group of groups) triangles += Math.floor(group.indices.length / 3);
  const out = new Float64Array(triangles * PLAN_TRIANGLE_FLOATS);
  let o = 0;
  for (const group of groups) {
    const { indices } = group;
    for (let t = 0; t + 3 <= indices.length; t += 3) {
      for (let k = 0; k < 3; k++) {
        const v = (indices[t + k] ?? 0) * POSITION_FLOATS;
        out[o++] = positions[v] ?? 0;
        out[o++] = positions[v + 2] ?? 0;
      }
    }
  }
  return out;
}

export interface PlanTransform {
  readonly cos: number;
  readonly sin: number;
  readonly x: number;
  readonly z: number;
}

export function trackPlanTransform(placement: Pose16, frame: TrackPartFrame): PlanTransform {
  const studs = zeta16ToStuds(placement.position);
  const theta = placement.heading * HEADING_RADIANS;
  const cosTheta = Math.cos(theta);
  const sinTheta = Math.sin(theta);
  const phi = theta + frame.headingHalfSteps * HALF_STEP_RADIANS;
  return {
    cos: Math.cos(phi),
    sin: Math.sin(phi),
    x: studs.x * STUD_LDU + cosTheta * frame.xLdu - sinTheta * frame.zLdu,
    z: studs.z * STUD_LDU + sinTheta * frame.xLdu + cosTheta * frame.zLdu,
  };
}

export function placedPlanCells(local: Float64Array, transform: PlanTransform): BaseCells {
  const world = new Float64Array(local.length);
  const { cos, sin, x, z } = transform;
  for (let i = 0; i + 1 < local.length; i += 2) {
    const lx = local[i] ?? 0;
    const lz = local[i + 1] ?? 0;
    world[i] = cos * lx - sin * lz + x;
    world[i + 1] = sin * lx + cos * lz + z;
  }
  return planTriangleCells(world);
}

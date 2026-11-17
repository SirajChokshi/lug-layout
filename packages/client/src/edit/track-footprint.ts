import type { TrackPartFrame, TrackPlan } from "@brr/schema/bundle";
import { PLAN_TRIANGLE_FLOATS, planTriangleCells, type BaseCells } from "@brr/domain";
import { STUD_LDU, ZETA16_ORDER, zeta16ToStuds, type Pose16 } from "@brr/math";

const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const PLAN_VERTEX_FLOATS = 2;

export function planTriangles(plan: TrackPlan): Float64Array {
  const { vertices, triangles } = plan;
  const out = new Float64Array((triangles.length / 3) * PLAN_TRIANGLE_FLOATS);
  triangles.forEach((vertex, i) => {
    out[i * PLAN_VERTEX_FLOATS] = vertices[vertex * PLAN_VERTEX_FLOATS] ?? 0;
    out[i * PLAN_VERTEX_FLOATS + 1] = vertices[vertex * PLAN_VERTEX_FLOATS + 1] ?? 0;
  });
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
  return {
    cos: cosTheta,
    sin: sinTheta,
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

import type { TrackPartFrame, TrackPlan } from "@brr/schema/bundle";
import {
  PLAN_TRIANGLE_FLOATS,
  placedPlanCells,
  planTriangleCells,
  type BaseCells,
  type PlaneTransform,
} from "@brr/domain";
import { STUD_LDU, ZETA16_ORDER, zeta16ToStuds, type Pose16 } from "@brr/math";

const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_RADIANS / 2;
const PLAN_VERTEX_FLOATS = 2;
const NO_CLIP_PLANES = new Float64Array(0);

export function planTriangles(plan: TrackPlan): Float64Array {
  const { vertices, triangles } = plan;
  const out = new Float64Array((triangles.length / 3) * PLAN_TRIANGLE_FLOATS);
  triangles.forEach((vertex, i) => {
    out[i * PLAN_VERTEX_FLOATS] = vertices[vertex * PLAN_VERTEX_FLOATS] ?? 0;
    out[i * PLAN_VERTEX_FLOATS + 1] = vertices[vertex * PLAN_VERTEX_FLOATS + 1] ?? 0;
  });
  return out;
}

export function trackPlanTransform(placement: Pose16, frame: TrackPartFrame): PlaneTransform {
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

export function trackPartTransform(placement: Pose16, frame: TrackPartFrame): PlaneTransform {
  const { x, z } = trackPlanTransform(placement, frame);
  const phi = placement.heading * HEADING_RADIANS + frame.headingHalfSteps * HALF_STEP_RADIANS;
  return { cos: Math.cos(phi), sin: Math.sin(phi), x, z };
}

export interface PlacedPlan {
  readonly triangles: Float64Array;
  readonly cells: BaseCells;
  readonly support: BaseCells;
}

export function placedPlan(
  plan: Float64Array,
  support: Float64Array,
  placement: Pose16,
  frame: TrackPartFrame,
): PlacedPlan {
  const transform = trackPlanTransform(placement, frame);
  const world = new Float64Array(plan.length);
  const { cos, sin, x, z } = transform;
  for (let i = 0; i + 1 < plan.length; i += 2) {
    const lx = plan[i] ?? 0;
    const lz = plan[i + 1] ?? 0;
    world[i] = cos * lx - sin * lz + x;
    world[i + 1] = sin * lx + cos * lz + z;
  }
  return {
    triangles: world,
    cells: planTriangleCells(world),
    support: placedPlanCells(support, transform, NO_CLIP_PLANES),
  };
}

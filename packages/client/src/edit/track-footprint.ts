import type { TrackPartFrame, TrackPlan } from "@brr/schema/bundle";
import {
  PLAN_TRIANGLE_FLOATS,
  placedPlanCells,
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

export function supportCells(
  support: Float64Array,
  placement: Pose16,
  frame: TrackPartFrame,
): BaseCells {
  return placedPlanCells(support, trackPlanTransform(placement, frame), NO_CLIP_PLANES);
}

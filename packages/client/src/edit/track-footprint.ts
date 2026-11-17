import type { PartAsset } from "@brr/catalog";
import type { TrackPartFrame } from "@brr/schema/bundle";
import {
  HALF_PLANE_FLOATS,
  PLAN_TRIANGLE_FLOATS,
  placedPlanCells,
  type BaseCells,
  type PlaneTransform,
} from "@brr/domain";
import { STUD_LDU, ZETA16_ORDER, composePose16, zeta16ToStuds, type Pose16 } from "@brr/math";

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

export function trackPlanTransform(placement: Pose16, frame: TrackPartFrame): PlaneTransform {
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

export function connectorSpan(placement: Pose16, connectors: ReadonlyArray<Pose16>): Float64Array {
  const clip = new Float64Array(connectors.length * HALF_PLANE_FLOATS);
  connectors.forEach((connector, i) => {
    const end = composePose16(placement, connector);
    const at = zeta16ToStuds(end.position);
    const outwardX = Math.cos(end.heading * HEADING_RADIANS);
    const outwardZ = Math.sin(end.heading * HEADING_RADIANS);
    const o = i * HALF_PLANE_FLOATS;
    clip[o] = outwardX;
    clip[o + 1] = outwardZ;
    clip[o + 2] = (outwardX * at.x + outwardZ * at.z) * STUD_LDU;
  });
  return clip;
}

export function supportCells(
  local: Float64Array,
  placement: Pose16,
  frame: TrackPartFrame,
  connectors: ReadonlyArray<Pose16>,
): BaseCells {
  return placedPlanCells(
    local,
    trackPlanTransform(placement, frame),
    connectorSpan(placement, connectors),
  );
}

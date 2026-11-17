import type { PartAsset, TrackPartFrame } from "@brr/catalog";
import {
  HALF_PLANE_FLOATS,
  PLAN_TRIANGLE_FLOATS,
  placedPlanCells,
  planTriangleCells,
  type BaseCells,
  type PlaneTransform,
} from "@brr/domain";
import { STUD_LDU, ZETA16_ORDER, composePose16, zeta16ToStuds, type Pose16 } from "@brr/math";

const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_RADIANS / 2;
const POSITION_FLOATS = 3;

function projectedArea2(positions: Float32Array, indices: Uint32Array, t: number): number {
  const a = (indices[t] ?? 0) * POSITION_FLOATS;
  const b = (indices[t + 1] ?? 0) * POSITION_FLOATS;
  const c = (indices[t + 2] ?? 0) * POSITION_FLOATS;
  const ax = positions[a] ?? 0;
  const az = positions[a + 2] ?? 0;
  return (
    ((positions[b] ?? 0) - ax) * ((positions[c + 2] ?? 0) - az) -
    ((positions[b + 2] ?? 0) - az) * ((positions[c] ?? 0) - ax)
  );
}

export function localPlanTriangles(part: PartAsset): Float64Array {
  const { positions, groups } = part.mesh;
  let triangles = 0;
  for (const group of groups) {
    for (let t = 0; t + 3 <= group.indices.length; t += 3) {
      if (projectedArea2(positions, group.indices, t) !== 0) triangles++;
    }
  }
  const out = new Float64Array(triangles * PLAN_TRIANGLE_FLOATS);
  let o = 0;
  for (const group of groups) {
    const { indices } = group;
    for (let t = 0; t + 3 <= indices.length; t += 3) {
      if (projectedArea2(positions, indices, t) === 0) continue;
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

export interface PlacedPlan {
  readonly triangles: Float64Array;
  readonly cells: BaseCells;
  readonly support: BaseCells;
}

export function placedPlan(
  local: Float64Array,
  placement: Pose16,
  frame: TrackPartFrame,
  connectors: ReadonlyArray<Pose16>,
): PlacedPlan {
  const transform = trackPlanTransform(placement, frame);
  const world = new Float64Array(local.length);
  const { cos, sin, x, z } = transform;
  for (let i = 0; i + 1 < local.length; i += 2) {
    const lx = local[i] ?? 0;
    const lz = local[i + 1] ?? 0;
    world[i] = cos * lx - sin * lz + x;
    world[i + 1] = sin * lx + cos * lz + z;
  }
  return {
    triangles: world,
    cells: planTriangleCells(world),
    support: placedPlanCells(local, transform, connectorSpan(placement, connectors)),
  };
}

import type { PartAsset } from "@brr/catalog";
import { CERTIFIED_RESIDUAL_LIMIT_LDU } from "@brr/math";
import {
  AXIS_NEG_X,
  AXIS_NEG_Y,
  AXIS_NEG_Z,
  AXIS_POS_X,
  AXIS_POS_Y,
  AXIS_POS_Z,
  alignmentSpan,
  type HoleEnds,
} from "@brr/domain";
import { INSTANCE_MATRIX_FLOATS, type EdgeMarker } from "@brr/render";
import type { ChunkPartInstances } from "../scene/placements.ts";

export interface ModelHoleEnds extends HoleEnds {
  readonly uncertified: number;
  readonly alignSpanLdu: number;
}

const NO_AXIS = -1;

function identified(value: number): number | null {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) <= CERTIFIED_RESIDUAL_LIMIT_LDU ? rounded + 0 : null;
}

function axisOf(dx: number, dy: number, dz: number): number {
  const ix = identified(dx);
  const iy = identified(dy);
  const iz = identified(dz);
  if (ix === null || iy === null || iz === null) return NO_AXIS;
  if (Math.abs(ix) + Math.abs(iy) + Math.abs(iz) !== 1) return NO_AXIS;
  if (ix !== 0) return ix > 0 ? AXIS_POS_X : AXIS_NEG_X;
  if (iy !== 0) return iy > 0 ? AXIS_POS_Y : AXIS_NEG_Y;
  return iz > 0 ? AXIS_POS_Z : AXIS_NEG_Z;
}

function entry(
  outer: Float32Array,
  o: number,
  row: number,
  inner: Float32Array,
  n: number,
  col: number,
): number {
  const a = (outer[o + row * 4] ?? 0) * (inner[n + col] ?? 0);
  const b = (outer[o + row * 4 + 1] ?? 0) * (inner[n + 4 + col] ?? 0);
  const c = (outer[o + row * 4 + 2] ?? 0) * (inner[n + 8 + col] ?? 0);
  return a + b + c;
}

export function modelHoleEnds(
  instances: ChunkPartInstances,
  parts: ReadonlyArray<PartAsset>,
): ModelHoleEnds {
  let total = 0;
  for (let i = 0; i < instances.count; i++) {
    total +=
      (parts[instances.partIndex[i] ?? 0]?.holeMatrices.length ?? 0) / INSTANCE_MATRIX_FLOATS;
  }
  const x = new Int32Array(total);
  const y = new Int32Array(total);
  const z = new Int32Array(total);
  const axis = new Uint8Array(total);
  let count = 0;
  let uncertified = 0;
  const m = instances.matrices;
  for (let i = 0; i < instances.count; i++) {
    const holes = parts[instances.partIndex[i] ?? 0]?.holeMatrices;
    if (!holes) continue;
    const o = i * INSTANCE_MATRIX_FLOATS;
    for (let n = 0; n < holes.length; n += INSTANCE_MATRIX_FLOATS) {
      const px = identified(entry(m, o, 0, holes, n, 3) + (m[o + 3] ?? 0));
      const py = identified(entry(m, o, 1, holes, n, 3) + (m[o + 7] ?? 0));
      const pz = identified(entry(m, o, 2, holes, n, 3) + (m[o + 11] ?? 0));
      const inward = axisOf(
        -entry(m, o, 0, holes, n, 1),
        -entry(m, o, 1, holes, n, 1),
        -entry(m, o, 2, holes, n, 1),
      );
      if (px === null || py === null || pz === null || inward === NO_AXIS) {
        uncertified++;
        continue;
      }
      x[count] = px;
      y[count] = py;
      z[count] = pz;
      axis[count] = inward;
      count++;
    }
  }
  const ends = {
    count,
    x: x.slice(0, count),
    y: y.slice(0, count),
    z: z.slice(0, count),
    axis: axis.slice(0, count),
  };
  return { ...ends, uncertified, alignSpanLdu: alignmentSpan(ends) };
}

const PIN_POST_HALF_LDU = 4;
const PIN_POST_RISE_LDU = 64;

export function holeMarkers(ends: HoleEnds, joined: Uint8Array): EdgeMarker[] {
  const markers: EdgeMarker[] = [];
  for (let i = 0; i < ends.count; i++) {
    if (joined[i] !== 1) continue;
    const x = ends.x[i] ?? 0;
    const y = ends.y[i] ?? 0;
    const z = ends.z[i] ?? 0;
    markers.push({
      kind: "pin",
      box: {
        minX: x - PIN_POST_HALF_LDU,
        maxX: x + PIN_POST_HALF_LDU,
        minY: y - PIN_POST_HALF_LDU,
        maxY: y + PIN_POST_RISE_LDU,
        minZ: z - PIN_POST_HALF_LDU,
        maxZ: z + PIN_POST_HALF_LDU,
      },
    });
  }
  return markers;
}

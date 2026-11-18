import { ZETA16_ORDER } from "@brr/math";

const OUTLINE_POINT_FLOATS = 2;
const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const REPRESENTATION_LDU = 1e-6;

export interface PlacementFrame {
  readonly xLdu: number;
  readonly zLdu: number;
}

export interface TrackOutlineSource {
  readonly footprints: ArrayLike<number>;
  readonly hull?: ArrayLike<number>;
}

const FOOTPRINT_FLOATS = 4;
const MIN_POLYGON_FLOATS = 3 * OUTLINE_POINT_FLOATS;

function clipped(polygon: ReadonlyArray<number>, a: number, b: number, d: number): number[] {
  const out: number[] = [];
  const count = polygon.length / OUTLINE_POINT_FLOATS;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const px = polygon[2 * i] ?? 0;
    const pz = polygon[2 * i + 1] ?? 0;
    const qx = polygon[2 * j] ?? 0;
    const qz = polygon[2 * j + 1] ?? 0;
    const pInside = d - (a * px + b * pz);
    const qInside = d - (a * qx + b * qz);
    if (pInside >= 0) out.push(px, pz);
    if (pInside >= 0 !== qInside >= 0) {
      const t = pInside / (pInside - qInside);
      out.push(px + t * (qx - px), pz + t * (qz - pz));
    }
  }
  return out;
}

function translated(polygon: ArrayLike<number>, frame: PlacementFrame): Float64Array {
  const outline = Float64Array.from(polygon);
  for (let p = 0; p < outline.length; p += OUTLINE_POINT_FLOATS) {
    outline[p] = (outline[p] ?? 0) + frame.xLdu;
    outline[p + 1] = (outline[p + 1] ?? 0) + frame.zLdu;
  }
  return outline;
}

export function footprintOutline(shape: TrackOutlineSource, frame: PlacementFrame): Float64Array {
  if (shape.hull && shape.hull.length >= MIN_POLYGON_FLOATS) return translated(shape.hull, frame);
  const { footprints } = shape;
  const minX = footprints[0] ?? 0;
  const minZ = footprints[1] ?? 0;
  const maxX = footprints[2] ?? 0;
  const maxZ = footprints[3] ?? 0;
  let polygon = [minX, minZ, maxX, minZ, maxX, maxZ, minX, maxZ];
  for (let heading = 1; heading < ZETA16_ORDER; heading++) {
    const o = heading * FOOTPRINT_FLOATS;
    const c = Math.cos(heading * HEADING_RADIANS);
    const s = Math.sin(heading * HEADING_RADIANS);
    polygon = clipped(polygon, c, -s, footprints[o + 2] ?? 0);
    polygon = clipped(polygon, -c, s, -(footprints[o] ?? 0));
    polygon = clipped(polygon, s, c, footprints[o + 3] ?? 0);
    polygon = clipped(polygon, -s, -c, -(footprints[o + 1] ?? 0));
  }
  return translated(polygon, frame);
}

export function rotateOutline(
  outline: Float64Array,
  headingSteps: number,
  offsetX: number,
  offsetZ: number,
): Float64Array {
  const theta = headingSteps * HEADING_RADIANS;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const rotated = new Float64Array(outline.length);
  for (let p = 0; p < outline.length; p += 2) {
    const x = outline[p] ?? 0;
    const z = outline[p + 1] ?? 0;
    rotated[p] = offsetX + c * x - s * z;
    rotated[p + 1] = offsetZ + s * x + c * z;
  }
  return rotated;
}

function separatedByEdgesOf(
  a: Float64Array,
  ax: number,
  az: number,
  b: Float64Array,
  bx: number,
  bz: number,
): boolean {
  const count = a.length / OUTLINE_POINT_FLOATS;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const ex = (a[2 * j] ?? 0) - (a[2 * i] ?? 0);
    const ez = (a[2 * j + 1] ?? 0) - (a[2 * i + 1] ?? 0);
    const length = Math.hypot(ex, ez);
    if (length === 0) continue;
    const nx = -ez / length;
    const nz = ex / length;
    let minA = Number.POSITIVE_INFINITY;
    let maxA = Number.NEGATIVE_INFINITY;
    for (let p = 0; p < a.length; p += 2) {
      const d = ((a[p] ?? 0) + ax) * nx + ((a[p + 1] ?? 0) + az) * nz;
      if (d < minA) minA = d;
      if (d > maxA) maxA = d;
    }
    let minB = Number.POSITIVE_INFINITY;
    let maxB = Number.NEGATIVE_INFINITY;
    for (let p = 0; p < b.length; p += 2) {
      const d = ((b[p] ?? 0) + bx) * nx + ((b[p + 1] ?? 0) + bz) * nz;
      if (d < minB) minB = d;
      if (d > maxB) maxB = d;
    }
    if (maxA <= minB + REPRESENTATION_LDU || maxB <= minA + REPRESENTATION_LDU) return true;
  }
  return false;
}

export function outlinesOverlap(
  a: Float64Array,
  ax: number,
  az: number,
  b: Float64Array,
  bx: number,
  bz: number,
): boolean {
  return !separatedByEdgesOf(a, ax, az, b, bx, bz) && !separatedByEdgesOf(b, bx, bz, a, ax, az);
}

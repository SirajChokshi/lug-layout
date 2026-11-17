import { ZETA16_ORDER } from "@brr/math";

export const FOOTPRINT_FLOATS = 4;
export const HEADING_FOOTPRINT_FLOATS = ZETA16_ORDER * FOOTPRINT_FLOATS;
const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_RADIANS / 2;

export function headingFootprints(positions: Float32Array, headingHalfSteps: number): Float64Array {
  const boxes = new Float64Array(HEADING_FOOTPRINT_FLOATS);
  for (let heading = 0; heading < ZETA16_ORDER; heading++) {
    const phi = heading * HEADING_RADIANS + headingHalfSteps * HALF_STEP_RADIANS;
    const c = Math.cos(phi);
    const s = Math.sin(phi);
    let minX = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < positions.length; i += 3) {
      const px = positions[i] ?? 0;
      const pz = positions[i + 2] ?? 0;
      const wx = c * px - s * pz;
      const wz = s * px + c * pz;
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wz < minZ) minZ = wz;
      if (wz > maxZ) maxZ = wz;
    }
    const o = heading * FOOTPRINT_FLOATS;
    boxes[o] = minX;
    boxes[o + 1] = minZ;
    boxes[o + 2] = maxX;
    boxes[o + 3] = maxZ;
  }
  return boxes;
}

export function verticalRange(positions: Float32Array): readonly [number, number] {
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (let i = 1; i < positions.length; i += 3) {
    const y = positions[i] ?? 0;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minY, maxY];
}

const HULL_POINT_FLOATS = 2;

function turn(points: Float64Array, a: number, b: number, c: number): number {
  const ax = points[2 * a] ?? 0;
  const az = points[2 * a + 1] ?? 0;
  return (
    ((points[2 * b] ?? 0) - ax) * ((points[2 * c + 1] ?? 0) - az) -
    ((points[2 * b + 1] ?? 0) - az) * ((points[2 * c] ?? 0) - ax)
  );
}

export function convexHull(points: Float64Array): Float64Array {
  const count = points.length / HULL_POINT_FLOATS;
  const order = Array.from({ length: count }, (_v, i) => i).toSorted(
    (a, b) =>
      (points[2 * a] ?? 0) - (points[2 * b] ?? 0) ||
      (points[2 * a + 1] ?? 0) - (points[2 * b + 1] ?? 0),
  );
  const hull: number[] = [];
  const push = (i: number, floor: number): void => {
    while (
      hull.length >= floor + 2 &&
      turn(points, hull[hull.length - 2] ?? 0, hull[hull.length - 1] ?? 0, i) <= 0
    ) {
      hull.pop();
    }
    hull.push(i);
  };
  for (const i of order) push(i, 0);
  const lower = hull.length - 1;
  for (let k = order.length - 2; k >= 0; k--) push(order[k] ?? 0, lower);
  hull.pop();
  return Float64Array.from(hull.flatMap((i) => [points[2 * i] ?? 0, points[2 * i + 1] ?? 0]));
}

export function planHull(positions: Float32Array, headingHalfSteps: number): Float64Array {
  const phi = headingHalfSteps * HALF_STEP_RADIANS;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const points = new Float64Array((positions.length / 3) * HULL_POINT_FLOATS);
  for (let i = 0, p = 0; i < positions.length; i += 3, p += HULL_POINT_FLOATS) {
    const x = positions[i] ?? 0;
    const z = positions[i + 2] ?? 0;
    points[p] = c * x - s * z;
    points[p + 1] = s * x + c * z;
  }
  return convexHull(points);
}

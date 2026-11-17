import { ZETA16_ORDER, zeta16Direction } from "@brr/math";

export const FOOTPRINT_FLOATS = 4;
export const HEADING_FOOTPRINT_FLOATS = ZETA16_ORDER * FOOTPRINT_FLOATS;
const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_RADIANS / 2;

function headingRotation(
  heading: number,
  headingHalfSteps: number,
): { readonly c: number; readonly s: number } {
  const { x: cosTheta, z: sinTheta } = zeta16Direction(heading);
  const offset = headingHalfSteps * HALF_STEP_RADIANS;
  const cosHalf = Math.cos(offset);
  const sinHalf = Math.sin(offset);
  return {
    c: cosTheta * cosHalf - sinTheta * sinHalf,
    s: sinTheta * cosHalf + cosTheta * sinHalf,
  };
}

export function headingFootprints(positions: Float32Array, headingHalfSteps: number): Float64Array {
  const boxes = new Float64Array(HEADING_FOOTPRINT_FLOATS);
  for (let heading = 0; heading < ZETA16_ORDER; heading++) {
    const { c, s } = headingRotation(heading, headingHalfSteps);
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

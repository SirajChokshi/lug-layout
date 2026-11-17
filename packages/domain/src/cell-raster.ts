import { STUD_LDU } from "@brr/math";
import type { BaseCells } from "./support.ts";

export const REPRESENTATION_EPSILON_LDU = 1e-6;
export const PLAN_TRIANGLE_FLOATS = 6;
const CELL_KEY_OFFSET = 2 ** 25;
const CELL_KEY_STRIDE = 2 ** 26;

function packCell(cellX: number, cellZ: number): number {
  if (Math.abs(cellX) >= CELL_KEY_OFFSET || Math.abs(cellZ) >= CELL_KEY_OFFSET) {
    throw new RangeError(`cell (${cellX}, ${cellZ}) is outside ±${CELL_KEY_OFFSET} studs`);
  }
  return (cellX + CELL_KEY_OFFSET) * CELL_KEY_STRIDE + (cellZ + CELL_KEY_OFFSET);
}

function separatedOnAxis(
  ax: number,
  az: number,
  tri: Float64Array,
  o: number,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): boolean {
  let triLo = Number.POSITIVE_INFINITY;
  let triHi = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < 3; k++) {
    const p = ax * (tri[o + 2 * k] ?? 0) + az * (tri[o + 2 * k + 1] ?? 0);
    if (p < triLo) triLo = p;
    if (p > triHi) triHi = p;
  }
  const c0 = ax * minX + az * minZ;
  const c1 = ax * maxX + az * minZ;
  const c2 = ax * minX + az * maxZ;
  const c3 = ax * maxX + az * maxZ;
  const boxLo = Math.min(c0, c1, c2, c3);
  const boxHi = Math.max(c0, c1, c2, c3);
  return Math.max(triLo, boxLo) >= Math.min(triHi, boxHi);
}

function overlapsCellInterior(tri: Float64Array, o: number, cellX: number, cellZ: number): boolean {
  const minX = cellX * STUD_LDU + REPRESENTATION_EPSILON_LDU;
  const minZ = cellZ * STUD_LDU + REPRESENTATION_EPSILON_LDU;
  const maxX = (cellX + 1) * STUD_LDU - REPRESENTATION_EPSILON_LDU;
  const maxZ = (cellZ + 1) * STUD_LDU - REPRESENTATION_EPSILON_LDU;
  if (separatedOnAxis(1, 0, tri, o, minX, minZ, maxX, maxZ)) return false;
  if (separatedOnAxis(0, 1, tri, o, minX, minZ, maxX, maxZ)) return false;
  for (let k = 0; k < 3; k++) {
    const next = (k + 1) % 3;
    const ex = (tri[o + 2 * next] ?? 0) - (tri[o + 2 * k] ?? 0);
    const ez = (tri[o + 2 * next + 1] ?? 0) - (tri[o + 2 * k + 1] ?? 0);
    if (ex === 0 && ez === 0) continue;
    if (separatedOnAxis(-ez, ex, tri, o, minX, minZ, maxX, maxZ)) return false;
  }
  return true;
}

export function planTriangleCells(triangles: Float64Array): BaseCells {
  const keys = new Set<number>();
  for (let o = 0; o + PLAN_TRIANGLE_FLOATS <= triangles.length; o += PLAN_TRIANGLE_FLOATS) {
    let minX = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < 3; k++) {
      const x = triangles[o + 2 * k] ?? 0;
      const z = triangles[o + 2 * k + 1] ?? 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const x0 = Math.floor(minX / STUD_LDU);
    const x1 = Math.floor(maxX / STUD_LDU);
    const z0 = Math.floor(minZ / STUD_LDU);
    const z1 = Math.floor(maxZ / STUD_LDU);
    for (let cz = z0; cz <= z1; cz++) {
      for (let cx = x0; cx <= x1; cx++) {
        const key = packCell(cx, cz);
        if (keys.has(key)) continue;
        if (overlapsCellInterior(triangles, o, cx, cz)) keys.add(key);
      }
    }
  }
  const sorted = Float64Array.from(keys);
  sorted.sort();
  const cellX = new Int32Array(sorted.length);
  const cellZ = new Int32Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) {
    const key = sorted[i] ?? 0;
    cellX[i] = Math.floor(key / CELL_KEY_STRIDE) - CELL_KEY_OFFSET;
    cellZ[i] = (key % CELL_KEY_STRIDE) - CELL_KEY_OFFSET;
  }
  return { count: sorted.length, cellX, cellZ, flat: new Uint8Array(sorted.length) };
}

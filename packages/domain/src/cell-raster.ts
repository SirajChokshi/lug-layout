import { STUD_LDU } from "@brr/math";
import type { BaseCells } from "./support.ts";

export const REPRESENTATION_EPSILON_LDU = 1e-6;
export const PLAN_TRIANGLE_FLOATS = 6;
export const HALF_PLANE_FLOATS = 3;
const CELL_KEY_OFFSET = 2 ** 25;
const CELL_KEY_STRIDE = 2 ** 26;
const INITIAL_SET_CAPACITY = 1024;
const MAX_POLYGON_POINTS = 64;

export interface PlaneTransform {
  readonly cos: number;
  readonly sin: number;
  readonly x: number;
  readonly z: number;
}

const IDENTITY_PLACEMENT: PlaneTransform = { cos: 1, sin: 0, x: 0, z: 0 };
const NO_CLIP = new Float64Array(0);

function packCell(cellX: number, cellZ: number): number {
  if (Math.abs(cellX) >= CELL_KEY_OFFSET || Math.abs(cellZ) >= CELL_KEY_OFFSET) {
    throw new RangeError(`cell (${cellX}, ${cellZ}) is outside ±${CELL_KEY_OFFSET} studs`);
  }
  return (cellX + CELL_KEY_OFFSET) * CELL_KEY_STRIDE + (cellZ + CELL_KEY_OFFSET);
}

class CellSet {
  private keys = new Float64Array(INITIAL_SET_CAPACITY);
  private stamps = new Uint32Array(INITIAL_SET_CAPACITY);
  private order = new Float64Array(INITIAL_SET_CAPACITY / 2);
  private generation = 1;
  size = 0;

  clear(): void {
    this.size = 0;
    this.generation++;
    if (this.generation === 0xffff_ffff) {
      this.stamps.fill(0);
      this.generation = 1;
    }
  }

  has(key: number): boolean {
    const slot = this.slotOf(key);
    return this.stamps[slot] === this.generation;
  }

  add(key: number): void {
    if ((this.size + 1) * 2 > this.keys.length) this.grow();
    const slot = this.slotOf(key);
    if (this.stamps[slot] === this.generation) return;
    this.keys[slot] = key;
    this.stamps[slot] = this.generation;
    this.order[this.size++] = key;
  }

  sortedKeys(): Float64Array {
    const sorted = this.order.subarray(0, this.size);
    sorted.sort();
    return sorted;
  }

  private slotOf(key: number): number {
    const mask = this.keys.length - 1;
    let slot = (Math.floor(key) ^ Math.floor(key / CELL_KEY_STRIDE)) & mask;
    while (this.stamps[slot] === this.generation && this.keys[slot] !== key) {
      slot = (slot + 1) & mask;
    }
    return slot;
  }

  private grow(): void {
    const kept = this.order.slice(0, this.size);
    const capacity = this.keys.length * 2;
    this.keys = new Float64Array(capacity);
    this.stamps = new Uint32Array(capacity);
    this.order = new Float64Array(capacity / 2);
    this.generation = 1;
    this.size = 0;
    for (let i = 0; i < kept.length; i++) this.add(kept[i] ?? 0);
  }
}

const cellSet = new CellSet();
const polygonA = new Float64Array(MAX_POLYGON_POINTS * 2);
const polygonB = new Float64Array(MAX_POLYGON_POINTS * 2);
const fan = new Float64Array(PLAN_TRIANGLE_FLOATS);

function separatedOnAxis(
  ax: number,
  az: number,
  tri: Float64Array,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): boolean {
  let triLo = Number.POSITIVE_INFINITY;
  let triHi = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < 3; k++) {
    const p = ax * (tri[2 * k] ?? 0) + az * (tri[2 * k + 1] ?? 0);
    if (p < triLo) triLo = p;
    if (p > triHi) triHi = p;
  }
  const c0 = ax * minX + az * minZ;
  const c1 = ax * maxX + az * minZ;
  const c2 = ax * minX + az * maxZ;
  const c3 = ax * maxX + az * maxZ;
  return Math.max(triLo, Math.min(c0, c1, c2, c3)) >= Math.min(triHi, Math.max(c0, c1, c2, c3));
}

function overlapsCellInterior(tri: Float64Array, cellX: number, cellZ: number): boolean {
  const minX = cellX * STUD_LDU + REPRESENTATION_EPSILON_LDU;
  const minZ = cellZ * STUD_LDU + REPRESENTATION_EPSILON_LDU;
  const maxX = (cellX + 1) * STUD_LDU - REPRESENTATION_EPSILON_LDU;
  const maxZ = (cellZ + 1) * STUD_LDU - REPRESENTATION_EPSILON_LDU;
  if (separatedOnAxis(1, 0, tri, minX, minZ, maxX, maxZ)) return false;
  if (separatedOnAxis(0, 1, tri, minX, minZ, maxX, maxZ)) return false;
  for (let k = 0; k < 3; k++) {
    const next = (k + 1) % 3;
    const ex = (tri[2 * next] ?? 0) - (tri[2 * k] ?? 0);
    const ez = (tri[2 * next + 1] ?? 0) - (tri[2 * k + 1] ?? 0);
    if (ex === 0 && ez === 0) continue;
    if (separatedOnAxis(-ez, ex, tri, minX, minZ, maxX, maxZ)) return false;
  }
  return true;
}

function addTriangleCells(tri: Float64Array): void {
  const minX = Math.min(tri[0] ?? 0, tri[2] ?? 0, tri[4] ?? 0);
  const maxX = Math.max(tri[0] ?? 0, tri[2] ?? 0, tri[4] ?? 0);
  const minZ = Math.min(tri[1] ?? 0, tri[3] ?? 0, tri[5] ?? 0);
  const maxZ = Math.max(tri[1] ?? 0, tri[3] ?? 0, tri[5] ?? 0);
  const x1 = Math.floor(maxX / STUD_LDU);
  const z1 = Math.floor(maxZ / STUD_LDU);
  for (let cz = Math.floor(minZ / STUD_LDU); cz <= z1; cz++) {
    for (let cx = Math.floor(minX / STUD_LDU); cx <= x1; cx++) {
      const key = packCell(cx, cz);
      if (!cellSet.has(key) && overlapsCellInterior(tri, cx, cz)) cellSet.add(key);
    }
  }
}

function clipPolygon(
  source: Float64Array,
  count: number,
  nx: number,
  nz: number,
  limit: number,
  target: Float64Array,
): number {
  let out = 0;
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const ax = source[2 * i] ?? 0;
    const az = source[2 * i + 1] ?? 0;
    const bx = source[2 * j] ?? 0;
    const bz = source[2 * j + 1] ?? 0;
    const da = nx * ax + nz * az - limit;
    const db = nx * bx + nz * bz - limit;
    if (da <= 0 && out < MAX_POLYGON_POINTS) {
      target[2 * out] = ax;
      target[2 * out + 1] = az;
      out++;
    }
    if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
      const t = da / (da - db);
      if (out < MAX_POLYGON_POINTS) {
        target[2 * out] = ax + t * (bx - ax);
        target[2 * out + 1] = az + t * (bz - az);
        out++;
      }
    }
  }
  return out;
}

export function placedPlanCells(
  local: Float64Array,
  placement: PlaneTransform,
  clip: Float64Array,
): BaseCells {
  cellSet.clear();
  const { cos, sin, x, z } = placement;
  for (let o = 0; o + PLAN_TRIANGLE_FLOATS <= local.length; o += PLAN_TRIANGLE_FLOATS) {
    for (let k = 0; k < 3; k++) {
      const lx = local[o + 2 * k] ?? 0;
      const lz = local[o + 2 * k + 1] ?? 0;
      polygonA[2 * k] = cos * lx - sin * lz + x;
      polygonA[2 * k + 1] = sin * lx + cos * lz + z;
    }
    let count = 3;
    let source = polygonA;
    let target = polygonB;
    for (let h = 0; h + HALF_PLANE_FLOATS <= clip.length && count >= 3; h += HALF_PLANE_FLOATS) {
      count = clipPolygon(source, count, clip[h] ?? 0, clip[h + 1] ?? 0, clip[h + 2] ?? 0, target);
      const swap = source;
      source = target;
      target = swap;
    }
    for (let k = 1; k + 1 < count; k++) {
      fan[0] = source[0] ?? 0;
      fan[1] = source[1] ?? 0;
      fan[2] = source[2 * k] ?? 0;
      fan[3] = source[2 * k + 1] ?? 0;
      fan[4] = source[2 * k + 2] ?? 0;
      fan[5] = source[2 * k + 3] ?? 0;
      addTriangleCells(fan);
    }
  }
  const sorted = cellSet.sortedKeys();
  const cellX = new Int32Array(sorted.length);
  const cellZ = new Int32Array(sorted.length);
  for (let i = 0; i < sorted.length; i++) {
    const key = sorted[i] ?? 0;
    cellX[i] = Math.floor(key / CELL_KEY_STRIDE) - CELL_KEY_OFFSET;
    cellZ[i] = (key % CELL_KEY_STRIDE) - CELL_KEY_OFFSET;
  }
  return { count: sorted.length, cellX, cellZ, flat: new Uint8Array(sorted.length) };
}

export function planTriangleCells(triangles: Float64Array): BaseCells {
  return placedPlanCells(triangles, IDENTITY_PLACEMENT, NO_CLIP);
}

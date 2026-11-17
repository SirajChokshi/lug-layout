import type { PartAsset } from "@brr/catalog";
import type { Vec3 } from "@brr/schema/bundle";
import { CHUNK_LDU, STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import { Unplaceable } from "./unplaceable.ts";

export interface GroundFootprint {
  readonly topY: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly plates: number;
}

export interface GroundInstances {
  readonly count: number;
  readonly partIndex: Uint16Array;
  readonly matrices: Float32Array;
}

interface PlateBox {
  readonly min: Vec3;
  readonly max: Vec3;
}

function plateBox(matrices: Float32Array, instance: number, body: PlateBox): PlateBox {
  const o = instance * INSTANCE_MATRIX_FLOATS;
  const min: number[] = [];
  const max: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    let lo = matrices[o + axis * 4 + 3] ?? 0;
    let hi = lo;
    for (let k = 0; k < 3; k++) {
      const coefficient = matrices[o + axis * 4 + k] ?? 0;
      const a = coefficient * (body.min[k] ?? 0);
      const b = coefficient * (body.max[k] ?? 0);
      lo += Math.min(a, b);
      hi += Math.max(a, b);
    }
    min.push(lo + 0);
    max.push(hi + 0);
  }
  return {
    min: [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0],
    max: [max[0] ?? 0, max[1] ?? 0, max[2] ?? 0],
  };
}

export function groundFootprint(
  instances: GroundInstances,
  parts: ReadonlyArray<PartAsset>,
): GroundFootprint | null {
  const boxes: PlateBox[] = [];
  for (let i = 0; i < instances.count; i++) {
    const part = parts[instances.partIndex[i] ?? 0];
    if (part?.baseplate) {
      boxes.push(plateBox(instances.matrices, i, { min: part.boundsMin, max: part.boundsMax }));
    }
  }
  if (boxes.length === 0) return null;
  const topY = Math.min(...boxes.map((box) => box.max[1]));
  const first = boxes.filter((box) => box.max[1] === topY);
  const minX = Math.min(...first.map((box) => box.min[0]));
  const maxX = Math.max(...first.map((box) => box.max[0]));
  const minZ = Math.min(...first.map((box) => box.min[2]));
  const maxZ = Math.max(...first.map((box) => box.max[2]));
  return { topY, minX, maxX, minZ, maxZ, plates: first.length };
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

export interface SeatGrid {
  readonly x: number;
  readonly z: number;
}

export function sideGrid(side: number): number {
  if (!Number.isInteger(side / STUD_LDU) || side <= 0) {
    throw new Unplaceable(
      `its baseplate outline is ${side} LDU across, not a whole number of studs`,
    );
  }
  return greatestCommonDivisor(CHUNK_LDU, side);
}

export function seatGrid(ground: GroundFootprint): SeatGrid {
  return { x: sideGrid(ground.maxX - ground.minX), z: sideGrid(ground.maxZ - ground.minZ) };
}

export function rotatedGrid(grid: SeatGrid, rot: number): SeatGrid {
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  return rot % 2 === 0 ? grid : { x: grid.z, z: grid.x };
}

export function pivotOnGrid(min: number, side: number, grid: number): number {
  return min + Math.round(side / 2 / grid) * grid;
}

export function snapToGrid(ldu: number, grid: number): number {
  return Math.round(ldu / grid) * grid + 0;
}

export interface SeatedGround {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly plates: number;
  readonly grid: SeatGrid;
}

export interface WorldGround {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly topY: number;
}

export function worldGround(
  ground: SeatedGround,
  x: number,
  yLdu: number,
  z: number,
  rot: number,
): WorldGround {
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const ax = x + cos * ground.minX + sin * ground.minZ;
  const az = z - sin * ground.minX + cos * ground.minZ;
  const bx = x + cos * ground.maxX + sin * ground.maxZ;
  const bz = z - sin * ground.maxX + cos * ground.maxZ;
  return {
    minX: Math.min(ax, bx) + 0,
    maxX: Math.max(ax, bx) + 0,
    minZ: Math.min(az, bz) + 0,
    maxZ: Math.max(az, bz) + 0,
    topY: yLdu,
  };
}

interface AxisSpan {
  readonly min: number;
  readonly max: number;
}

function overlapsAcross(a: AxisSpan, b: AxisSpan, reach: number): boolean {
  return a.min < b.max + reach && b.min < a.max + reach;
}

function flushMins(edges: AxisSpan, side: number): ReadonlyArray<number> {
  return [edges.max, edges.min - side, edges.min, edges.max - side];
}

function nearest(wanted: number, candidates: ReadonlyArray<number>): number {
  let best = candidates[0] ?? wanted;
  for (const candidate of candidates) {
    if (Math.abs(candidate - wanted) < Math.abs(best - wanted)) best = candidate;
  }
  return best;
}

export function snapOutline(
  ground: SeatedGround,
  x: number,
  z: number,
  rot: number,
  neighbours: ReadonlyArray<WorldGround>,
): { readonly x: number; readonly z: number } {
  const corner = worldGround(ground, 0, 0, 0, rot);
  const grid = rotatedGrid(ground.grid, rot);
  const sideX = corner.maxX - corner.minX;
  const sideZ = corner.maxZ - corner.minZ;
  const minX = x + corner.minX;
  const minZ = z + corner.minZ;
  const spanX = { min: minX, max: minX + sideX };
  const spanZ = { min: minZ, max: minZ + sideZ };
  const xs = [snapToGrid(minX, grid.x)];
  const zs = [snapToGrid(minZ, grid.z)];
  for (const n of neighbours) {
    if (overlapsAcross(spanZ, { min: n.minZ, max: n.maxZ }, grid.z)) {
      xs.push(...flushMins({ min: n.minX, max: n.maxX }, sideX));
    }
    if (overlapsAcross(spanX, { min: n.minX, max: n.maxX }, grid.x)) {
      zs.push(...flushMins({ min: n.minZ, max: n.maxZ }, sideZ));
    }
  }
  return { x: nearest(minX, xs) - corner.minX, z: nearest(minZ, zs) - corner.minZ };
}

function seatedOnAxis(
  min: number,
  side: number,
  grid: number,
  edges: ReadonlyArray<AxisSpan>,
): boolean {
  return Number.isInteger(min / grid) || edges.some((edge) => flushMins(edge, side).includes(min));
}

export function onSeatGrid(
  ground: SeatedGround,
  x: number,
  z: number,
  rot: number,
  neighbours: ReadonlyArray<WorldGround>,
): boolean {
  const placed = worldGround(ground, x, 0, z, rot);
  const grid = rotatedGrid(ground.grid, rot);
  return (
    seatedOnAxis(
      placed.minX,
      placed.maxX - placed.minX,
      grid.x,
      neighbours.map((n) => ({ min: n.minX, max: n.maxX })),
    ) &&
    seatedOnAxis(
      placed.minZ,
      placed.maxZ - placed.minZ,
      grid.z,
      neighbours.map((n) => ({ min: n.minZ, max: n.maxZ })),
    )
  );
}

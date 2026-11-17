import type { PartAsset } from "@brr/catalog";
import type { Vec3 } from "@brr/schema/bundle";
import { CHUNK_LDU, STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";

export interface GroundFootprint {
  readonly topY: number;
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly plates: number;
  readonly spacings: ReadonlyArray<number>;
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
  return {
    topY,
    minX,
    maxX,
    minZ,
    maxZ,
    plates: first.length,
    spacings: [
      maxX - minX,
      maxZ - minZ,
      ...first.flatMap((box) => [
        box.max[0] - box.min[0],
        box.max[2] - box.min[2],
        box.min[0] - minX,
        box.min[2] - minZ,
      ]),
    ],
  };
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

export function groundGrid(footprints: ReadonlyArray<GroundFootprint>): number {
  let grid = CHUNK_LDU;
  for (const footprint of footprints) {
    for (const spacing of footprint.spacings) {
      if (!Number.isInteger(spacing / STUD_LDU)) {
        throw new Error(`a baseplate spacing of ${spacing} LDU is not a whole number of studs`);
      }
      grid = greatestCommonDivisor(grid, spacing);
    }
  }
  return grid;
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

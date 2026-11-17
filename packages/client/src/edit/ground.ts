import { isRot90, rot90Cos, rot90Sin } from "@brr/math";

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

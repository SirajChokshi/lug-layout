import { rot90Cos, rot90Sin, type Rot90 } from "@brr/math";
import type { EdgeFeature } from "./item-spec.ts";
import type { LduRect } from "./plan-region.ts";

function worldX(x: number, cos: number, sin: number, lx: number, lz: number): number {
  return x + cos * lx + sin * lz + 0;
}

function worldZ(z: number, cos: number, sin: number, lx: number, lz: number): number {
  return z - sin * lx + cos * lz + 0;
}

export function placedRect(local: LduRect, x: number, z: number, rot: Rot90): LduRect {
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const ax = worldX(x, cos, sin, local.minX, local.minZ);
  const az = worldZ(z, cos, sin, local.minX, local.minZ);
  const bx = worldX(x, cos, sin, local.maxX, local.maxZ);
  const bz = worldZ(z, cos, sin, local.maxX, local.maxZ);
  return {
    minX: Math.min(ax, bx),
    minZ: Math.min(az, bz),
    maxX: Math.max(ax, bx),
    maxZ: Math.max(az, bz),
  };
}

export function placedFeature(local: EdgeFeature, x: number, z: number, rot: Rot90): EdgeFeature {
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  return {
    ax: worldX(x, cos, sin, local.ax, local.az),
    az: worldZ(z, cos, sin, local.ax, local.az),
    bx: worldX(x, cos, sin, local.bx, local.bz),
    bz: worldZ(z, cos, sin, local.bx, local.bz),
    levelLdu: local.levelLdu,
  };
}

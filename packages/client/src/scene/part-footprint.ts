import type { PartAsset } from "@brr/catalog";
import { PLATE_LDU, STUD_LDU } from "@brr/math";

export interface PartFootprint {
  readonly index: number;
  readonly widthStuds: number;
  readonly depthStuds: number;
  readonly heightPlates: number;
}

function wholeMultiple(value: number, unit: number, what: string, id: string): number {
  if (!Number.isInteger(value) || value % unit !== 0) {
    throw new Error(`${id}: ${what} ${value} LDU is not a whole multiple of ${unit} LDU`);
  }
  return value / unit;
}

export function plateDepthBelowOrigin(part: PartAsset): number {
  return wholeMultiple(-part.boundsMin[1], PLATE_LDU, "depth below origin", part.id);
}

export function railTopLdu(rail: PartAsset, yPlates: number): number {
  return (yPlates + plateDepthBelowOrigin(rail)) * PLATE_LDU + rail.boundsMax[1];
}

export function footprintOf(part: PartAsset, index: number): PartFootprint {
  const [minX, , minZ] = part.boundsMin;
  const [maxX, , maxZ] = part.boundsMax;
  if (minX + maxX !== 0 || minZ + maxZ !== 0) {
    throw new Error(`${part.id}: body is not centred on its origin in plan`);
  }
  return {
    index,
    widthStuds: wholeMultiple(maxX - minX, STUD_LDU, "width", part.id),
    depthStuds: wholeMultiple(maxZ - minZ, STUD_LDU, "depth", part.id),
    heightPlates: part.role === "ground" || part.role === "road" ? 0 : plateDepthBelowOrigin(part),
  };
}

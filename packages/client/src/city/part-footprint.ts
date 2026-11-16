import type { PartAsset, PartRole } from "@brr/catalog";

export const STUD_LDU = 20;
export const PLATE_LDU = 8;

export interface PartFootprint {
  readonly index: number;
  readonly id: string;
  readonly role: PartRole;
  readonly widthStuds: number;
  readonly depthStuds: number;
  readonly heightPlates: number;
}

function requireMultiple(value: number, unit: number, what: string, id: string): number {
  if (!Number.isInteger(value) || value % unit !== 0) {
    throw new Error(`${id}: ${what} ${value} LDU is not a whole multiple of ${unit} LDU`);
  }
  return value / unit;
}

export function footprintOf(part: PartAsset, index: number): PartFootprint {
  const [minX, minY, minZ] = part.boundsMin;
  const [maxX, , maxZ] = part.boundsMax;
  if (minX + maxX !== 0 || minZ + maxZ !== 0) {
    throw new Error(`${part.id}: body is not centred on its origin in plan`);
  }
  const widthStuds = requireMultiple(maxX - minX, STUD_LDU, "width", part.id);
  const depthStuds = requireMultiple(maxZ - minZ, STUD_LDU, "depth", part.id);
  const heightPlates =
    part.role === "ground" ? 0 : requireMultiple(-minY, PLATE_LDU, "height", part.id);
  return { index, id: part.id, role: part.role, widthStuds, depthStuds, heightPlates };
}

import { CHUNK_LDU, MM_PER_STUD, STUD_LDU, lduFromMm } from "@brr/math";

export interface MmRect {
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
}

export interface PlanTable {
  readonly id: string;
  readonly name: string;
  readonly rect: MmRect;
  readonly heightMm: number;
}

export interface PlanObstacle {
  readonly id: string;
  readonly name: string;
  readonly rect: MmRect;
}

export interface PlanFootprint {
  readonly roomWidthMm: number;
  readonly roomDepthMm: number;
  readonly tables: ReadonlyArray<PlanTable>;
  readonly obstacles: ReadonlyArray<PlanObstacle>;
}

export interface PlanRegion {
  readonly id: string;
  readonly name: string;
  readonly originChunkX: number;
  readonly originChunkZ: number;
  readonly footprint: PlanFootprint;
  readonly maxOverhangMm: number;
}

export interface LduRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface StudRect {
  readonly rect: LduRect;
  readonly studsWide: number;
  readonly studsDeep: number;
}

export function regionOriginX(region: PlanRegion): number {
  return region.originChunkX * CHUNK_LDU;
}

export function regionOriginZ(region: PlanRegion): number {
  return region.originChunkZ * CHUNK_LDU;
}

export function mmRectInWorld(region: PlanRegion, rect: MmRect): LduRect {
  const x = regionOriginX(region);
  const z = regionOriginZ(region);
  return {
    minX: x + lduFromMm(rect.x),
    minZ: z + lduFromMm(rect.z),
    maxX: x + lduFromMm(rect.x + rect.width),
    maxZ: z + lduFromMm(rect.z + rect.depth),
  };
}

export function roomRect(region: PlanRegion): LduRect {
  return mmRectInWorld(region, {
    x: 0,
    z: 0,
    width: region.footprint.roomWidthMm,
    depth: region.footprint.roomDepthMm,
  });
}

export function studsInside(region: PlanRegion, rect: MmRect): StudRect {
  const x = regionOriginX(region);
  const z = regionOriginZ(region);
  const firstX = Math.ceil(rect.x / MM_PER_STUD);
  const firstZ = Math.ceil(rect.z / MM_PER_STUD);
  const studsWide = Math.max(0, Math.floor((rect.x + rect.width) / MM_PER_STUD) - firstX);
  const studsDeep = Math.max(0, Math.floor((rect.z + rect.depth) / MM_PER_STUD) - firstZ);
  return {
    rect: {
      minX: x + firstX * STUD_LDU,
      minZ: z + firstZ * STUD_LDU,
      maxX: x + (firstX + studsWide) * STUD_LDU,
      maxZ: z + (firstZ + studsDeep) * STUD_LDU,
    },
    studsWide,
    studsDeep,
  };
}

export function rectsOverlap(a: LduRect, b: LduRect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
}

export function rectContains(outer: LduRect, inner: LduRect): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minZ >= outer.minZ &&
    inner.maxZ <= outer.maxZ
  );
}

export function subtractRect(from: LduRect, cut: LduRect): LduRect[] {
  if (!rectsOverlap(from, cut)) return [from];
  const pieces: LduRect[] = [];
  if (from.minX < cut.minX) pieces.push({ ...from, maxX: cut.minX });
  if (cut.maxX < from.maxX) pieces.push({ ...from, minX: cut.maxX });
  const minX = Math.max(from.minX, cut.minX);
  const maxX = Math.min(from.maxX, cut.maxX);
  if (from.minZ < cut.minZ) pieces.push({ minX, maxX, minZ: from.minZ, maxZ: cut.minZ });
  if (cut.maxZ < from.maxZ) pieces.push({ minX, maxX, minZ: cut.maxZ, maxZ: from.maxZ });
  return pieces;
}

export function uncoveredBy(rect: LduRect, covers: ReadonlyArray<LduRect>): LduRect[] {
  let remaining: LduRect[] = [rect];
  for (const cover of covers) {
    remaining = remaining.flatMap((piece) => subtractRect(piece, cover));
    if (remaining.length === 0) break;
  }
  return remaining;
}

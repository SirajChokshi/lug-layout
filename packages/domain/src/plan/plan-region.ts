import { CHUNK_LDU, MM_PER_STUD, STUD_LDU, lduFromMm, mmFromLdu } from "@brr/math";
import type { AisleSide, ObstacleKind, TableTypeRecordV2 } from "@brr/schema/world";

export interface MmRect {
  readonly x: number;
  readonly z: number;
  readonly width: number;
  readonly depth: number;
}

export interface PlanTable {
  readonly id: string;
  readonly number: number;
  readonly name: string;
  readonly rect: MmRect;
  readonly heightMm: number;
  readonly typeId?: number;
}

export type TableType = TableTypeRecordV2;

export interface PlanArea {
  readonly id: string;
  readonly name: string;
  readonly rect: MmRect;
}

export interface PlanObstacle extends PlanArea {
  readonly kind: ObstacleKind;
}

export interface PlanAisle extends PlanArea {
  readonly side: AisleSide;
}

export interface VenueItems {
  readonly rooms: PlanArea;
  readonly obstacles: PlanObstacle;
  readonly aisles: PlanAisle;
}

export type VenueList = keyof VenueItems;

export type PlanVenue = { readonly [L in VenueList]: ReadonlyArray<VenueItems[L]> };

export interface PlanFootprint extends PlanVenue {
  readonly roomWidthMm: number;
  readonly roomDepthMm: number;
  readonly tables: ReadonlyArray<PlanTable>;
}

export interface PlanRegion {
  readonly id: string;
  readonly name: string;
  readonly originChunkX: number;
  readonly originChunkZ: number;
  readonly footprint: PlanFootprint;
  readonly maxOverhangMm: number;
  readonly maxReachMm: number;
}

export interface PlanState {
  readonly regions: ReadonlyArray<PlanRegion>;
  readonly activePlanId: string | null;
  readonly tableTypes: ReadonlyArray<TableType>;
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

export function floorRects(region: PlanRegion): LduRect[] {
  const { rooms } = region.footprint;
  return rooms.length === 0
    ? [roomRect(region)]
    : rooms.map((room) => mmRectInWorld(region, room.rect));
}

export function isMarker(obstacle: Pick<PlanObstacle, "kind">): boolean {
  return obstacle.kind === "power";
}

export function blockingObstacles(region: PlanRegion): PlanObstacle[] {
  return region.footprint.obstacles.filter((obstacle) => !isMarker(obstacle));
}

export function crewAisleRects(region: PlanRegion): LduRect[] {
  return region.footprint.aisles
    .filter((aisle) => aisle.side === "crew")
    .map((aisle) => mmRectInWorld(region, aisle.rect));
}

export function mmRectFromWorld(region: PlanRegion, rect: LduRect): MmRect {
  return {
    x: mmFromLdu(rect.minX - regionOriginX(region)),
    z: mmFromLdu(rect.minZ - regionOriginZ(region)),
    width: mmFromLdu(rect.maxX - rect.minX),
    depth: mmFromLdu(rect.maxZ - rect.minZ),
  };
}

function chunksToCover(gapLdu: number): number {
  return gapLdu > 0 ? Math.ceil(gapLdu / CHUNK_LDU) : 0;
}

export function regionAround(region: PlanRegion, rect: LduRect): PlanRegion {
  const room = roomRect(region);
  const shiftX = chunksToCover(room.minX - rect.minX);
  const shiftZ = chunksToCover(room.minZ - rect.minZ);
  if (shiftX === 0 && shiftZ === 0 && rect.maxX <= room.maxX && rect.maxZ <= room.maxZ) {
    return region;
  }
  const shiftMmX = mmFromLdu(shiftX * CHUNK_LDU);
  const shiftMmZ = mmFromLdu(shiftZ * CHUNK_LDU);
  const shifted: PlanRegion = {
    ...region,
    originChunkX: region.originChunkX - shiftX,
    originChunkZ: region.originChunkZ - shiftZ,
  };
  const move = <T extends { readonly rect: MmRect }>(item: T): T => ({
    ...item,
    rect: { ...item.rect, x: item.rect.x + shiftMmX, z: item.rect.z + shiftMmZ },
  });
  const { footprint } = region;
  return {
    ...shifted,
    footprint: {
      roomWidthMm: Math.max(
        footprint.roomWidthMm + shiftMmX,
        mmFromLdu(rect.maxX - regionOriginX(shifted)),
      ),
      roomDepthMm: Math.max(
        footprint.roomDepthMm + shiftMmZ,
        mmFromLdu(rect.maxZ - regionOriginZ(shifted)),
      ),
      rooms: footprint.rooms.map(move),
      tables: footprint.tables.map(move),
      obstacles: footprint.obstacles.map(move),
      aisles: footprint.aisles.map(move),
    },
  };
}

export function regionAroundEach(region: PlanRegion, list: "rooms" | "tables"): PlanRegion {
  let grown = region;
  for (let i = 0; i < region.footprint[list].length; i++) {
    const item = grown.footprint[list][i];
    if (item) grown = regionAround(grown, mmRectInWorld(grown, item.rect));
  }
  return grown;
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

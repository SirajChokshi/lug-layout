import { CHUNK_LDU } from "@brr/math";
import { expect, it } from "vitest";
import {
  mmRectFromWorld,
  mmRectInWorld,
  rectContains,
  regionAround,
  roomRect,
  type LduRect,
  type PlanRegion,
} from "./plan-region.ts";

const region: PlanRegion = {
  id: "plan-1",
  name: "Room",
  originChunkX: 2,
  originChunkZ: -1,
  footprint: {
    roomWidthMm: 2000,
    roomDepthMm: 1500,
    tables: [
      { id: "t", name: "T", rect: { x: 128, z: 64, width: 1024, depth: 512 }, heightMm: 750 },
    ],
    obstacles: [{ id: "o", name: "O", rect: { x: 1500, z: 1000, width: 200, depth: 200 } }],
  },
  maxOverhangMm: 0,
};

it.each<[string, LduRect]>([
  ["inside the room", { minX: 1600, minZ: -480, maxX: 2240, maxZ: 0 }],
  ["past the far corner", { minX: 1600, minZ: 2560, maxX: 9600, maxZ: 4000 }],
  ["before the origin on both axes", { minX: -3360, minZ: -5920, maxX: 1440, maxZ: -800 }],
])(
  "grows the room around a rect %s in whole chunks without moving anything already in the world",
  (_, rect) => {
    const grown = regionAround(region, rect, CHUNK_LDU);
    const room = roomRect(grown);
    expect(
      rectContains(room, {
        minX: rect.minX - CHUNK_LDU,
        minZ: rect.minZ - CHUNK_LDU,
        maxX: rect.maxX + CHUNK_LDU,
        maxZ: rect.maxZ + CHUNK_LDU,
      }),
    ).toBe(true);
    expect(rectContains(room, roomRect(region))).toBe(true);
    for (const kind of ["tables", "obstacles"] as const) {
      expect(grown.footprint[kind].map((item) => mmRectInWorld(grown, item.rect))).toEqual(
        region.footprint[kind].map((item) => mmRectInWorld(region, item.rect)),
      );
    }
    expect(mmRectInWorld(grown, mmRectFromWorld(grown, rect))).toEqual(rect);
  },
);

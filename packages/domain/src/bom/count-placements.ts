import { CHUNK_LDU } from "@brr/math";
import { SLOT_LIVE, type ChunkView, type World } from "../world.ts";
import type { BomCounter } from "./bom-counter.ts";

export interface PlacementContents {
  addTo(counter: BomCounter, refId: number, colorId: number): void;
}

export interface PlacementRegion {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

function chunkMeetsRegion(chunk: ChunkView, region: PlacementRegion): boolean {
  return (
    chunk.originX < region.maxX &&
    chunk.originX + CHUNK_LDU > region.minX &&
    chunk.originZ < region.maxZ &&
    chunk.originZ + CHUNK_LDU > region.minZ
  );
}

export function countPlacements(
  world: World,
  contents: PlacementContents,
  counter: BomCounter,
  region: PlacementRegion | null,
): number {
  let placements = 0;
  for (const chunk of world.chunks()) {
    if (region !== null && !chunkMeetsRegion(chunk, region)) continue;
    for (let slot = 0; slot < chunk.count; slot++) {
      if (((chunk.flags[slot] ?? 0) & SLOT_LIVE) === 0) continue;
      if (region !== null) {
        const x = chunk.x[slot] ?? 0;
        const z = chunk.z[slot] ?? 0;
        if (x < region.minX || x >= region.maxX || z < region.minZ || z >= region.maxZ) continue;
      }
      contents.addTo(counter, chunk.refId[slot] ?? 0, chunk.colorId[slot] ?? 0);
      placements++;
    }
  }
  return placements;
}

import { NO_OWNER, SLOT_LIVE, type World } from "@brr/domain";
import type { ChunkInstances } from "@brr/render";

export type ChunkPartInstances = Omit<ChunkInstances, "studs">;

export interface PlacementDump {
  readonly chunkKey: ReadonlyArray<number>;
  readonly slot: ReadonlyArray<number>;
  readonly refId: ReadonlyArray<number>;
  readonly colorId: ReadonlyArray<number>;
  readonly x: ReadonlyArray<number>;
  readonly z: ReadonlyArray<number>;
  readonly yPlates: ReadonlyArray<number>;
  readonly rot: ReadonlyArray<number>;
  readonly layer: ReadonlyArray<number>;
  readonly owner: ReadonlyArray<number>;
}

export function dumpPlacements(world: World): PlacementDump {
  const chunkKey: number[] = [];
  const slot: number[] = [];
  const refId: number[] = [];
  const colorId: number[] = [];
  const x: number[] = [];
  const z: number[] = [];
  const yPlates: number[] = [];
  const rot: number[] = [];
  const layer: number[] = [];
  const owner: number[] = [];
  for (const chunk of world.chunks()) {
    for (let i = 0; i < chunk.count; i++) {
      if (((chunk.flags[i] ?? 0) & SLOT_LIVE) === 0) continue;
      chunkKey.push(chunk.key);
      slot.push(i);
      refId.push(chunk.refId[i] ?? 0);
      colorId.push(chunk.colorId[i] ?? 0);
      x.push(chunk.x[i] ?? 0);
      z.push(chunk.z[i] ?? 0);
      yPlates.push(chunk.yPlates[i] ?? 0);
      rot.push(chunk.rot[i] ?? 0);
      layer.push(chunk.layer[i] ?? 0);
      owner.push(chunk.owner[i] ?? NO_OWNER);
    }
  }
  return { chunkKey, slot, refId, colorId, x, z, yPlates, rot, layer, owner };
}

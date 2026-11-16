import { chunkKey } from "./chunk-key.ts";
import { CHUNK_LDU } from "./units.ts";

export const SUPER_CHUNK_CHUNKS = 8;
export const SUPER_CHUNK_LDU = SUPER_CHUNK_CHUNKS * CHUNK_LDU;

export function superChunkOf(chunk: number): number {
  return Math.floor(chunk / SUPER_CHUNK_CHUNKS);
}

export function superChunkKey(superX: number, superZ: number): number {
  return chunkKey(superX, superZ);
}

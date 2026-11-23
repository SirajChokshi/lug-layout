import { LATTICE_LIMITS } from "./lattice.ts";
import { CHUNK_LDU } from "./units.ts";

const CHUNK_KEY_OFFSET = 2 ** 22;
const CHUNK_KEY_STRIDE = 2 ** 23;

export function chunkOf(ldu: number): number {
  return Math.floor(ldu / CHUNK_LDU);
}

const MIN_CHUNK = chunkOf(LATTICE_LIMITS.INT32_MIN);
const MAX_CHUNK = chunkOf(LATTICE_LIMITS.INT32_MAX);

function inChunkRange(chunk: number): boolean {
  return Number.isInteger(chunk) && chunk >= MIN_CHUNK && chunk <= MAX_CHUNK;
}

export function assertChunkInRange(chunkX: number, chunkZ: number): void {
  if (!inChunkRange(chunkX) || !inChunkRange(chunkZ)) {
    throw new RangeError(
      `chunk (${chunkX}, ${chunkZ}) is outside the int32 LDU world (chunks ${MIN_CHUNK} to ${MAX_CHUNK})`,
    );
  }
}

export function chunkKey(chunkX: number, chunkZ: number): number {
  assertChunkInRange(chunkX, chunkZ);
  return (chunkX + CHUNK_KEY_OFFSET) * CHUNK_KEY_STRIDE + (chunkZ + CHUNK_KEY_OFFSET);
}

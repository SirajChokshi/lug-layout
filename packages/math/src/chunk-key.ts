import { CHUNK_LDU } from "./units.ts";

const INT32_LDU_LIMIT = 2 ** 31;
const MAX_CHUNK_COORDINATE = Math.floor(INT32_LDU_LIMIT / CHUNK_LDU);
const CHUNK_KEY_OFFSET = 2 ** 22;
const CHUNK_KEY_STRIDE = 2 ** 23;

export function chunkOf(ldu: number): number {
  return Math.floor(ldu / CHUNK_LDU);
}

export function chunkKey(chunkX: number, chunkZ: number): number {
  if (Math.abs(chunkX) > MAX_CHUNK_COORDINATE || Math.abs(chunkZ) > MAX_CHUNK_COORDINATE) {
    throw new RangeError(
      `chunk (${chunkX}, ${chunkZ}) is outside the int32 LDU world (±${MAX_CHUNK_COORDINATE} chunks)`,
    );
  }
  return (chunkX + CHUNK_KEY_OFFSET) * CHUNK_KEY_STRIDE + (chunkZ + CHUNK_KEY_OFFSET);
}

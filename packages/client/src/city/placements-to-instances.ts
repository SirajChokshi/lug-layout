import { INSTANCE_MATRIX_FLOATS, type ChunkInstances } from "@brr/render";
import type { ChunkPlacements } from "./procedural-city.ts";
import { CHUNK_STUDS } from "./procedural-city.ts";
import { PLATE_LDU, STUD_LDU } from "./part-footprint.ts";

const CHUNK_LDU = CHUNK_STUDS * STUD_LDU;
const QUARTER_TURN_COS = Int8Array.of(1, 0, -1, 0);
const QUARTER_TURN_SIN = Int8Array.of(0, 1, 0, -1);

export function placementsToInstances(chunk: ChunkPlacements): ChunkInstances {
  const matrices = new Float32Array(chunk.count * INSTANCE_MATRIX_FLOATS);
  for (let i = 0; i < chunk.count; i++) {
    const turn = (chunk.rot[i] ?? 0) & 3;
    const cos = QUARTER_TURN_COS[turn] ?? 1;
    const sin = QUARTER_TURN_SIN[turn] ?? 0;
    const o = i * INSTANCE_MATRIX_FLOATS;
    matrices[o] = cos;
    matrices[o + 1] = 0;
    matrices[o + 2] = sin;
    matrices[o + 3] = chunk.x[i] ?? 0;
    matrices[o + 4] = 0;
    matrices[o + 5] = 1;
    matrices[o + 6] = 0;
    matrices[o + 7] = (chunk.yPlates[i] ?? 0) * PLATE_LDU;
    matrices[o + 8] = -sin;
    matrices[o + 9] = 0;
    matrices[o + 10] = cos;
    matrices[o + 11] = chunk.z[i] ?? 0;
  }
  return {
    originX: chunk.chunkX * CHUNK_LDU,
    originZ: chunk.chunkZ * CHUNK_LDU,
    count: chunk.count,
    partIndex: chunk.partIndex,
    colorIndex: chunk.colorIndex,
    matrices,
  };
}

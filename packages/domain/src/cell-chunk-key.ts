import { CHUNK_STUDS, chunkKey } from "@brr/math";

function chunkOfCell(cell: number): number {
  return Math.floor(cell / CHUNK_STUDS);
}

export function cellChunkKey(cellX: number, cellZ: number): number {
  return chunkKey(chunkOfCell(cellX), chunkOfCell(cellZ));
}

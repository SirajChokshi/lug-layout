import { CHUNK_STUDS, chunkKey } from "@brr/math";

const CELLS_PER_CHUNK = CHUNK_STUDS * CHUNK_STUDS;
const MAX_TOP_PLATES = 0xffff;

function chunkOfCell(cell: number): number {
  return Math.floor(cell / CHUNK_STUDS);
}

function cellIndex(cellX: number, cellZ: number): number {
  const x = cellX - chunkOfCell(cellX) * CHUNK_STUDS;
  const z = cellZ - chunkOfCell(cellZ) * CHUNK_STUDS;
  return z * CHUNK_STUDS + x;
}

export function cellChunkKey(cellX: number, cellZ: number): number {
  return chunkKey(chunkOfCell(cellX), chunkOfCell(cellZ));
}

interface ChunkColumns {
  readonly chunkX: number;
  readonly chunkZ: number;
}

export class OccupancyGrid {
  private readonly byKey = new Map<number, ChunkColumns>();
  private readonly byChunkX = new Map<number, Map<number, Uint16Array>>();

  topAt(cellX: number, cellZ: number): number {
    const grid = this.byChunkX.get(chunkOfCell(cellX))?.get(chunkOfCell(cellZ));
    return grid ? (grid[cellIndex(cellX, cellZ)] ?? 0) : 0;
  }

  raise(cellX: number, cellZ: number, topPlates: number): void {
    if (!Number.isInteger(topPlates) || topPlates < 0 || topPlates > MAX_TOP_PLATES) {
      throw new RangeError(`column top ${topPlates} plates is outside 0-${MAX_TOP_PLATES}`);
    }
    const chunkX = chunkOfCell(cellX);
    const chunkZ = chunkOfCell(cellZ);
    let rows = this.byChunkX.get(chunkX);
    if (!rows) {
      rows = new Map<number, Uint16Array>();
      this.byChunkX.set(chunkX, rows);
    }
    let grid = rows.get(chunkZ);
    if (!grid) {
      grid = new Uint16Array(CELLS_PER_CHUNK);
      rows.set(chunkZ, grid);
      this.byKey.set(chunkKey(chunkX, chunkZ), { chunkX, chunkZ });
    }
    const i = cellIndex(cellX, cellZ);
    if (topPlates > (grid[i] ?? 0)) grid[i] = topPlates;
  }

  clearChunk(key: number): void {
    const chunk = this.byKey.get(key);
    if (!chunk) return;
    this.byKey.delete(key);
    this.byChunkX.get(chunk.chunkX)?.delete(chunk.chunkZ);
  }
}

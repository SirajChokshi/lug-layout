import { CHUNK_STUDS } from "@brr/math";

const BUCKET_CELLS = 4;
const BUCKETS_PER_SIDE = CHUNK_STUDS / BUCKET_CELLS;
const BUCKETS = BUCKETS_PER_SIDE * BUCKETS_PER_SIDE;
const NODE_FIELDS = 2;
const ROW = 0;
const NEXT = 1;
const NONE = -1;
const GROWTH = 1.25;
const MIN_GROWTH = 16;
export const NO_VOLUME_TOP = -0x8000_0000;

function chunkOfCell(cell: number): number {
  return Math.floor(cell / CHUNK_STUDS);
}

function bucketOf(cellX: number, cellZ: number): number {
  const x = cellX - chunkOfCell(cellX) * CHUNK_STUDS;
  const z = cellZ - chunkOfCell(cellZ) * CHUNK_STUDS;
  return Math.floor(z / BUCKET_CELLS) * BUCKETS_PER_SIDE + Math.floor(x / BUCKET_CELLS);
}

function grown(array: Int32Array<ArrayBuffer>, needed: number): Int32Array<ArrayBuffer> {
  if (needed <= array.length) return array;
  const length = Math.max(needed, Math.ceil(array.length * GROWTH), array.length + MIN_GROWTH);
  const next = new Int32Array(length);
  next.set(array);
  return next;
}

export class FootprintGrid {
  private constructor(
    readonly width: number,
    readonly depth: number,
    readonly bottomLdu: Int32Array,
    readonly topLdu: Int32Array,
  ) {}

  static of(
    world: CellVolumes,
    cellX0: number,
    cellZ0: number,
    width: number,
    depth: number,
    yLdu: number,
  ): FootprintGrid {
    const bottomLdu = new Int32Array(width * depth);
    const topLdu = new Int32Array(width * depth);
    for (let c = 0; c < world.count; c++) {
      const bottom = world.bottomLdu[c] ?? 0;
      const top = world.topLdu[c] ?? 0;
      if (!Number.isInteger(bottom) || !Number.isInteger(top)) {
        throw new RangeError(`volume [${bottom}, ${top}) LDU is not an integer span`);
      }
      if (top <= bottom) continue;
      const i = (world.cellX[c] ?? 0) - cellX0;
      const j = (world.cellZ[c] ?? 0) - cellZ0;
      if (i < 0 || j < 0 || i >= width || j >= depth) {
        throw new RangeError(`cell ${cellX0 + i}, ${cellZ0 + j} is outside its footprint`);
      }
      bottomLdu[j * width + i] = bottom - yLdu;
      topLdu[j * width + i] = top - yLdu;
    }
    return new FootprintGrid(width, depth, bottomLdu, topLdu);
  }
}

class FootprintChunk {
  readonly heads = new Int32Array(BUCKETS).fill(NONE);
  nodes = new Int32Array(0);
  private used = 0;
  private free = NONE;

  link(bucket: number, row: number): void {
    let n = this.free;
    if (n !== NONE) {
      this.free = this.nodes[n + NEXT] ?? NONE;
    } else {
      this.nodes = grown(this.nodes, (this.used + 1) * NODE_FIELDS);
      n = this.used++ * NODE_FIELDS;
    }
    this.nodes[n + ROW] = row;
    this.nodes[n + NEXT] = this.heads[bucket] ?? NONE;
    this.heads[bucket] = n;
  }

  unlink(bucket: number, row: number): boolean {
    let previous = NONE;
    for (let n = this.heads[bucket] ?? NONE; n !== NONE; n = this.nodes[n + NEXT] ?? NONE) {
      if (this.nodes[n + ROW] !== row) {
        previous = n;
        continue;
      }
      const next = this.nodes[n + NEXT] ?? NONE;
      if (previous === NONE) this.heads[bucket] = next;
      else this.nodes[previous + NEXT] = next;
      this.nodes[n + NEXT] = this.free;
      this.free = n;
      return true;
    }
    return false;
  }
}

export interface VolumeHit {
  owner: number;
  bottomLdu: number;
  topLdu: number;
}

export type OwnerFilter = (owner: number, cellX: number, cellZ: number) => boolean;

export class VolumeIndex {
  private readonly byChunkX = new Map<number, Map<number, FootprintChunk>>();
  private readonly grids: Array<FootprintGrid | null> = [];
  private owners = new Int32Array(0);
  private cellX0 = new Int32Array(0);
  private cellZ0 = new Int32Array(0);
  private yLdu = new Int32Array(0);
  private freeRows = new Int32Array(0);
  private freeCount = 0;
  private rows = 0;

  add(owner: number, grid: FootprintGrid, cellX0: number, cellZ0: number, yLdu: number): number {
    let row: number;
    if (this.freeCount > 0) {
      row = this.freeRows[--this.freeCount] ?? 0;
    } else {
      row = this.rows++;
      this.owners = grown(this.owners, this.rows);
      this.cellX0 = grown(this.cellX0, this.rows);
      this.cellZ0 = grown(this.cellZ0, this.rows);
      this.yLdu = grown(this.yLdu, this.rows);
    }
    this.owners[row] = owner;
    this.cellX0[row] = cellX0;
    this.cellZ0[row] = cellZ0;
    this.yLdu[row] = yLdu;
    this.grids[row] = grid;
    this.linkBuckets(row, grid, true);
    return row;
  }

  remove(row: number): void {
    const grid = this.grids[row];
    if (!grid) throw new RangeError(`footprint ${row} is not indexed`);
    this.linkBuckets(row, grid, false);
    this.grids[row] = null;
    this.freeRows = grown(this.freeRows, this.freeCount + 1);
    this.freeRows[this.freeCount++] = row;
  }

  topAt(cellX: number, cellZ: number): number {
    const chunk = this.chunkAt(cellX, cellZ);
    if (!chunk) return NO_VOLUME_TOP;
    const nodes = chunk.nodes;
    let top = NO_VOLUME_TOP;
    for (
      let n = chunk.heads[bucketOf(cellX, cellZ)] ?? NONE;
      n !== NONE;
      n = nodes[n + NEXT] ?? NONE
    ) {
      const row = nodes[n + ROW] ?? 0;
      const k = this.cellOf(row, cellX, cellZ);
      if (k === NONE) continue;
      const grid = this.grids[row];
      const b = grid?.bottomLdu[k] ?? 0;
      const t = grid?.topLdu[k] ?? 0;
      if (t <= b) continue;
      top = Math.max(top, t + (this.yLdu[row] ?? 0));
    }
    return top;
  }

  firstOverlap(
    cellX: number,
    cellZ: number,
    bottomLdu: number,
    topLdu: number,
    ignore: OwnerFilter,
    out: VolumeHit,
  ): boolean {
    const chunk = this.chunkAt(cellX, cellZ);
    if (!chunk) return false;
    const nodes = chunk.nodes;
    for (
      let n = chunk.heads[bucketOf(cellX, cellZ)] ?? NONE;
      n !== NONE;
      n = nodes[n + NEXT] ?? NONE
    ) {
      const row = nodes[n + ROW] ?? 0;
      const k = this.cellOf(row, cellX, cellZ);
      if (k === NONE) continue;
      const grid = this.grids[row];
      const gridBottom = grid?.bottomLdu[k] ?? 0;
      const gridTop = grid?.topLdu[k] ?? 0;
      if (gridTop <= gridBottom) continue;
      const y = this.yLdu[row] ?? 0;
      const b = gridBottom + y;
      const t = gridTop + y;
      const owner = this.owners[row] ?? 0;
      if (Math.max(b, bottomLdu) < Math.min(t, topLdu) && !ignore(owner, cellX, cellZ)) {
        out.owner = owner;
        out.bottomLdu = b;
        out.topLdu = t;
        return true;
      }
    }
    return false;
  }

  private cellOf(row: number, cellX: number, cellZ: number): number {
    const grid = this.grids[row];
    if (!grid) return NONE;
    const i = cellX - (this.cellX0[row] ?? 0);
    const j = cellZ - (this.cellZ0[row] ?? 0);
    if (i < 0 || j < 0 || i >= grid.width || j >= grid.depth) return NONE;
    return j * grid.width + i;
  }

  private linkBuckets(row: number, grid: FootprintGrid, link: boolean): void {
    if (grid.width === 0 || grid.depth === 0) return;
    const x0 = this.cellX0[row] ?? 0;
    const z0 = this.cellZ0[row] ?? 0;
    const bx0 = Math.floor(x0 / BUCKET_CELLS);
    const bx1 = Math.floor((x0 + grid.width - 1) / BUCKET_CELLS);
    const bz0 = Math.floor(z0 / BUCKET_CELLS);
    const bz1 = Math.floor((z0 + grid.depth - 1) / BUCKET_CELLS);
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        const cellX = bx * BUCKET_CELLS;
        const cellZ = bz * BUCKET_CELLS;
        const chunk = this.chunkFor(cellX, cellZ);
        if (link) chunk.link(bucketOf(cellX, cellZ), row);
        else if (!chunk.unlink(bucketOf(cellX, cellZ), row)) {
          throw new RangeError(`footprint ${row} is missing from its bucket at ${cellX}, ${cellZ}`);
        }
      }
    }
  }

  private chunkAt(cellX: number, cellZ: number): FootprintChunk | undefined {
    return this.byChunkX.get(chunkOfCell(cellX))?.get(chunkOfCell(cellZ));
  }

  private chunkFor(cellX: number, cellZ: number): FootprintChunk {
    const chunkX = chunkOfCell(cellX);
    const chunkZ = chunkOfCell(cellZ);
    let rows = this.byChunkX.get(chunkX);
    if (!rows) {
      rows = new Map<number, FootprintChunk>();
      this.byChunkX.set(chunkX, rows);
    }
    let chunk = rows.get(chunkZ);
    if (!chunk) {
      chunk = new FootprintChunk();
      rows.set(chunkZ, chunk);
    }
    return chunk;
  }
}

export interface CellVolumes {
  readonly count: number;
  readonly cellX: ArrayLike<number>;
  readonly cellZ: ArrayLike<number>;
  readonly bottomLdu: ArrayLike<number>;
  readonly topLdu: ArrayLike<number>;
}

export interface OverlapHit extends VolumeHit {
  cellX: number;
  cellZ: number;
  candidateBottomLdu: number;
  candidateTopLdu: number;
}

export function firstOverlap(
  volumes: CellVolumes,
  index: VolumeIndex,
  ignore: OwnerFilter,
  out: OverlapHit,
): boolean {
  for (let c = 0; c < volumes.count; c++) {
    const x = volumes.cellX[c] ?? 0;
    const z = volumes.cellZ[c] ?? 0;
    const bottom = volumes.bottomLdu[c] ?? 0;
    const top = volumes.topLdu[c] ?? 0;
    if (top <= bottom || !index.firstOverlap(x, z, bottom, top, ignore, out)) continue;
    out.cellX = x;
    out.cellZ = z;
    out.candidateBottomLdu = bottom;
    out.candidateTopLdu = top;
    return true;
  }
  return false;
}

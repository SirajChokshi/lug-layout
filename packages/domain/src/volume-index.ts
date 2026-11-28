import { CHUNK_STUDS, SIXTEENTHS_PER_LDU, STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";

const BUCKET_CELLS = 4;
const BUCKETS_PER_SIDE = CHUNK_STUDS / BUCKET_CELLS;
const BUCKETS = BUCKETS_PER_SIDE * BUCKETS_PER_SIDE;
const NODE_FIELDS = 2;
const ROW = 0;
const NEXT = 1;
const NONE = -1;
const GROWTH = 1.25;
const MIN_GROWTH = 16;
export const CELL_BOX_INTS = 4;
export const HEIGHT_BOX_INTS = 2;
export const NO_PART_INSTANCE = -1;
const CELL_SIXTEENTHS = STUD_LDU * SIXTEENTHS_PER_LDU;
const HALF_CELL_SIXTEENTHS = CELL_SIXTEENTHS / 2;
const NO_PARTS = -1;
const BOX_X0 = 0;
const BOX_Z0 = 1;
const BOX_X1 = 2;
const BOX_Z1 = 3;
const BOTTOM = 0;
const TOP = 1;

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
    readonly partsAt: Int32Array,
    readonly parts: CellParts,
    readonly turn: number,
    readonly sixteenthsUp: number,
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
    const partsAt = new Int32Array(width * depth).fill(NO_PARTS);
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
      partsAt[j * width + i] = world.partsAt[c] ?? NO_PARTS;
    }
    return new FootprintGrid(
      width,
      depth,
      bottomLdu,
      topLdu,
      partsAt,
      world.parts,
      world.turn,
      world.sixteenthsUp - yLdu * SIXTEENTHS_PER_LDU,
    );
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

  clear(): void {
    this.heads.fill(NONE);
    this.used = 0;
    this.free = NONE;
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
  instance: number;
  bottomLdu: number;
  topLdu: number;
}

export type OwnerFilter = (
  owner: number,
  cellX: number,
  cellZ: number,
  heldCell: number,
) => boolean;

export interface PairExcuse {
  excuses(
    owner: number,
    heldInstance: number,
    placedInstance: number,
    region: Float64Array,
  ): boolean;
}

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

  clear(): void {
    for (const rows of this.byChunkX.values()) {
      for (const chunk of rows.values()) chunk.clear();
    }
    this.grids.length = 0;
    this.rows = 0;
    this.freeCount = 0;
  }

  firstOverlap(
    cellX: number,
    cellZ: number,
    held: CellVolumes,
    heldCell: number,
    ignore: OwnerFilter,
    out: OverlapHit,
  ): boolean {
    const chunk = this.chunkAt(cellX, cellZ);
    if (!chunk) return false;
    const bottomLdu = held.bottomLdu[heldCell] ?? 0;
    const topLdu = held.topLdu[heldCell] ?? 0;
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
      if (!grid) continue;
      const gridBottom = grid.bottomLdu[k] ?? 0;
      const gridTop = grid.topLdu[k] ?? 0;
      if (gridTop <= gridBottom) continue;
      const y = this.yLdu[row] ?? 0;
      if (Math.max(gridBottom + y, bottomLdu) >= Math.min(gridTop + y, topLdu)) continue;
      const placedUp = grid.sixteenthsUp + y * SIXTEENTHS_PER_LDU;
      if (!firstPartOverlap(held, heldCell, grid, k, placedUp, out, null)) continue;
      const owner = this.owners[row] ?? 0;
      if (ignore(owner, cellX, cellZ, heldCell)) continue;
      out.owner = owner;
      return true;
    }
    return false;
  }

  firstUnexcusedOverlap(
    cellX: number,
    cellZ: number,
    held: CellVolumes,
    heldCell: number,
    owner: number,
    excuse: PairExcuse,
    out: OverlapHit,
  ): boolean {
    const chunk = this.chunkAt(cellX, cellZ);
    if (!chunk) return false;
    const bottomLdu = held.bottomLdu[heldCell] ?? 0;
    const topLdu = held.topLdu[heldCell] ?? 0;
    const nodes = chunk.nodes;
    for (
      let n = chunk.heads[bucketOf(cellX, cellZ)] ?? NONE;
      n !== NONE;
      n = nodes[n + NEXT] ?? NONE
    ) {
      const row = nodes[n + ROW] ?? 0;
      if (this.owners[row] !== owner) continue;
      const k = this.cellOf(row, cellX, cellZ);
      if (k === NONE) continue;
      const grid = this.grids[row];
      if (!grid) continue;
      const gridBottom = grid.bottomLdu[k] ?? 0;
      const gridTop = grid.topLdu[k] ?? 0;
      if (gridTop <= gridBottom) continue;
      const y = this.yLdu[row] ?? 0;
      if (Math.max(gridBottom + y, bottomLdu) >= Math.min(gridTop + y, topLdu)) continue;
      const placedUp = grid.sixteenthsUp + y * SIXTEENTHS_PER_LDU;
      pairing.owner = owner;
      pairing.cellX = cellX;
      pairing.cellZ = cellZ;
      pairing.excuse = excuse;
      const found = firstPartOverlap(held, heldCell, grid, k, placedUp, out, pairing);
      pairing.excuse = null;
      if (!found) continue;
      out.owner = owner;
      return true;
    }
    return false;
  }

  firstContactBelow(
    cellX: number,
    cellZ: number,
    held: CellVolumes,
    heldCell: number,
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
      if (!grid) continue;
      const owner = this.owners[row] ?? 0;
      if (ignore(owner, cellX, cellZ, heldCell)) continue;
      const placedUp = grid.sixteenthsUp + (this.yLdu[row] ?? 0) * SIXTEENTHS_PER_LDU;
      if (!firstPartContact(held, heldCell, grid, k, placedUp, out)) continue;
      out.owner = owner;
      return true;
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

export interface CellParts {
  readonly start: ArrayLike<number>;
  readonly instance: ArrayLike<number>;
  readonly cellBox: ArrayLike<number>;
  readonly heightBox: ArrayLike<number>;
}

export interface CellVolumes {
  readonly count: number;
  readonly cellX: ArrayLike<number>;
  readonly cellZ: ArrayLike<number>;
  readonly bottomLdu: ArrayLike<number>;
  readonly topLdu: ArrayLike<number>;
  readonly partsAt: ArrayLike<number>;
  readonly parts: CellParts;
  readonly turn: number;
  readonly sixteenthsUp: number;
}

export interface OverlapHit extends VolumeHit {
  cellX: number;
  cellZ: number;
  candidateInstance: number;
  candidateBottomLdu: number;
  candidateTopLdu: number;
}

const heldBox = new Int32Array(CELL_BOX_INTS);
const placedBox = new Int32Array(CELL_BOX_INTS);
const REGION_X0 = 0;
const REGION_Y0 = 1;
const REGION_Z0 = 2;
const REGION_X1 = 3;
const REGION_Y1 = 4;
const REGION_Z1 = 5;
const REGION_FLOATS = 6;

interface Pairing {
  owner: number;
  cellX: number;
  cellZ: number;
  excuse: PairExcuse | null;
  readonly region: Float64Array;
}

const pairing: Pairing = {
  owner: 0,
  cellX: 0,
  cellZ: 0,
  excuse: null,
  region: new Float64Array(REGION_FLOATS),
};

function excused(
  pair: Pairing,
  heldInstance: number,
  placedInstance: number,
  bottom: number,
  top: number,
): boolean {
  const excuse = pair.excuse;
  if (!excuse) return false;
  const x = pair.cellX * CELL_SIXTEENTHS;
  const z = pair.cellZ * CELL_SIXTEENTHS;
  const region = pair.region;
  region[REGION_X0] =
    (x + Math.max(heldBox[BOX_X0] ?? 0, placedBox[BOX_X0] ?? 0)) / SIXTEENTHS_PER_LDU;
  region[REGION_Z0] =
    (z + Math.max(heldBox[BOX_Z0] ?? 0, placedBox[BOX_Z0] ?? 0)) / SIXTEENTHS_PER_LDU;
  region[REGION_X1] =
    (x + Math.min(heldBox[BOX_X1] ?? 0, placedBox[BOX_X1] ?? 0)) / SIXTEENTHS_PER_LDU;
  region[REGION_Z1] =
    (z + Math.min(heldBox[BOX_Z1] ?? 0, placedBox[BOX_Z1] ?? 0)) / SIXTEENTHS_PER_LDU;
  region[REGION_Y0] = bottom / SIXTEENTHS_PER_LDU;
  region[REGION_Y1] = top / SIXTEENTHS_PER_LDU;
  return excuse.excuses(pair.owner, heldInstance, placedInstance, region);
}

export function turnedCellBox(
  cellBox: ArrayLike<number>,
  entry: number,
  turn: number,
  out: Int32Array,
): void {
  const rot = isRot90(turn) ? turn : 0;
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const at = entry * CELL_BOX_INTS;
  const u0 = (cellBox[at + BOX_X0] ?? 0) - HALF_CELL_SIXTEENTHS;
  const v0 = (cellBox[at + BOX_Z0] ?? 0) - HALF_CELL_SIXTEENTHS;
  const u1 = (cellBox[at + BOX_X1] ?? 0) - HALF_CELL_SIXTEENTHS;
  const v1 = (cellBox[at + BOX_Z1] ?? 0) - HALF_CELL_SIXTEENTHS;
  const xa = cos * u0 + sin * v0;
  const za = -sin * u0 + cos * v0;
  const xb = cos * u1 + sin * v1;
  const zb = -sin * u1 + cos * v1;
  out[BOX_X0] = Math.min(xa, xb) + HALF_CELL_SIXTEENTHS;
  out[BOX_Z0] = Math.min(za, zb) + HALF_CELL_SIXTEENTHS;
  out[BOX_X1] = Math.max(xa, xb) + HALF_CELL_SIXTEENTHS;
  out[BOX_Z1] = Math.max(za, zb) + HALF_CELL_SIXTEENTHS;
}

function acrossOverlap(a: Int32Array, b: Int32Array): boolean {
  return (
    Math.max(a[BOX_X0] ?? 0, b[BOX_X0] ?? 0) < Math.min(a[BOX_X1] ?? 0, b[BOX_X1] ?? 0) &&
    Math.max(a[BOX_Z0] ?? 0, b[BOX_Z0] ?? 0) < Math.min(a[BOX_Z1] ?? 0, b[BOX_Z1] ?? 0)
  );
}

function partRange(parts: CellParts, at: number): number {
  return at === NO_PARTS ? 0 : (parts.start[at] ?? 0);
}

function partEnd(parts: CellParts, at: number): number {
  return at === NO_PARTS ? 0 : (parts.start[at + 1] ?? 0);
}

function firstPartOverlap(
  held: CellVolumes,
  heldCell: number,
  grid: FootprintGrid,
  k: number,
  placedUp: number,
  out: OverlapHit,
  pair: Pairing | null,
): boolean {
  const heldAt = held.partsAt[heldCell] ?? NO_PARTS;
  const placedAt = grid.partsAt[k] ?? NO_PARTS;
  const heldParts = held.parts;
  const placedParts = grid.parts;
  for (let h = partRange(heldParts, heldAt); h < partEnd(heldParts, heldAt); h++) {
    const heldBottom = (heldParts.heightBox[h * HEIGHT_BOX_INTS + BOTTOM] ?? 0) + held.sixteenthsUp;
    const heldTop = (heldParts.heightBox[h * HEIGHT_BOX_INTS + TOP] ?? 0) + held.sixteenthsUp;
    turnedCellBox(heldParts.cellBox, h, held.turn, heldBox);
    for (let p = partRange(placedParts, placedAt); p < partEnd(placedParts, placedAt); p++) {
      const placedBottom = (placedParts.heightBox[p * HEIGHT_BOX_INTS + BOTTOM] ?? 0) + placedUp;
      const placedTop = (placedParts.heightBox[p * HEIGHT_BOX_INTS + TOP] ?? 0) + placedUp;
      const bottom = Math.max(heldBottom, placedBottom);
      const top = Math.min(heldTop, placedTop);
      if (bottom >= top) continue;
      turnedCellBox(placedParts.cellBox, p, grid.turn, placedBox);
      if (!acrossOverlap(heldBox, placedBox)) continue;
      const heldInstance = heldParts.instance[h] ?? NO_PART_INSTANCE;
      const placedInstance = placedParts.instance[p] ?? NO_PART_INSTANCE;
      if (pair && excused(pair, heldInstance, placedInstance, bottom, top)) continue;
      out.instance = placedInstance;
      out.bottomLdu = placedBottom / SIXTEENTHS_PER_LDU;
      out.topLdu = placedTop / SIXTEENTHS_PER_LDU;
      out.candidateInstance = heldInstance;
      out.candidateBottomLdu = heldBottom / SIXTEENTHS_PER_LDU;
      out.candidateTopLdu = heldTop / SIXTEENTHS_PER_LDU;
      return true;
    }
  }
  return false;
}

function firstPartContact(
  held: CellVolumes,
  heldCell: number,
  grid: FootprintGrid,
  k: number,
  placedUp: number,
  out: VolumeHit,
): boolean {
  const heldAt = held.partsAt[heldCell] ?? NO_PARTS;
  const placedAt = grid.partsAt[k] ?? NO_PARTS;
  const heldParts = held.parts;
  const placedParts = grid.parts;
  for (let h = partRange(heldParts, heldAt); h < partEnd(heldParts, heldAt); h++) {
    const heldBottom = (heldParts.heightBox[h * HEIGHT_BOX_INTS + BOTTOM] ?? 0) + held.sixteenthsUp;
    turnedCellBox(heldParts.cellBox, h, held.turn, heldBox);
    for (let p = partRange(placedParts, placedAt); p < partEnd(placedParts, placedAt); p++) {
      const placedTop = (placedParts.heightBox[p * HEIGHT_BOX_INTS + TOP] ?? 0) + placedUp;
      if (placedTop !== heldBottom) continue;
      turnedCellBox(placedParts.cellBox, p, grid.turn, placedBox);
      if (!acrossOverlap(heldBox, placedBox)) continue;
      out.instance = placedParts.instance[p] ?? NO_PART_INSTANCE;
      out.bottomLdu =
        ((placedParts.heightBox[p * HEIGHT_BOX_INTS + BOTTOM] ?? 0) + placedUp) /
        SIXTEENTHS_PER_LDU;
      out.topLdu = placedTop / SIXTEENTHS_PER_LDU;
      return true;
    }
  }
  return false;
}

export const NO_OVERLAP = -1;

function overlapsAt(
  volumes: CellVolumes,
  index: VolumeIndex,
  ignore: OwnerFilter,
  out: OverlapHit,
  c: number,
): boolean {
  const x = volumes.cellX[c] ?? 0;
  const z = volumes.cellZ[c] ?? 0;
  if ((volumes.topLdu[c] ?? 0) <= (volumes.bottomLdu[c] ?? 0)) return false;
  if (!index.firstOverlap(x, z, volumes, c, ignore, out)) return false;
  out.cellX = x;
  out.cellZ = z;
  return true;
}

export function firstOverlapFrom(
  volumes: CellVolumes,
  index: VolumeIndex,
  ignore: OwnerFilter,
  out: OverlapHit,
  hint: number,
): number {
  if (hint >= 0 && hint < volumes.count && overlapsAt(volumes, index, ignore, out, hint)) {
    return hint;
  }
  for (let c = 0; c < volumes.count; c++) {
    if (c !== hint && overlapsAt(volumes, index, ignore, out, c)) return c;
  }
  return NO_OVERLAP;
}

export function firstOverlap(
  volumes: CellVolumes,
  index: VolumeIndex,
  ignore: OwnerFilter,
  out: OverlapHit,
): boolean {
  return firstOverlapFrom(volumes, index, ignore, out, NO_OVERLAP) !== NO_OVERLAP;
}

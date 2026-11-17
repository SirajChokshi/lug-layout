import { CHUNK_STUDS, STUD_LDU } from "@brr/math";
import { cellChunkKey } from "./volume-index.ts";

const CELLS_PER_CHUNK = CHUNK_STUDS * CHUNK_STUDS;
const FIELDS = 7;
const OWNER = 0;
const X = 1;
const Z = 2;
const BASE = 3;
const TOP = 4;
const RADIUS = 5;
const NEXT = 6;
const NO_RECORD = -1;
const INITIAL_RECORDS = 64;
const EMPTY = new Float64Array(0);

function cellIndex(cellX: number, cellZ: number): number {
  const x = cellX - Math.floor(cellX / CHUNK_STUDS) * CHUNK_STUDS;
  const z = cellZ - Math.floor(cellZ / CHUNK_STUDS) * CHUNK_STUDS;
  return z * CHUNK_STUDS + x;
}

export function firstCellTouched(centre: number, radius: number): number {
  return Math.floor((centre - radius) / STUD_LDU);
}

export function lastCellTouched(centre: number, radius: number): number {
  return Math.ceil((centre + radius) / STUD_LDU) - 1;
}

class StudChunk {
  readonly heads = new Int32Array(CELLS_PER_CHUNK).fill(NO_RECORD);
  records = new Float64Array(INITIAL_RECORDS * FIELDS);
  count = 0;

  push(
    cell: number,
    owner: number,
    x: number,
    z: number,
    base: number,
    top: number,
    radius: number,
  ): void {
    if ((this.count + 1) * FIELDS > this.records.length) {
      const grown = new Float64Array(this.records.length * 2);
      grown.set(this.records);
      this.records = grown;
    }
    const r = this.count++ * FIELDS;
    this.records[r + OWNER] = owner;
    this.records[r + X] = x;
    this.records[r + Z] = z;
    this.records[r + BASE] = base;
    this.records[r + TOP] = top;
    this.records[r + RADIUS] = radius;
    this.records[r + NEXT] = this.heads[cell] ?? NO_RECORD;
    this.heads[cell] = r;
  }
}

export class StudCursor {
  private records: Float64Array = EMPTY;
  private r = NO_RECORD;

  start(records: Float64Array, head: number): void {
    this.records = records;
    this.r = head;
  }

  get valid(): boolean {
    return this.r !== NO_RECORD;
  }

  advance(): void {
    this.r = this.records[this.r + NEXT] ?? NO_RECORD;
  }

  get owner(): number {
    return this.records[this.r + OWNER] ?? 0;
  }

  get x(): number {
    return this.records[this.r + X] ?? 0;
  }

  get z(): number {
    return this.records[this.r + Z] ?? 0;
  }

  get baseLdu(): number {
    return this.records[this.r + BASE] ?? 0;
  }

  get topLdu(): number {
    return this.records[this.r + TOP] ?? 0;
  }

  get radius(): number {
    return this.records[this.r + RADIUS] ?? 0;
  }
}

export class StudIndex {
  private readonly byKey = new Map<number, StudChunk>();

  add(
    owner: number,
    x: number,
    z: number,
    baseLdu: number,
    topLdu: number,
    radius: number,
    onlyChunk: number | null,
  ): void {
    if (!(radius > 0) || !(topLdu > baseLdu)) {
      throw new RangeError(
        `stud at ${x}, ${z} has no extent (radius ${radius}, ${baseLdu} to ${topLdu})`,
      );
    }
    for (let cz = firstCellTouched(z, radius); cz <= lastCellTouched(z, radius); cz++) {
      for (let cx = firstCellTouched(x, radius); cx <= lastCellTouched(x, radius); cx++) {
        const key = cellChunkKey(cx, cz);
        if (onlyChunk !== null && key !== onlyChunk) continue;
        let chunk = this.byKey.get(key);
        if (!chunk) {
          chunk = new StudChunk();
          this.byKey.set(key, chunk);
        }
        chunk.push(cellIndex(cx, cz), owner, x, z, baseLdu, topLdu, radius);
      }
    }
  }

  cursor(cellX: number, cellZ: number, out: StudCursor): void {
    const chunk = this.byKey.get(cellChunkKey(cellX, cellZ));
    if (!chunk) out.start(EMPTY, NO_RECORD);
    else out.start(chunk.records, chunk.heads[cellIndex(cellX, cellZ)] ?? NO_RECORD);
  }

  clearChunk(key: number): void {
    this.byKey.delete(key);
  }
}

const POINT_FIELDS = 4;
const POINT_X = 0;
const POINT_Z = 1;
const POINT_BOTTOM = 2;
const POINT_NEXT = 3;

class PointChunk {
  readonly heads = new Int32Array(CELLS_PER_CHUNK).fill(NO_RECORD);
  records = new Int32Array(INITIAL_RECORDS * POINT_FIELDS);
  count = 0;
}

export class ReceptacleIndex {
  private readonly byKey = new Map<number, PointChunk>();

  add(x: number, z: number, bottomLdu: number, onlyChunk: number | null): void {
    const cellX = Math.floor(x / STUD_LDU);
    const cellZ = Math.floor(z / STUD_LDU);
    const key = cellChunkKey(cellX, cellZ);
    if (onlyChunk !== null && key !== onlyChunk) return;
    let chunk = this.byKey.get(key);
    if (!chunk) {
      chunk = new PointChunk();
      this.byKey.set(key, chunk);
    }
    if ((chunk.count + 1) * POINT_FIELDS > chunk.records.length) {
      const grown = new Int32Array(chunk.records.length * 2);
      grown.set(chunk.records);
      chunk.records = grown;
    }
    const cell = cellIndex(cellX, cellZ);
    const r = chunk.count++ * POINT_FIELDS;
    chunk.records[r + POINT_X] = x;
    chunk.records[r + POINT_Z] = z;
    chunk.records[r + POINT_BOTTOM] = bottomLdu;
    chunk.records[r + POINT_NEXT] = chunk.heads[cell] ?? NO_RECORD;
    chunk.heads[cell] = r;
  }

  has(x: number, z: number, bottomLdu: number): boolean {
    if (!Number.isInteger(x) || !Number.isInteger(z)) return false;
    const cellX = Math.floor(x / STUD_LDU);
    const cellZ = Math.floor(z / STUD_LDU);
    const chunk = this.byKey.get(cellChunkKey(cellX, cellZ));
    if (!chunk) return false;
    for (let r = chunk.heads[cellIndex(cellX, cellZ)] ?? NO_RECORD; r !== NO_RECORD;) {
      if (
        chunk.records[r + POINT_X] === x &&
        chunk.records[r + POINT_Z] === z &&
        chunk.records[r + POINT_BOTTOM] === bottomLdu
      ) {
        return true;
      }
      r = chunk.records[r + POINT_NEXT] ?? NO_RECORD;
    }
    return false;
  }

  clearChunk(key: number): void {
    this.byKey.delete(key);
  }
}

const QUAD_LOW_X = 0b0101;
const QUAD_HIGH_X = 0b1010;
const QUAD_LOW_Z = 0b0011;
const QUAD_HIGH_Z = 0b1100;
const HALF_CELL = STUD_LDU / 2;

function axisQuads(
  cell: number,
  centre: number,
  radius: number,
  low: number,
  high: number,
): number {
  const edge = cell * STUD_LDU;
  let quads = 0;
  if (edge < centre + radius && edge + HALF_CELL > centre - radius) quads |= low;
  if (edge + HALF_CELL < centre + radius && edge + STUD_LDU > centre - radius) quads |= high;
  return quads;
}

export function studQuads(
  cellX: number,
  cellZ: number,
  x: number,
  z: number,
  radius: number,
): number {
  return (
    axisQuads(cellX, x, radius, QUAD_LOW_X, QUAD_HIGH_X) &
    axisQuads(cellZ, z, radius, QUAD_LOW_Z, QUAD_HIGH_Z)
  );
}

export function quadCell(corner: number): number {
  return Math.floor(corner / STUD_LDU);
}

export function quadBit(cornerX: number, cornerZ: number): number {
  const highX = cornerX - quadCell(cornerX) * STUD_LDU >= HALF_CELL;
  const highZ = cornerZ - quadCell(cornerZ) * STUD_LDU >= HALF_CELL;
  return (highX ? QUAD_HIGH_X : QUAD_LOW_X) & (highZ ? QUAD_HIGH_Z : QUAD_LOW_Z);
}

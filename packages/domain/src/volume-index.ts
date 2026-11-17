import { CHUNK_STUDS, chunkKey } from "@brr/math";

const CELLS_PER_CHUNK = CHUNK_STUDS * CHUNK_STUDS;
const RECORD_FIELDS = 4;
const OWNER = 0;
const BOTTOM = 1;
const TOP = 2;
const NEXT = 3;
const NO_RECORD = -1;
const INITIAL_RECORDS = 256;
export const NO_VOLUME_TOP = -0x8000_0000;

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

class VolumeChunk {
  readonly heads = new Int32Array(CELLS_PER_CHUNK).fill(NO_RECORD);
  records = new Int32Array(INITIAL_RECORDS * RECORD_FIELDS);
  count = 0;

  push(cell: number, owner: number, bottom: number, top: number): void {
    if ((this.count + 1) * RECORD_FIELDS > this.records.length) {
      const grown = new Int32Array(this.records.length * 2);
      grown.set(this.records);
      this.records = grown;
    }
    const r = this.count++ * RECORD_FIELDS;
    this.records[r + OWNER] = owner;
    this.records[r + BOTTOM] = bottom;
    this.records[r + TOP] = top;
    this.records[r + NEXT] = this.heads[cell] ?? NO_RECORD;
    this.heads[cell] = r;
  }
}

export interface VolumeHit {
  owner: number;
  bottomLdu: number;
  topLdu: number;
}

export type OwnerFilter = (owner: number) => boolean;

export class VolumeIndex {
  private readonly byKey = new Map<number, VolumeChunk>();

  add(owner: number, cellX: number, cellZ: number, bottomLdu: number, topLdu: number): void {
    if (!Number.isInteger(bottomLdu) || !Number.isInteger(topLdu) || topLdu <= bottomLdu) {
      throw new RangeError(`volume [${bottomLdu}, ${topLdu}) LDU is not a non-empty integer span`);
    }
    const key = cellChunkKey(cellX, cellZ);
    let chunk = this.byKey.get(key);
    if (!chunk) {
      chunk = new VolumeChunk();
      this.byKey.set(key, chunk);
    }
    chunk.push(cellIndex(cellX, cellZ), owner, bottomLdu, topLdu);
  }

  topAt(cellX: number, cellZ: number): number {
    const chunk = this.byKey.get(cellChunkKey(cellX, cellZ));
    if (!chunk) return NO_VOLUME_TOP;
    let top = NO_VOLUME_TOP;
    for (let r = chunk.heads[cellIndex(cellX, cellZ)] ?? NO_RECORD; r !== NO_RECORD;) {
      const t = chunk.records[r + TOP] ?? NO_VOLUME_TOP;
      if (t > top) top = t;
      r = chunk.records[r + NEXT] ?? NO_RECORD;
    }
    return top;
  }

  topOwnerAt(cellX: number, cellZ: number, out: VolumeHit): boolean {
    const chunk = this.byKey.get(cellChunkKey(cellX, cellZ));
    if (!chunk) return false;
    let found = false;
    for (let r = chunk.heads[cellIndex(cellX, cellZ)] ?? NO_RECORD; r !== NO_RECORD;) {
      const t = chunk.records[r + TOP] ?? NO_VOLUME_TOP;
      if (!found || t > out.topLdu) {
        out.owner = chunk.records[r + OWNER] ?? 0;
        out.bottomLdu = chunk.records[r + BOTTOM] ?? 0;
        out.topLdu = t;
        found = true;
      }
      r = chunk.records[r + NEXT] ?? NO_RECORD;
    }
    return found;
  }

  firstOverlap(
    cellX: number,
    cellZ: number,
    bottomLdu: number,
    topLdu: number,
    ignore: OwnerFilter,
    out: VolumeHit,
  ): boolean {
    const chunk = this.byKey.get(cellChunkKey(cellX, cellZ));
    if (!chunk) return false;
    for (let r = chunk.heads[cellIndex(cellX, cellZ)] ?? NO_RECORD; r !== NO_RECORD;) {
      const owner = chunk.records[r + OWNER] ?? 0;
      const b = chunk.records[r + BOTTOM] ?? 0;
      const t = chunk.records[r + TOP] ?? 0;
      if (!ignore(owner) && Math.max(b, bottomLdu) < Math.min(t, topLdu)) {
        out.owner = owner;
        out.bottomLdu = b;
        out.topLdu = t;
        return true;
      }
      r = chunk.records[r + NEXT] ?? NO_RECORD;
    }
    return false;
  }

  ownersAt(cellX: number, cellZ: number, out: Set<number>): void {
    const chunk = this.byKey.get(cellChunkKey(cellX, cellZ));
    if (!chunk) return;
    for (let r = chunk.heads[cellIndex(cellX, cellZ)] ?? NO_RECORD; r !== NO_RECORD;) {
      out.add(chunk.records[r + OWNER] ?? 0);
      r = chunk.records[r + NEXT] ?? NO_RECORD;
    }
  }

  clearChunk(key: number): void {
    this.byKey.delete(key);
  }
}

export interface CellVolumes {
  readonly count: number;
  readonly cellX: Int32Array;
  readonly cellZ: Int32Array;
  readonly bottomLdu: Int32Array;
  readonly topLdu: Int32Array;
}

export interface Overlap {
  readonly cellX: number;
  readonly cellZ: number;
  readonly owner: number;
  readonly bottomLdu: number;
  readonly topLdu: number;
  readonly candidateBottomLdu: number;
  readonly candidateTopLdu: number;
}

export function firstOverlap(
  volumes: CellVolumes,
  index: VolumeIndex,
  ignore: OwnerFilter,
): Overlap | null {
  const hit: VolumeHit = { owner: 0, bottomLdu: 0, topLdu: 0 };
  for (let c = 0; c < volumes.count; c++) {
    const x = volumes.cellX[c] ?? 0;
    const z = volumes.cellZ[c] ?? 0;
    const bottom = volumes.bottomLdu[c] ?? 0;
    const top = volumes.topLdu[c] ?? 0;
    if (top <= bottom) continue;
    if (index.firstOverlap(x, z, bottom, top, ignore, hit)) {
      return {
        cellX: x,
        cellZ: z,
        owner: hit.owner,
        bottomLdu: hit.bottomLdu,
        topLdu: hit.topLdu,
        candidateBottomLdu: bottom,
        candidateTopLdu: top,
      };
    }
  }
  return null;
}

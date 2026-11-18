import { CHUNK_STUDS } from "@brr/math";

const CELLS_PER_CHUNK = CHUNK_STUDS * CHUNK_STUDS;
const RECORD_FIELDS = 4;
const OWNER = 0;
const BOTTOM = 1;
const TOP = 2;
const NEXT = 3;
const NO_RECORD = -1;
const INITIAL_RECORDS = 256;

function chunkOfCell(cell: number): number {
  return Math.floor(cell / CHUNK_STUDS);
}

function cellIndex(cellX: number, cellZ: number): number {
  const x = cellX - chunkOfCell(cellX) * CHUNK_STUDS;
  const z = cellZ - chunkOfCell(cellZ) * CHUNK_STUDS;
  return z * CHUNK_STUDS + x;
}

class VolumeChunk {
  readonly heads = new Int32Array(CELLS_PER_CHUNK).fill(NO_RECORD);
  records = new Int32Array(INITIAL_RECORDS * RECORD_FIELDS);
  private used = 0;
  private free = NO_RECORD;

  push(cell: number, owner: number, bottom: number, top: number): void {
    let r = this.free;
    if (r !== NO_RECORD) {
      this.free = this.records[r + NEXT] ?? NO_RECORD;
    } else {
      if ((this.used + 1) * RECORD_FIELDS > this.records.length) {
        const grown = new Int32Array(this.records.length * 2);
        grown.set(this.records);
        this.records = grown;
      }
      r = this.used++ * RECORD_FIELDS;
    }
    this.records[r + OWNER] = owner;
    this.records[r + BOTTOM] = bottom;
    this.records[r + TOP] = top;
    this.records[r + NEXT] = this.heads[cell] ?? NO_RECORD;
    this.heads[cell] = r;
  }

  unlink(cell: number, owner: number, bottom: number, top: number): boolean {
    let previous = NO_RECORD;
    for (
      let r = this.heads[cell] ?? NO_RECORD;
      r !== NO_RECORD;
      r = this.records[r + NEXT] ?? NO_RECORD
    ) {
      const same =
        this.records[r + OWNER] === owner &&
        this.records[r + BOTTOM] === bottom &&
        this.records[r + TOP] === top;
      if (!same) {
        previous = r;
        continue;
      }
      const next = this.records[r + NEXT] ?? NO_RECORD;
      if (previous === NO_RECORD) this.heads[cell] = next;
      else this.records[previous + NEXT] = next;
      this.records[r + NEXT] = this.free;
      this.free = r;
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
  private readonly byChunkX = new Map<number, Map<number, VolumeChunk>>();

  add(owner: number, cellX: number, cellZ: number, bottomLdu: number, topLdu: number): void {
    if (!Number.isInteger(bottomLdu) || !Number.isInteger(topLdu) || topLdu <= bottomLdu) {
      throw new RangeError(`volume [${bottomLdu}, ${topLdu}) LDU is not a non-empty integer span`);
    }
    const chunkX = chunkOfCell(cellX);
    const chunkZ = chunkOfCell(cellZ);
    let rows = this.byChunkX.get(chunkX);
    if (!rows) {
      rows = new Map<number, VolumeChunk>();
      this.byChunkX.set(chunkX, rows);
    }
    let chunk = rows.get(chunkZ);
    if (!chunk) {
      chunk = new VolumeChunk();
      rows.set(chunkZ, chunk);
    }
    chunk.push(cellIndex(cellX, cellZ), owner, bottomLdu, topLdu);
  }

  remove(owner: number, cellX: number, cellZ: number, bottomLdu: number, topLdu: number): void {
    const chunk = this.chunkAt(cellX, cellZ);
    if (!chunk?.unlink(cellIndex(cellX, cellZ), owner, bottomLdu, topLdu)) {
      throw new RangeError(
        `owner ${owner} has no volume [${bottomLdu}, ${topLdu}) at cell ${cellX}, ${cellZ}`,
      );
    }
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
    for (let r = chunk.heads[cellIndex(cellX, cellZ)] ?? NO_RECORD; r !== NO_RECORD;) {
      const owner = chunk.records[r + OWNER] ?? 0;
      const b = chunk.records[r + BOTTOM] ?? 0;
      const t = chunk.records[r + TOP] ?? 0;
      if (Math.max(b, bottomLdu) < Math.min(t, topLdu) && !ignore(owner, cellX, cellZ)) {
        out.owner = owner;
        out.bottomLdu = b;
        out.topLdu = t;
        return true;
      }
      r = chunk.records[r + NEXT] ?? NO_RECORD;
    }
    return false;
  }

  private chunkAt(cellX: number, cellZ: number): VolumeChunk | undefined {
    return this.byChunkX.get(chunkOfCell(cellX))?.get(chunkOfCell(cellZ));
  }
}

export interface CellVolumes {
  readonly count: number;
  readonly cellX: Int32Array;
  readonly cellZ: Int32Array;
  readonly bottomLdu: Int32Array;
  readonly topLdu: Int32Array;
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

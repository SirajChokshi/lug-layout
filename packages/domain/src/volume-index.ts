import { CHUNK_STUDS } from "@brr/math";

const CELLS_PER_CHUNK = CHUNK_STUDS * CHUNK_STUDS;
const RECORD_FIELDS = 4;
const OWNER = 0;
const BOTTOM = 1;
const TOP = 2;
const NEXT = 3;
const NO_RECORD = -1;
const GROWTH = 1.25;
export const NO_VOLUME_TOP = -0x8000_0000;

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
  records = new Int32Array(0);
  incoming = 0;
  private used = 0;
  private free = NO_RECORD;
  private freed = 0;

  reserveIncoming(): void {
    const appended = Math.max(0, this.incoming - this.freed);
    this.incoming = 0;
    const needed = (this.used + appended) * RECORD_FIELDS;
    if (needed <= this.records.length) return;
    const stepped = Math.ceil((this.records.length / RECORD_FIELDS) * GROWTH) * RECORD_FIELDS;
    const grown = new Int32Array(Math.max(needed, stepped));
    grown.set(this.records);
    this.records = grown;
  }

  push(cell: number, owner: number, bottom: number, top: number): void {
    let r = this.free;
    if (r !== NO_RECORD) {
      this.free = this.records[r + NEXT] ?? NO_RECORD;
      this.freed--;
    } else {
      if ((this.used + 1) * RECORD_FIELDS > this.records.length) {
        throw new RangeError(`chunk records were not reserved for cell ${cell}`);
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
      this.freed++;
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

  add(owner: number, volumes: CellVolumes): void {
    for (let c = 0; c < volumes.count; c++) {
      const bottom = volumes.bottomLdu[c] ?? 0;
      const top = volumes.topLdu[c] ?? 0;
      if (!Number.isInteger(bottom) || !Number.isInteger(top)) {
        throw new RangeError(`volume [${bottom}, ${top}) LDU is not an integer span`);
      }
      if (top <= bottom) continue;
      this.chunkFor(volumes.cellX[c] ?? 0, volumes.cellZ[c] ?? 0).incoming++;
    }
    for (let c = 0; c < volumes.count; c++) {
      const bottom = volumes.bottomLdu[c] ?? 0;
      const top = volumes.topLdu[c] ?? 0;
      if (top <= bottom) continue;
      const cellX = volumes.cellX[c] ?? 0;
      const cellZ = volumes.cellZ[c] ?? 0;
      const chunk = this.chunkFor(cellX, cellZ);
      if (chunk.incoming > 0) chunk.reserveIncoming();
      chunk.push(cellIndex(cellX, cellZ), owner, bottom, top);
    }
  }

  remove(owner: number, volumes: CellVolumes): void {
    for (let c = 0; c < volumes.count; c++) {
      const bottom = volumes.bottomLdu[c] ?? 0;
      const top = volumes.topLdu[c] ?? 0;
      if (top <= bottom) continue;
      const cellX = volumes.cellX[c] ?? 0;
      const cellZ = volumes.cellZ[c] ?? 0;
      if (!this.chunkAt(cellX, cellZ)?.unlink(cellIndex(cellX, cellZ), owner, bottom, top)) {
        throw new RangeError(
          `owner ${owner} has no volume [${bottom}, ${top}) at cell ${cellX}, ${cellZ}`,
        );
      }
    }
  }

  topAt(cellX: number, cellZ: number): number {
    const chunk = this.chunkAt(cellX, cellZ);
    if (!chunk) return NO_VOLUME_TOP;
    let top = NO_VOLUME_TOP;
    for (let r = chunk.heads[cellIndex(cellX, cellZ)] ?? NO_RECORD; r !== NO_RECORD;) {
      const t = chunk.records[r + TOP] ?? NO_VOLUME_TOP;
      if (t > top) top = t;
      r = chunk.records[r + NEXT] ?? NO_RECORD;
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

  private chunkFor(cellX: number, cellZ: number): VolumeChunk {
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

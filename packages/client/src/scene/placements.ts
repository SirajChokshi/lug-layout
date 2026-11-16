import { INSTANCE_MATRIX_FLOATS, type ChunkInstances } from "@brr/render";

export const STUD_LDU = 20;
export const PLATE_LDU = 8;
export const CHUNK_STUDS = 32;
export const CHUNK_LDU = CHUNK_STUDS * STUD_LDU;

const CHUNK_KEY_OFFSET = 32768;
const CHUNK_KEY_STRIDE = 65536;
const INITIAL_CAPACITY = 1024;
const QUARTER_TURN_COS = Int8Array.of(1, 0, -1, 0);
const QUARTER_TURN_SIN = Int8Array.of(0, 1, 0, -1);

export interface ChunkPlacements {
  readonly key: number;
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly count: number;
  readonly partIndex: Uint16Array;
  readonly colorIndex: Uint16Array;
  readonly x: Int32Array;
  readonly z: Int32Array;
  readonly yPlates: Int16Array;
  readonly rot: Uint8Array;
}

export function chunkKey(chunkX: number, chunkZ: number): number {
  return (chunkX + CHUNK_KEY_OFFSET) * CHUNK_KEY_STRIDE + (chunkZ + CHUNK_KEY_OFFSET);
}

function copyInto<T extends Uint16Array | Int32Array | Int16Array | Uint8Array>(
  old: T,
  next: T,
): T {
  next.set(old);
  return next;
}

export class PlacementWriter {
  count = 0;
  private capacity = INITIAL_CAPACITY;
  private partIndex = new Uint16Array(INITIAL_CAPACITY);
  private colorIndex = new Uint16Array(INITIAL_CAPACITY);
  private x = new Int32Array(INITIAL_CAPACITY);
  private z = new Int32Array(INITIAL_CAPACITY);
  private yPlates = new Int16Array(INITIAL_CAPACITY);
  private rot = new Uint8Array(INITIAL_CAPACITY);

  private grow(): void {
    this.capacity *= 2;
    this.partIndex = copyInto(this.partIndex, new Uint16Array(this.capacity));
    this.colorIndex = copyInto(this.colorIndex, new Uint16Array(this.capacity));
    this.x = copyInto(this.x, new Int32Array(this.capacity));
    this.z = copyInto(this.z, new Int32Array(this.capacity));
    this.yPlates = copyInto(this.yPlates, new Int16Array(this.capacity));
    this.rot = copyInto(this.rot, new Uint8Array(this.capacity));
  }

  push(part: number, color: number, x: number, z: number, yPlates: number, rot: number): void {
    if (!Number.isInteger(x) || !Number.isInteger(z) || !Number.isInteger(yPlates)) {
      throw new Error(`placement (${x}, ${yPlates}, ${z}) is off the integer LDU lattice`);
    }
    if (this.count === this.capacity) this.grow();
    const i = this.count++;
    this.partIndex[i] = part;
    this.colorIndex[i] = color;
    this.x[i] = x;
    this.z[i] = z;
    this.yPlates[i] = yPlates;
    this.rot[i] = rot;
  }

  finish(chunkX: number, chunkZ: number): ChunkPlacements {
    const n = this.count;
    return {
      key: chunkKey(chunkX, chunkZ),
      chunkX,
      chunkZ,
      count: n,
      partIndex: this.partIndex.slice(0, n),
      colorIndex: this.colorIndex.slice(0, n),
      x: this.x.slice(0, n),
      z: this.z.slice(0, n),
      yPlates: this.yPlates.slice(0, n),
      rot: this.rot.slice(0, n),
    };
  }
}

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

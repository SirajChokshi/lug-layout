import { CHUNK_LDU, chunkKey, chunkOf, isLatticePose, isRot90 } from "@brr/math";

const INITIAL_CHUNK_CAPACITY = 1024;

export interface ChunkView {
  readonly key: number;
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly originX: number;
  readonly originZ: number;
  readonly count: number;
  readonly refId: Uint32Array;
  readonly colorId: Uint16Array;
  readonly x: Int32Array;
  readonly z: Int32Array;
  readonly yPlates: Int16Array;
  readonly rot: Uint8Array;
}

function grown<T extends Uint32Array | Uint16Array | Int32Array | Int16Array | Uint8Array>(
  old: T,
  next: T,
): T {
  next.set(old);
  return next;
}

class Chunk {
  count = 0;
  private capacity = INITIAL_CHUNK_CAPACITY;
  private refId = new Uint32Array(INITIAL_CHUNK_CAPACITY);
  private colorId = new Uint16Array(INITIAL_CHUNK_CAPACITY);
  private x = new Int32Array(INITIAL_CHUNK_CAPACITY);
  private z = new Int32Array(INITIAL_CHUNK_CAPACITY);
  private yPlates = new Int16Array(INITIAL_CHUNK_CAPACITY);
  private rot = new Uint8Array(INITIAL_CHUNK_CAPACITY);

  constructor(
    readonly key: number,
    readonly chunkX: number,
    readonly chunkZ: number,
  ) {}

  private grow(): void {
    this.capacity *= 2;
    this.refId = grown(this.refId, new Uint32Array(this.capacity));
    this.colorId = grown(this.colorId, new Uint16Array(this.capacity));
    this.x = grown(this.x, new Int32Array(this.capacity));
    this.z = grown(this.z, new Int32Array(this.capacity));
    this.yPlates = grown(this.yPlates, new Int16Array(this.capacity));
    this.rot = grown(this.rot, new Uint8Array(this.capacity));
  }

  push(refId: number, colorId: number, x: number, z: number, yPlates: number, rot: number): void {
    if (this.count === this.capacity) this.grow();
    const slot = this.count++;
    this.refId[slot] = refId;
    this.colorId[slot] = colorId;
    this.x[slot] = x;
    this.z[slot] = z;
    this.yPlates[slot] = yPlates;
    this.rot[slot] = rot;
  }

  view(): ChunkView {
    const n = this.count;
    return {
      key: this.key,
      chunkX: this.chunkX,
      chunkZ: this.chunkZ,
      originX: this.chunkX * CHUNK_LDU,
      originZ: this.chunkZ * CHUNK_LDU,
      count: n,
      refId: this.refId.subarray(0, n),
      colorId: this.colorId.subarray(0, n),
      x: this.x.subarray(0, n),
      z: this.z.subarray(0, n),
      yPlates: this.yPlates.subarray(0, n),
      rot: this.rot.subarray(0, n),
    };
  }
}

export class World {
  private readonly byKey = new Map<number, Chunk>();
  private readonly ordered: Chunk[] = [];

  add(refId: number, colorId: number, x: number, z: number, yPlates: number, rot: number): void {
    if (!isLatticePose(x, z, yPlates)) {
      throw new Error(`placement (${x}, ${yPlates}, ${z}) is off the integer LDU lattice`);
    }
    if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
    const chunkX = chunkOf(x);
    const chunkZ = chunkOf(z);
    const key = chunkKey(chunkX, chunkZ);
    let chunk = this.byKey.get(key);
    if (!chunk) {
      chunk = new Chunk(key, chunkX, chunkZ);
      this.byKey.set(key, chunk);
      this.ordered.push(chunk);
    }
    chunk.push(refId, colorId, x, z, yPlates, rot);
  }

  chunks(): ReadonlyArray<ChunkView> {
    return this.ordered.map((chunk) => chunk.view());
  }
}

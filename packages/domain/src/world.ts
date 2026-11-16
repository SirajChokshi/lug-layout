import { CHUNK_LDU, chunkKey, chunkOf, isLatticePose, isRot90 } from "@brr/math";

const INITIAL_CHUNK_CAPACITY = 1024;
export const SLOT_LIVE = 1;

export interface ChunkView {
  readonly key: number;
  readonly originX: number;
  readonly originZ: number;
  readonly count: number;
  readonly liveCount: number;
  readonly flags: Uint8Array;
  readonly refId: Uint32Array;
  readonly colorId: Uint16Array;
  readonly x: Int32Array;
  readonly z: Int32Array;
  readonly yPlates: Int16Array;
  readonly rot: Uint8Array;
}

export interface PlacementHandle {
  readonly chunkKey: number;
  readonly slot: number;
  readonly generation: number;
  readonly live: boolean;
  readonly refId: number;
  readonly colorId: number;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
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
  liveCount = 0;
  private capacity = INITIAL_CHUNK_CAPACITY;
  flags = new Uint8Array(INITIAL_CHUNK_CAPACITY);
  generation = new Uint32Array(INITIAL_CHUNK_CAPACITY);
  refId = new Uint32Array(INITIAL_CHUNK_CAPACITY);
  colorId = new Uint16Array(INITIAL_CHUNK_CAPACITY);
  x = new Int32Array(INITIAL_CHUNK_CAPACITY);
  z = new Int32Array(INITIAL_CHUNK_CAPACITY);
  yPlates = new Int16Array(INITIAL_CHUNK_CAPACITY);
  rot = new Uint8Array(INITIAL_CHUNK_CAPACITY);
  private freeSlots = new Uint32Array(INITIAL_CHUNK_CAPACITY);
  private freeCount = 0;

  readonly originX: number;
  readonly originZ: number;

  constructor(
    readonly key: number,
    chunkX: number,
    chunkZ: number,
  ) {
    this.originX = chunkX * CHUNK_LDU;
    this.originZ = chunkZ * CHUNK_LDU;
  }

  private grow(): void {
    this.capacity *= 2;
    this.flags = grown(this.flags, new Uint8Array(this.capacity));
    this.generation = grown(this.generation, new Uint32Array(this.capacity));
    this.refId = grown(this.refId, new Uint32Array(this.capacity));
    this.colorId = grown(this.colorId, new Uint16Array(this.capacity));
    this.x = grown(this.x, new Int32Array(this.capacity));
    this.z = grown(this.z, new Int32Array(this.capacity));
    this.yPlates = grown(this.yPlates, new Int16Array(this.capacity));
    this.rot = grown(this.rot, new Uint8Array(this.capacity));
    this.freeSlots = grown(this.freeSlots, new Uint32Array(this.capacity));
  }

  private takeSlot(): number {
    if (this.freeCount > 0) {
      this.freeCount--;
      return this.freeSlots[this.freeCount] ?? 0;
    }
    if (this.count === this.capacity) this.grow();
    return this.count++;
  }

  push(refId: number, colorId: number, x: number, z: number, yPlates: number, rot: number): number {
    const slot = this.takeSlot();
    this.flags[slot] = SLOT_LIVE;
    this.refId[slot] = refId;
    this.colorId[slot] = colorId;
    this.x[slot] = x;
    this.z[slot] = z;
    this.yPlates[slot] = yPlates;
    this.rot[slot] = rot;
    this.liveCount++;
    return slot;
  }

  isLive(slot: number, generation: number): boolean {
    return (
      slot < this.count &&
      ((this.flags[slot] ?? 0) & SLOT_LIVE) !== 0 &&
      this.generation[slot] === generation
    );
  }

  release(slot: number): void {
    this.flags[slot] = 0;
    this.generation[slot] = ((this.generation[slot] ?? 0) + 1) >>> 0;
    this.freeSlots[this.freeCount++] = slot;
    this.liveCount--;
  }

  view(): ChunkView {
    const n = this.count;
    return {
      key: this.key,
      originX: this.originX,
      originZ: this.originZ,
      count: n,
      liveCount: this.liveCount,
      flags: this.flags.subarray(0, n),
      refId: this.refId.subarray(0, n),
      colorId: this.colorId.subarray(0, n),
      x: this.x.subarray(0, n),
      z: this.z.subarray(0, n),
      yPlates: this.yPlates.subarray(0, n),
      rot: this.rot.subarray(0, n),
    };
  }
}

class SlotHandle implements PlacementHandle {
  constructor(
    private readonly chunk: Chunk,
    readonly slot: number,
    readonly generation: number,
  ) {}

  get chunkKey(): number {
    return this.chunk.key;
  }

  get live(): boolean {
    return this.chunk.isLive(this.slot, this.generation);
  }

  private liveSlot(): number {
    if (!this.live) {
      throw new Error(`placement handle (chunk ${this.chunk.key}, slot ${this.slot}) is stale`);
    }
    return this.slot;
  }

  get refId(): number {
    return this.chunk.refId[this.liveSlot()] ?? 0;
  }

  get colorId(): number {
    return this.chunk.colorId[this.liveSlot()] ?? 0;
  }

  get x(): number {
    return this.chunk.x[this.liveSlot()] ?? 0;
  }

  get z(): number {
    return this.chunk.z[this.liveSlot()] ?? 0;
  }

  get yPlates(): number {
    return this.chunk.yPlates[this.liveSlot()] ?? 0;
  }

  get rot(): number {
    return this.chunk.rot[this.liveSlot()] ?? 0;
  }

  belongsTo(chunk: Chunk): boolean {
    return chunk === this.chunk;
  }
}

export class World {
  private readonly byKey = new Map<number, Chunk>();
  private readonly ordered: Chunk[] = [];
  private live = 0;

  get size(): number {
    return this.live;
  }

  add(
    refId: number,
    colorId: number,
    x: number,
    z: number,
    yPlates: number,
    rot: number,
  ): PlacementHandle {
    if (!isLatticePose(x, z, yPlates)) {
      throw new RangeError(
        `placement (${x}, ${yPlates}, ${z}) is not an integer pose within int32 x/z and int16 yPlates`,
      );
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
    const slot = chunk.push(refId, colorId, x, z, yPlates, rot);
    this.live++;
    return new SlotHandle(chunk, slot, chunk.generation[slot] ?? 0);
  }

  remove(handle: PlacementHandle): void {
    const chunk = this.byKey.get(handle.chunkKey);
    if (!chunk || !(handle instanceof SlotHandle) || !handle.belongsTo(chunk) || !handle.live) {
      throw new Error(
        `placement handle (chunk ${handle.chunkKey}, slot ${handle.slot}) is stale or from another world`,
      );
    }
    chunk.release(handle.slot);
    this.live--;
  }

  chunks(): ReadonlyArray<ChunkView> {
    return this.ordered.map((chunk) => chunk.view());
  }
}

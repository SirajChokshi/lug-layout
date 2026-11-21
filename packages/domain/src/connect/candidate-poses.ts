export interface LatticePose {
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
}

export interface SnapWindow extends LatticePose {
  readonly cells: number;
  readonly plates: number;
  readonly turns: number;
}

const INITIAL_CAPACITY = 128;
const TABLE_LOAD = 2;
const HASH_X = 0x9e3779b1;
const HASH_Z = 0x85ebca77;
const HASH_Y = 0xc2b2ae3d;
const HASH_ROT = 0x27d4eb2f;

export class CandidatePoses {
  private size = 0;
  private xs: Int32Array;
  private zs: Int32Array;
  private ys: Int32Array;
  private rots: Uint8Array;
  private voteCounts: Int32Array;
  private table: Int32Array;
  private tableEpoch: Int32Array;
  private epoch = 1;
  private tableValid = true;

  constructor(capacity: number = INITIAL_CAPACITY) {
    this.xs = new Int32Array(capacity);
    this.zs = new Int32Array(capacity);
    this.ys = new Int32Array(capacity);
    this.rots = new Uint8Array(capacity);
    this.voteCounts = new Int32Array(capacity);
    this.table = new Int32Array(tableSize(capacity));
    this.tableEpoch = new Int32Array(this.table.length);
  }

  get count(): number {
    return this.size;
  }

  get x(): Int32Array {
    return this.xs;
  }

  get z(): Int32Array {
    return this.zs;
  }

  get yPlates(): Int32Array {
    return this.ys;
  }

  get rot(): Uint8Array {
    return this.rots;
  }

  get votes(): Int32Array {
    return this.voteCounts;
  }

  clear(): void {
    this.size = 0;
    this.nextEpoch();
    this.tableValid = true;
  }

  add(x: number, z: number, yPlates: number, rot: number): void {
    if (!Number.isInteger(x) || !Number.isInteger(z) || !Number.isInteger(yPlates)) {
      throw new RangeError(`candidate ${x}, ${z}, ${yPlates} is not an exact lattice pose`);
    }
    if (!this.tableValid) this.rehash();
    if (this.size === this.xs.length) this.grow();
    const mask = this.table.length - 1;
    let h = hashPose(x, z, yPlates, rot) & mask;
    while (this.tableEpoch[h] === this.epoch) {
      const at = this.table[h] ?? 0;
      if (
        this.xs[at] === x &&
        this.zs[at] === z &&
        this.ys[at] === yPlates &&
        this.rots[at] === rot
      ) {
        return;
      }
      h = (h + 1) & mask;
    }
    const i = this.size++;
    this.xs[i] = x;
    this.zs[i] = z;
    this.ys[i] = yPlates;
    this.rots[i] = rot;
    this.voteCounts[i] = 0;
    this.table[h] = i;
    this.tableEpoch[h] = this.epoch;
  }

  setVotes(index: number, votes: number): void {
    this.voteCounts[index] = votes;
  }

  swap(a: number, b: number): void {
    swapIn(this.xs, a, b);
    swapIn(this.zs, a, b);
    swapIn(this.ys, a, b);
    swapIn(this.rots, a, b);
    swapIn(this.voteCounts, a, b);
    this.tableValid = false;
  }

  private grow(): void {
    const capacity = Math.max(1, this.xs.length * 2);
    this.xs = grown(this.xs, new Int32Array(capacity));
    this.zs = grown(this.zs, new Int32Array(capacity));
    this.ys = grown(this.ys, new Int32Array(capacity));
    this.rots = grown(this.rots, new Uint8Array(capacity));
    this.voteCounts = grown(this.voteCounts, new Int32Array(capacity));
    this.table = new Int32Array(tableSize(capacity));
    this.tableEpoch = new Int32Array(this.table.length);
    this.epoch = 1;
    this.rehash();
  }

  private rehash(): void {
    this.nextEpoch();
    const mask = this.table.length - 1;
    for (let i = 0; i < this.size; i++) {
      let h = hashPose(this.xs[i] ?? 0, this.zs[i] ?? 0, this.ys[i] ?? 0, this.rots[i] ?? 0) & mask;
      while (this.tableEpoch[h] === this.epoch) h = (h + 1) & mask;
      this.table[h] = i;
      this.tableEpoch[h] = this.epoch;
    }
    this.tableValid = true;
  }

  private nextEpoch(): void {
    if (this.epoch === 0x7fffffff) {
      this.tableEpoch.fill(0);
      this.epoch = 0;
    }
    this.epoch++;
  }
}

function tableSize(capacity: number): number {
  let size = 1;
  while (size < capacity * TABLE_LOAD) size *= 2;
  return size;
}

function hashPose(x: number, z: number, yPlates: number, rot: number): number {
  const h =
    Math.imul(x, HASH_X) ^
    Math.imul(z, HASH_Z) ^
    Math.imul(yPlates, HASH_Y) ^
    Math.imul(rot, HASH_ROT);
  return (h ^ (h >>> 15)) >>> 0;
}

function swapIn(values: Int32Array | Uint8Array, a: number, b: number): void {
  const held = values[a] ?? 0;
  values[a] = values[b] ?? 0;
  values[b] = held;
}

function grown<T extends Int32Array | Uint8Array>(from: T, to: T): T {
  to.set(from);
  return to;
}

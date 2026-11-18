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

export class CandidatePoses {
  private size = 0;
  private xs: Int32Array;
  private zs: Int32Array;
  private ys: Int32Array;
  private rots: Uint8Array;
  private voteCounts: Int32Array;

  constructor(capacity: number = INITIAL_CAPACITY) {
    this.xs = new Int32Array(capacity);
    this.zs = new Int32Array(capacity);
    this.ys = new Int32Array(capacity);
    this.rots = new Uint8Array(capacity);
    this.voteCounts = new Int32Array(capacity);
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
  }

  add(x: number, z: number, yPlates: number, rot: number): void {
    if (!Number.isInteger(x) || !Number.isInteger(z) || !Number.isInteger(yPlates)) {
      throw new RangeError(`candidate ${x}, ${z}, ${yPlates} is not an exact lattice pose`);
    }
    for (let i = 0; i < this.size; i++) {
      if (this.xs[i] === x && this.zs[i] === z && this.ys[i] === yPlates && this.rots[i] === rot) {
        return;
      }
    }
    if (this.size === this.xs.length) this.grow();
    const i = this.size++;
    this.xs[i] = x;
    this.zs[i] = z;
    this.ys[i] = yPlates;
    this.rots[i] = rot;
    this.voteCounts[i] = 0;
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
  }

  private grow(): void {
    const capacity = Math.max(1, this.xs.length * 2);
    this.xs = grown(this.xs, new Int32Array(capacity));
    this.zs = grown(this.zs, new Int32Array(capacity));
    this.ys = grown(this.ys, new Int32Array(capacity));
    this.rots = grown(this.rots, new Uint8Array(capacity));
    this.voteCounts = grown(this.voteCounts, new Int32Array(capacity));
  }
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

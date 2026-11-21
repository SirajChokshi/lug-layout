const MEMO_BITS = 15;
const MEMO_SIZE = 1 << MEMO_BITS;
const MEMO_MASK = MEMO_SIZE - 1;
const MEMO_FULL = MEMO_SIZE >>> 1;
const HASH_X = 0x9e3779b1;
const HASH_Z = 0x85ebca77;
const HASH_Y = 0xc2b2ae3d;
const HASH_ROT = 0x27d4eb2f;
const LAST_EPOCH = 0x7fffffff;

export const UNKNOWN = -1;
export const FREE = 1;
export const BLOCKED = 2;

export class PoseMemo {
  readonly dense = new Int32Array(MEMO_SIZE);
  readonly proposal = new Int32Array(MEMO_SIZE);
  readonly proposed = new Uint8Array(MEMO_SIZE);
  readonly verdict = new Int8Array(MEMO_SIZE);
  private readonly xs = new Int32Array(MEMO_SIZE);
  private readonly zs = new Int32Array(MEMO_SIZE);
  private readonly ys = new Int32Array(MEMO_SIZE);
  private readonly rots = new Uint8Array(MEMO_SIZE);
  private readonly epochs = new Int32Array(MEMO_SIZE);
  private epoch = 1;
  private used = 0;

  reset(): void {
    if (this.epoch === LAST_EPOCH) {
      this.epochs.fill(0);
      this.epoch = 0;
    }
    this.epoch++;
    this.used = 0;
  }

  roomFor(entries: number): boolean {
    return this.used + entries <= MEMO_FULL;
  }

  slot(x: number, z: number, yPlates: number, rot: number): number {
    let h = hashPose(x, z, yPlates, rot) & MEMO_MASK;
    while (this.epochs[h] === this.epoch) {
      if (this.xs[h] === x && this.zs[h] === z && this.ys[h] === yPlates && this.rots[h] === rot) {
        return h;
      }
      h = (h + 1) & MEMO_MASK;
    }
    this.epochs[h] = this.epoch;
    this.xs[h] = x;
    this.zs[h] = z;
    this.ys[h] = yPlates;
    this.rots[h] = rot;
    this.dense[h] = UNKNOWN;
    this.proposal[h] = UNKNOWN;
    this.proposed[h] = 0;
    this.verdict[h] = 0;
    this.used++;
    return h;
  }
}

function hashPose(x: number, z: number, yPlates: number, rot: number): number {
  const h =
    Math.imul(x, HASH_X) ^
    Math.imul(z, HASH_Z) ^
    Math.imul(yPlates, HASH_Y) ^
    Math.imul(rot, HASH_ROT);
  return (h ^ (h >>> 15)) >>> 0;
}

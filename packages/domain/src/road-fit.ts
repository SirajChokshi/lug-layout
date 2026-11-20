const MEMO_SHIFT = 12;
const MEMO_SLOTS = 1 << MEMO_SHIFT;
const MEMO_MASK = MEMO_SLOTS - 1;

export const UNKNOWN_FIT = 0;
export const COMPLETE_FIT = 1;
export const CLASHED_FIT = 2;

export type KnownFit = typeof COMPLETE_FIT | typeof CLASHED_FIT;
export type MemoState = typeof UNKNOWN_FIT | KnownFit;

export class RoadFit {
  metCells = 0;
  equalCells = 0;
  joinedCells = 0;
  joinedRoadCells = 0;
  mismatchedCells = 0;
  overlappingCells = 0;

  reset(): this {
    this.metCells = 0;
    this.equalCells = 0;
    this.joinedCells = 0;
    this.joinedRoadCells = 0;
    this.mismatchedCells = 0;
    this.overlappingCells = 0;
    return this;
  }
}

export interface FitKey {
  readonly stamp: object;
  readonly turn: number;
  readonly offsetX: number;
  readonly offsetZ: number;
  readonly phase: number;
  readonly yLdu: number;
}

function slotOf(key: FitKey): number {
  let hash = Math.imul(key.turn + 1, 0x9e3779b1);
  hash ^= Math.imul(key.offsetX, 0x85ebca77);
  hash ^= Math.imul(key.offsetZ, 0xc2b2ae3d);
  hash ^= Math.imul(key.phase, 0x165667b1);
  hash ^= Math.imul(key.yLdu, 0x27d4eb2f);
  hash ^= hash >>> 15;
  return hash & MEMO_MASK;
}

function emptySlots(count: number): Array<object | null> {
  const slots: Array<object | null> = [];
  slots.length = count;
  return slots.fill(null);
}

export class RoadFitMemo {
  private generation = 1;
  private readonly entryGeneration = new Float64Array(MEMO_SLOTS);
  private readonly stamp = emptySlots(MEMO_SLOTS);
  private readonly offsetX = new Int32Array(MEMO_SLOTS);
  private readonly offsetZ = new Int32Array(MEMO_SLOTS);
  private readonly phase = new Int32Array(MEMO_SLOTS);
  private readonly yLdu = new Int32Array(MEMO_SLOTS);
  private readonly state = new Uint8Array(MEMO_SLOTS);
  private readonly met = new Int32Array(MEMO_SLOTS);
  private readonly equal = new Int32Array(MEMO_SLOTS);
  private readonly joined = new Int32Array(MEMO_SLOTS);
  private readonly joinedRoad = new Int32Array(MEMO_SLOTS);
  private readonly mismatched = new Int32Array(MEMO_SLOTS);
  private readonly overlapping = new Int32Array(MEMO_SLOTS);

  forget(): void {
    this.generation++;
  }

  recall(key: FitKey, into: RoadFit): MemoState {
    const s = slotOf(key);
    const known =
      this.entryGeneration[s] === this.generation &&
      this.stamp[s] === key.stamp &&
      this.offsetX[s] === key.offsetX &&
      this.offsetZ[s] === key.offsetZ &&
      this.phase[s] === key.phase &&
      this.yLdu[s] === key.yLdu;
    if (!known) return UNKNOWN_FIT;
    if (this.state[s] === CLASHED_FIT) return CLASHED_FIT;
    into.metCells = this.met[s] ?? 0;
    into.equalCells = this.equal[s] ?? 0;
    into.joinedCells = this.joined[s] ?? 0;
    into.joinedRoadCells = this.joinedRoad[s] ?? 0;
    into.mismatchedCells = this.mismatched[s] ?? 0;
    into.overlappingCells = this.overlapping[s] ?? 0;
    return COMPLETE_FIT;
  }

  remember(key: FitKey, state: KnownFit, counts: RoadFit): void {
    const s = slotOf(key);
    this.entryGeneration[s] = this.generation;
    this.stamp[s] = key.stamp;
    this.offsetX[s] = key.offsetX;
    this.offsetZ[s] = key.offsetZ;
    this.phase[s] = key.phase;
    this.yLdu[s] = key.yLdu;
    this.state[s] = state;
    this.met[s] = counts.metCells;
    this.equal[s] = counts.equalCells;
    this.joined[s] = counts.joinedCells;
    this.joinedRoad[s] = counts.joinedRoadCells;
    this.mismatched[s] = counts.mismatchedCells;
    this.overlapping[s] = counts.overlappingCells;
  }
}

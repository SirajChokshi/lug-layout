import { BLOCK_CLEARANCE_LDU, NO_TRAIN, type BlockKeeper } from "./block-keeper.ts";
import { NO_BLOCK, type BlockMap } from "./block-map.ts";

export interface AutopilotTrains {
  readonly trains: number;
  readonly trainSpeed: Float64Array;
  trainLengthLdu(train: number): number;
  driveAtTopSpeed(train: number): void;
}

const XORSHIFT_A = 13;
const XORSHIFT_B = 17;
const XORSHIFT_C = 5;

export class Autopilot {
  private readonly state = new Uint32Array(1);
  private readonly idleTicks: Int32Array;

  constructor(
    private readonly blocks: BlockMap,
    private readonly keeper: BlockKeeper,
    seed: number,
    trainCapacity: number,
    private readonly dwellTicks: number,
    private readonly retryTicks: number,
  ) {
    this.state[0] = seed === 0 ? 1 : seed;
    this.idleTicks = new Int32Array(trainCapacity);
  }

  update(trains: AutopilotTrains): void {
    for (let train = 0; train < trains.trains; train++) {
      const state = this.keeper.routeState(train);
      const stopped = trains.trainSpeed[train] === 0;
      if (state === "routed" || !stopped) {
        this.idleTicks[train] = 0;
        continue;
      }
      const idle = (this.idleTicks[train] ?? 0) + 1;
      this.idleTicks[train] = idle;
      const due = state === "waiting" ? idle >= this.retryTicks : idle >= this.dwellTicks;
      if (!due) continue;
      const target = this.pickStop(train, trains.trainLengthLdu(train));
      if (target === NO_BLOCK) continue;
      this.keeper.goTo(train, target);
      trains.driveAtTopSpeed(train);
      this.idleTicks[train] = 0;
    }
  }

  private pickStop(train: number, lengthLdu: number): number {
    const current = this.keeper.targetBlock[train] ?? NO_BLOCK;
    let candidates = 0;
    for (let block = 0; block < this.blocks.blockCount; block++) {
      if (this.isFreeStop(block, current, lengthLdu)) candidates++;
    }
    if (candidates === 0) return NO_BLOCK;
    let pick = this.next() % candidates;
    for (let block = 0; block < this.blocks.blockCount; block++) {
      if (!this.isFreeStop(block, current, lengthLdu)) continue;
      if (pick === 0) return block;
      pick--;
    }
    return NO_BLOCK;
  }

  private isFreeStop(block: number, current: number, lengthLdu: number): boolean {
    return (
      block !== current &&
      this.blocks.blockIsJunction[block] === 0 &&
      this.keeper.blockOwner[block] === NO_TRAIN &&
      (this.blocks.blockLengthLdu[block] ?? 0) >= lengthLdu + 2 * BLOCK_CLEARANCE_LDU
    );
  }

  private next(): number {
    let x = this.state[0] ?? 1;
    x ^= x << XORSHIFT_A;
    x ^= x >>> XORSHIFT_B;
    x ^= x << XORSHIFT_C;
    this.state[0] = x;
    return this.state[0] ?? 0;
  }
}

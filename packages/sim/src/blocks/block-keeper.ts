import { NO_EDGE, NO_SWITCH } from "@brr/domain";
import { STUD_LDU } from "@brr/math";
import { RoutePlanner } from "../routing/route-planner.ts";
import { NO_BLOCK, nextEdge, reverseEdge, type BlockMap } from "./block-map.ts";

export const NO_TRAIN = -1;
export const BLOCK_CLEARANCE_LDU = STUD_LDU;
export const ARRIVAL_WINDOW_LDU = STUD_LDU;

export type TrainRouteState = "manual" | "waiting" | "routed" | "arrived" | "reversing";

const MODE_MANUAL = 0;
const MODE_WAITING = 1;
const MODE_ROUTED = 2;
const MODE_ARRIVED = 3;
const MODE_REVERSING = 4;
const MODE_NAMES: ReadonlyArray<TrainRouteState> = [
  "manual",
  "waiting",
  "routed",
  "arrived",
  "reversing",
];

export class BlockKeeper {
  readonly blockOwner: Int32Array;
  readonly arrivals: Uint32Array;
  readonly targetBlock: Int32Array;
  private readonly blockHolds: Int32Array;
  private readonly ringCapacity: number;
  private readonly ringEdge: Int32Array;
  private readonly ringStartS: Float64Array;
  private readonly ringHead: Float64Array;
  private readonly ringNext: Float64Array;
  private readonly frontSeq: Float64Array;
  private readonly lengthLdu: Float64Array;
  private readonly placed: Uint8Array;
  private readonly mode: Uint8Array;
  private readonly planner: RoutePlanner;
  private readonly route: Int32Array;
  private readonly reverseRoute: Int32Array;
  private readonly penalty: Float64Array;
  private readonly occupiedPenaltyLdu: number;

  constructor(
    private readonly blocks: BlockMap,
    readonly trainCapacity: number,
  ) {
    const { graph } = blocks;
    this.blockOwner = new Int32Array(blocks.blockCount).fill(NO_TRAIN);
    this.blockHolds = new Int32Array(blocks.blockCount);
    this.arrivals = new Uint32Array(trainCapacity);
    this.targetBlock = new Int32Array(trainCapacity).fill(NO_BLOCK);
    this.ringCapacity = 2 * graph.edgeCount + 8;
    this.ringEdge = new Int32Array(trainCapacity * this.ringCapacity);
    this.ringStartS = new Float64Array(trainCapacity * this.ringCapacity);
    this.ringHead = new Float64Array(trainCapacity);
    this.ringNext = new Float64Array(trainCapacity);
    this.frontSeq = new Float64Array(trainCapacity);
    this.lengthLdu = new Float64Array(trainCapacity);
    this.placed = new Uint8Array(trainCapacity);
    this.mode = new Uint8Array(trainCapacity);
    this.planner = new RoutePlanner(blocks);
    this.route = new Int32Array(graph.edgeCount);
    this.reverseRoute = new Int32Array(graph.edgeCount);
    this.penalty = new Float64Array(blocks.blockCount);
    let total = 0;
    for (let edge = 0; edge < graph.edgeCount; edge++) total += blocks.edgeLengthLdu[edge] ?? 0;
    this.occupiedPenaltyLdu = total;
  }

  place(
    train: number,
    frontEdge: number,
    frontOffsetLdu: number,
    lengthLdu: number,
    switchStates: Uint8Array,
  ): void {
    if (this.placed[train] === 1) throw new Error(`train ${train} is already placed`);
    const { graph, edgeLengthLdu } = this.blocks;
    const body = this.route;
    let count = 0;
    let edge = frontEdge;
    let covered = frontOffsetLdu;
    body[count++] = edge;
    while (covered < lengthLdu) {
      const behind = nextEdge(graph, reverseEdge(edge), switchStates);
      if (behind === NO_EDGE) throw new Error(`train ${train} would hang off an open end`);
      edge = reverseEdge(behind);
      body[count++] = edge;
      covered += edgeLengthLdu[edge] ?? 0;
    }
    for (let i = 0; i < count; i++) {
      const owner = this.blockOwner[this.blocks.edgeBlock(body[i] ?? 0)] ?? NO_TRAIN;
      if (owner !== NO_TRAIN && owner !== train) {
        throw new Error(`train ${train} overlaps track held by train ${owner}`);
      }
    }
    this.lengthLdu[train] = lengthLdu;
    this.ringHead[train] = 0;
    this.ringNext[train] = 0;
    this.placed[train] = 1;
    this.mode[train] = MODE_MANUAL;
    let startS = lengthLdu - frontOffsetLdu;
    for (let i = 1; i < count; i++) startS -= edgeLengthLdu[body[i] ?? 0] ?? 0;
    for (let i = count - 1; i >= 0; i--) {
      const held = body[i] ?? 0;
      this.append(train, held, startS);
      startS += edgeLengthLdu[held] ?? 0;
    }
    this.frontSeq[train] = (this.ringNext[train] ?? 1) - 1;
  }

  reseat(train: number, frontEdge: number, frontOffsetLdu: number, switchStates: Uint8Array): void {
    const mode = this.mode[train] ?? MODE_MANUAL;
    const target = this.targetBlock[train] ?? NO_BLOCK;
    while ((this.ringNext[train] ?? 0) > (this.ringHead[train] ?? 0)) this.dropOldest(train);
    this.placed[train] = 0;
    this.place(train, frontEdge, frontOffsetLdu, this.lengthLdu[train] ?? 0, switchStates);
    this.targetBlock[train] = target;
    this.mode[train] = mode === MODE_REVERSING || mode === MODE_ROUTED ? MODE_WAITING : mode;
  }

  goTo(train: number, block: number): void {
    if (this.placed[train] !== 1) throw new Error(`train ${train} is not placed`);
    if (block < 0 || block >= this.blocks.blockCount || this.blocks.blockIsJunction[block] === 1) {
      throw new RangeError(`block ${block} is not a stopping block`);
    }
    this.targetBlock[train] = block;
    this.mode[train] = MODE_WAITING;
  }

  drive(train: number): void {
    this.targetBlock[train] = NO_BLOCK;
    this.mode[train] = MODE_MANUAL;
  }

  routeState(train: number): TrainRouteState {
    return MODE_NAMES[this.mode[train] ?? MODE_MANUAL] ?? "manual";
  }

  heldSuccessor(train: number, edge: number, switchStates: Uint8Array): number {
    let seq = this.frontSeq[train] ?? 0;
    const next = this.ringNext[train] ?? 0;
    while (seq < next && this.ringEdge[this.slot(train, seq)] !== edge) seq++;
    if (seq + 1 >= next) return NO_EDGE;
    const following = this.ringEdge[this.slot(train, seq + 1)] ?? NO_EDGE;
    const switchId = this.blocks.edgeSwitchSetting(following);
    if (switchId !== NO_SWITCH) {
      switchStates[switchId] = this.blocks.graph.edgeRoute[following] ?? 0;
    }
    return following;
  }

  canThrow(switchId: number): boolean {
    const end = this.blocks.graph.switchEnd[switchId] ?? 0;
    const placement = this.blocks.graph.endPlacement[end] ?? 0;
    return this.blockOwner[this.blocks.placementBlock[placement] ?? 0] === NO_TRAIN;
  }

  clearDistanceAhead(
    train: number,
    frontEdge: number,
    frontOffsetLdu: number,
    speedLduPerS: number,
    brakingLduPerS2: number,
    switchStates: Uint8Array,
  ): number {
    const sFront = this.locateFront(train, frontEdge, frontOffsetLdu);
    this.releaseBehind(train, sFront - (this.lengthLdu[train] ?? 0));
    const mode = this.mode[train] ?? MODE_MANUAL;
    if (mode === MODE_MANUAL) {
      const stopping = (speedLduPerS * speedLduPerS) / (2 * brakingLduPerS2);
      this.extendAhead(train, sFront + stopping + 2 * BLOCK_CLEARANCE_LDU, switchStates);
    } else if (mode === MODE_WAITING && speedLduPerS === 0) {
      this.acquireRoute(train, frontEdge, frontOffsetLdu, sFront);
    }
    const now = this.mode[train];
    if ((now === MODE_WAITING || now === MODE_REVERSING) && speedLduPerS === 0) return 0;
    const clear = this.heldEndS(train) - BLOCK_CLEARANCE_LDU - sFront;
    if (this.mode[train] === MODE_ROUTED && speedLduPerS === 0 && clear <= ARRIVAL_WINDOW_LDU) {
      this.mode[train] = MODE_ARRIVED;
      this.arrivals[train] = (this.arrivals[train] ?? 0) + 1;
    }
    return clear > 0 ? clear : 0;
  }

  private slot(train: number, seq: number): number {
    return train * this.ringCapacity + (seq % this.ringCapacity);
  }

  private heldEndS(train: number): number {
    const last = this.slot(train, (this.ringNext[train] ?? 1) - 1);
    return (
      (this.ringStartS[last] ?? 0) + (this.blocks.edgeLengthLdu[this.ringEdge[last] ?? 0] ?? 0)
    );
  }

  private locateFront(train: number, frontEdge: number, frontOffsetLdu: number): number {
    let seq = this.frontSeq[train] ?? 0;
    const next = this.ringNext[train] ?? 0;
    while (seq < next && this.ringEdge[this.slot(train, seq)] !== frontEdge) seq++;
    if (seq === next) {
      throw new Error(`train ${train} reached edge ${frontEdge}, which it does not hold`);
    }
    this.frontSeq[train] = seq;
    return (this.ringStartS[this.slot(train, seq)] ?? 0) + frontOffsetLdu;
  }

  private append(train: number, edge: number, startS: number): void {
    const next = this.ringNext[train] ?? 0;
    if (next - (this.ringHead[train] ?? 0) >= this.ringCapacity) {
      throw new RangeError(`train ${train} holds more than ${this.ringCapacity} edges`);
    }
    const at = this.slot(train, next);
    this.ringEdge[at] = edge;
    this.ringStartS[at] = startS;
    this.ringNext[train] = next + 1;
    const block = this.blocks.edgeBlock(edge);
    this.blockOwner[block] = train;
    this.blockHolds[block] = (this.blockHolds[block] ?? 0) + 1;
  }

  private dropOldest(train: number): void {
    const head = this.ringHead[train] ?? 0;
    const block = this.blocks.edgeBlock(this.ringEdge[this.slot(train, head)] ?? 0);
    this.ringHead[train] = head + 1;
    const holds = (this.blockHolds[block] ?? 0) - 1;
    this.blockHolds[block] = holds;
    if (holds === 0) this.blockOwner[block] = NO_TRAIN;
  }

  private dropNewest(train: number): void {
    const last = (this.ringNext[train] ?? 1) - 1;
    const block = this.blocks.edgeBlock(this.ringEdge[this.slot(train, last)] ?? 0);
    this.ringNext[train] = last;
    const holds = (this.blockHolds[block] ?? 0) - 1;
    this.blockHolds[block] = holds;
    if (holds === 0) this.blockOwner[block] = NO_TRAIN;
  }

  private releaseBehind(train: number, sTail: number): void {
    const { edgeLengthLdu } = this.blocks;
    while ((this.ringHead[train] ?? 0) < (this.frontSeq[train] ?? 0)) {
      const head = this.slot(train, this.ringHead[train] ?? 0);
      const endS = (this.ringStartS[head] ?? 0) + (edgeLengthLdu[this.ringEdge[head] ?? 0] ?? 0);
      if (endS + BLOCK_CLEARANCE_LDU > sTail) break;
      this.dropOldest(train);
    }
  }

  private extendAhead(train: number, untilS: number, switchStates: Uint8Array): void {
    const { graph, edgeLengthLdu } = this.blocks;
    let endS = this.heldEndS(train);
    while (endS < untilS) {
      const last = this.ringEdge[this.slot(train, (this.ringNext[train] ?? 1) - 1)] ?? 0;
      const next = nextEdge(graph, last, switchStates);
      if (next === NO_EDGE) return;
      const owner = this.blockOwner[this.blocks.edgeBlock(next)] ?? NO_TRAIN;
      if (owner !== NO_TRAIN && owner !== train) return;
      this.append(train, next, endS);
      endS += edgeLengthLdu[next] ?? 0;
    }
  }

  private routeIsFree(train: number, route: Int32Array, count: number): boolean {
    if (count === 0) return false;
    for (let i = 1; i < count; i++) {
      const owner = this.blockOwner[this.blocks.edgeBlock(route[i] ?? 0)] ?? NO_TRAIN;
      if (owner !== NO_TRAIN && owner !== train) return false;
    }
    return true;
  }

  private planBehind(train: number, sFront: number, target: number): number {
    const sTail = sFront - (this.lengthLdu[train] ?? 0);
    let seq = this.ringHead[train] ?? 0;
    const front = this.frontSeq[train] ?? 0;
    while (seq < front) {
      const at = this.slot(train, seq);
      const end =
        (this.ringStartS[at] ?? 0) + (this.blocks.edgeLengthLdu[this.ringEdge[at] ?? 0] ?? 0);
      if (end > sTail) break;
      seq++;
    }
    const at = this.slot(train, seq);
    const tailEdge = this.ringEdge[at] ?? 0;
    const length = this.blocks.edgeLengthLdu[tailEdge] ?? 0;
    const intoTail = sTail - (this.ringStartS[at] ?? 0);
    const offset = Math.min(Math.max(length - intoTail, 0), length);
    return this.planner.plan(
      reverseEdge(tailEdge),
      offset,
      target,
      this.penalty,
      this.reverseRoute,
    );
  }

  private acquireRoute(
    train: number,
    frontEdge: number,
    frontOffsetLdu: number,
    sFront: number,
  ): void {
    for (let b = 0; b < this.penalty.length; b++) {
      const owner = this.blockOwner[b] ?? NO_TRAIN;
      this.penalty[b] = owner !== NO_TRAIN && owner !== train ? this.occupiedPenaltyLdu : 0;
    }
    const target = this.targetBlock[train] ?? NO_BLOCK;
    const count = this.planner.plan(frontEdge, frontOffsetLdu, target, this.penalty, this.route);
    const ahead = this.routeIsFree(train, this.route, count);
    const aheadLength = this.planner.lastLengthLdu;
    const behindCount = this.planBehind(train, sFront, target);
    const behind = this.routeIsFree(train, this.reverseRoute, behindCount);
    if (behind && (!ahead || this.planner.lastLengthLdu < aheadLength)) {
      this.mode[train] = MODE_REVERSING;
      return;
    }
    if (!ahead) return;
    while ((this.ringNext[train] ?? 0) - 1 > (this.frontSeq[train] ?? 0)) this.dropNewest(train);
    const frontSlot = this.slot(train, this.frontSeq[train] ?? 0);
    let endS =
      sFront - frontOffsetLdu + (this.blocks.edgeLengthLdu[this.ringEdge[frontSlot] ?? 0] ?? 0);
    for (let i = 1; i < count; i++) {
      const edge = this.route[i] ?? 0;
      this.append(train, edge, endS);
      endS += this.blocks.edgeLengthLdu[edge] ?? 0;
    }
    this.mode[train] = MODE_ROUTED;
  }
}

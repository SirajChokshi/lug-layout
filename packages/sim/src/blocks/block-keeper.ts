import { NO_EDGE, NO_SWITCH } from "@brr/domain";
import { STUD_LDU } from "@brr/math";
import type { RoutePlanner } from "../routing/route-planner.ts";
import { NO_BLOCK, nextEdge, reverseEdge, type BlockMap } from "./block-map.ts";

export const NO_TRAIN = -1;
export const BLOCK_CLEARANCE_LDU = STUD_LDU;
export const ARRIVAL_WINDOW_LDU = STUD_LDU;

export type TrainRouteState = "manual" | "waiting" | "routed" | "arrived" | "reversing";

export interface KeeperTrainBodies {
  readonly trainEdge: Int32Array;
  readonly trainOffset: Float64Array;
  readonly trainBodyLength: Float64Array;
  solveBody(train: number): void;
}

export interface KeeperTrains extends KeeperTrainBodies {
  readonly trainSpeed: Float64Array;
  readonly trainBraking: Float64Array;
}

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
  readonly placementOwner: Int32Array;
  readonly blockHeldPieces: Int32Array;
  readonly arrivals: Uint32Array;
  readonly targetBlock: Int32Array;
  readonly clearAheadLdu: Float64Array;
  private readonly placementHolds: Int32Array;
  private readonly ringCapacity: number;
  private readonly ringEdge: Int32Array;
  private readonly ringStartS: Float64Array;
  private readonly ringHead: Int32Array;
  private readonly ringNext: Int32Array;
  private readonly frontSeq: Int32Array;
  private readonly heldEndS: Float64Array;
  private readonly placed: Uint8Array;
  private readonly mode: Uint8Array;
  private readonly route: Int32Array;
  private readonly reverseRoute: Int32Array;
  private readonly reverseFromOffset = new Float64Array(1);
  private readonly penalty: Float64Array;
  private readonly occupiedPenaltyLdu: number;

  constructor(
    readonly blocks: BlockMap,
    private readonly planner: RoutePlanner,
    readonly trainCapacity: number,
  ) {
    const { graph } = blocks;
    this.placementOwner = new Int32Array(graph.placementCount).fill(NO_TRAIN);
    this.placementHolds = new Int32Array(graph.placementCount);
    this.blockHeldPieces = new Int32Array(blocks.blockCount);
    this.arrivals = new Uint32Array(trainCapacity);
    this.targetBlock = new Int32Array(trainCapacity).fill(NO_BLOCK);
    this.clearAheadLdu = new Float64Array(trainCapacity);
    this.ringCapacity = 2 * graph.edgeCount + 8;
    this.ringEdge = new Int32Array(trainCapacity * this.ringCapacity);
    this.ringStartS = new Float64Array(trainCapacity * this.ringCapacity);
    this.ringHead = new Int32Array(trainCapacity);
    this.ringNext = new Int32Array(trainCapacity);
    this.frontSeq = new Int32Array(trainCapacity);
    this.heldEndS = new Float64Array(trainCapacity);
    this.placed = new Uint8Array(trainCapacity);
    this.mode = new Uint8Array(trainCapacity);
    this.route = new Int32Array(graph.edgeCount);
    this.reverseRoute = new Int32Array(graph.edgeCount);
    this.penalty = new Float64Array(graph.placementCount);
    let total = 0;
    for (let edge = 0; edge < graph.edgeCount; edge++) total += blocks.edgeLengthLdu[edge] ?? 0;
    this.occupiedPenaltyLdu = total;
  }

  place(train: number, trains: KeeperTrainBodies, switchStates: Uint8Array): void {
    if (this.placed[train] === 1) throw new Error(`train ${train} is already placed`);
    trains.solveBody(train);
    const frontEdge = trains.trainEdge[train] ?? 0;
    const frontOffsetLdu = trains.trainOffset[train] ?? 0;
    const lengthLdu = trains.trainBodyLength[train] ?? 0;
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
      const owner = this.edgeOwner(body[i] ?? 0);
      if (owner !== NO_TRAIN && owner !== train) {
        throw new Error(`train ${train} overlaps track held by train ${owner}`);
      }
    }
    this.ringHead[train] = 0;
    this.ringNext[train] = 0;
    this.placed[train] = 1;
    this.mode[train] = MODE_MANUAL;
    let startS = lengthLdu - frontOffsetLdu;
    for (let i = 1; i < count; i++) startS -= edgeLengthLdu[body[i] ?? 0] ?? 0;
    this.heldEndS[train] = startS;
    for (let i = count - 1; i >= 0; i--) this.append(train, body[i] ?? 0);
    this.frontSeq[train] = (this.ringNext[train] ?? 1) - 1;
  }

  reseat(train: number, trains: KeeperTrainBodies, switchStates: Uint8Array): void {
    const mode = this.mode[train] ?? MODE_MANUAL;
    const target = this.targetBlock[train] ?? NO_BLOCK;
    while ((this.ringNext[train] ?? 0) > (this.ringHead[train] ?? 0)) this.dropOldest(train);
    this.placed[train] = 0;
    this.place(train, trains, switchStates);
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
    return this.placementOwner[placement] === NO_TRAIN;
  }

  heldEndIsOpen(train: number, switchStates: Uint8Array): boolean {
    const last = this.ringEdge[this.slot(train, (this.ringNext[train] ?? 1) - 1)] ?? 0;
    return nextEdge(this.blocks.graph, last, switchStates) === NO_EDGE;
  }

  blockIsFree(block: number): boolean {
    return this.blockHeldPieces[block] === 0;
  }

  updateClearAhead(train: number, trains: KeeperTrains, switchStates: Uint8Array): void {
    trains.solveBody(train);
    const frontEdge = trains.trainEdge[train] ?? 0;
    const speedLduPerS = trains.trainSpeed[train] ?? 0;
    this.locateFront(train, frontEdge);
    this.releaseBehind(train, trains);
    const mode = this.mode[train] ?? MODE_MANUAL;
    if (mode === MODE_MANUAL) {
      this.extendAhead(train, trains, switchStates);
    } else if (mode === MODE_WAITING && speedLduPerS === 0) {
      this.acquireRoute(train, frontEdge, trains);
    }
    const now = this.mode[train];
    if ((now === MODE_WAITING || now === MODE_REVERSING) && speedLduPerS === 0) {
      this.clearAheadLdu[train] = 0;
      return;
    }
    const sFront = (this.ringStartS[this.frontSlot(train)] ?? 0) + (trains.trainOffset[train] ?? 0);
    const clear = (this.heldEndS[train] ?? 0) - BLOCK_CLEARANCE_LDU - sFront;
    if (this.mode[train] === MODE_ROUTED && speedLduPerS === 0 && clear <= ARRIVAL_WINDOW_LDU) {
      this.mode[train] = MODE_ARRIVED;
      this.arrivals[train] = (this.arrivals[train] ?? 0) + 1;
    }
    this.clearAheadLdu[train] = clear > 0 ? clear : 0;
  }

  private edgeOwner(edge: number): number {
    return this.placementOwner[this.blocks.graph.edgePlacement[edge] ?? 0] ?? NO_TRAIN;
  }

  private hold(train: number, edge: number): void {
    const placement = this.blocks.graph.edgePlacement[edge] ?? 0;
    const holds = (this.placementHolds[placement] ?? 0) + 1;
    this.placementHolds[placement] = holds;
    this.placementOwner[placement] = train;
    if (holds === 1) {
      const block = this.blocks.placementBlock[placement] ?? 0;
      this.blockHeldPieces[block] = (this.blockHeldPieces[block] ?? 0) + 1;
    }
  }

  private unhold(edge: number): void {
    const placement = this.blocks.graph.edgePlacement[edge] ?? 0;
    const holds = (this.placementHolds[placement] ?? 0) - 1;
    this.placementHolds[placement] = holds;
    if (holds === 0) {
      this.placementOwner[placement] = NO_TRAIN;
      const block = this.blocks.placementBlock[placement] ?? 0;
      this.blockHeldPieces[block] = (this.blockHeldPieces[block] ?? 0) - 1;
    }
  }

  private slot(train: number, seq: number): number {
    return train * this.ringCapacity + (seq % this.ringCapacity);
  }

  private frontSlot(train: number): number {
    return this.slot(train, this.frontSeq[train] ?? 0);
  }

  private locateFront(train: number, frontEdge: number): void {
    let seq = this.frontSeq[train] ?? 0;
    const next = this.ringNext[train] ?? 0;
    while (seq < next && this.ringEdge[this.slot(train, seq)] !== frontEdge) seq++;
    if (seq === next) {
      throw new Error(`train ${train} reached edge ${frontEdge}, which it does not hold`);
    }
    this.frontSeq[train] = seq;
  }

  private append(train: number, edge: number): void {
    const next = this.ringNext[train] ?? 0;
    if (next - (this.ringHead[train] ?? 0) >= this.ringCapacity) {
      throw new RangeError(`train ${train} holds more than ${this.ringCapacity} edges`);
    }
    const at = this.slot(train, next);
    const startS = this.heldEndS[train] ?? 0;
    this.ringEdge[at] = edge;
    this.ringStartS[at] = startS;
    this.heldEndS[train] = startS + (this.blocks.edgeLengthLdu[edge] ?? 0);
    this.ringNext[train] = next + 1;
    this.hold(train, edge);
  }

  private dropOldest(train: number): void {
    const head = this.ringHead[train] ?? 0;
    this.ringHead[train] = head + 1;
    this.unhold(this.ringEdge[this.slot(train, head)] ?? 0);
  }

  private dropNewest(train: number): void {
    const last = (this.ringNext[train] ?? 1) - 1;
    const at = this.slot(train, last);
    this.ringNext[train] = last;
    this.heldEndS[train] = this.ringStartS[at] ?? 0;
    this.unhold(this.ringEdge[at] ?? 0);
  }

  private releaseBehind(train: number, trains: KeeperTrainBodies): void {
    const { edgeLengthLdu } = this.blocks;
    const sTail =
      (this.ringStartS[this.frontSlot(train)] ?? 0) +
      (trains.trainOffset[train] ?? 0) -
      (trains.trainBodyLength[train] ?? 0);
    while ((this.ringHead[train] ?? 0) < (this.frontSeq[train] ?? 0)) {
      const head = this.slot(train, this.ringHead[train] ?? 0);
      const endS = (this.ringStartS[head] ?? 0) + (edgeLengthLdu[this.ringEdge[head] ?? 0] ?? 0);
      if (endS + BLOCK_CLEARANCE_LDU > sTail) break;
      this.dropOldest(train);
    }
  }

  private extendAhead(train: number, trains: KeeperTrains, switchStates: Uint8Array): void {
    const { graph } = this.blocks;
    const speedLduPerS = trains.trainSpeed[train] ?? 0;
    const stopping = (speedLduPerS * speedLduPerS) / (2 * (trains.trainBraking[train] ?? 0));
    const untilS =
      (this.ringStartS[this.frontSlot(train)] ?? 0) +
      (trains.trainOffset[train] ?? 0) +
      stopping +
      2 * BLOCK_CLEARANCE_LDU;
    while ((this.heldEndS[train] ?? 0) < untilS) {
      const last = this.ringEdge[this.slot(train, (this.ringNext[train] ?? 1) - 1)] ?? 0;
      const next = nextEdge(graph, last, switchStates);
      if (next === NO_EDGE) return;
      const owner = this.edgeOwner(next);
      if (owner !== NO_TRAIN && owner !== train) return;
      this.append(train, next);
    }
  }

  private routeIsFree(train: number, route: Int32Array, count: number): boolean {
    if (count === 0) return false;
    for (let i = 1; i < count; i++) {
      const owner = this.edgeOwner(route[i] ?? 0);
      if (owner !== NO_TRAIN && owner !== train) return false;
    }
    return true;
  }

  private planBehind(train: number, target: number, trains: KeeperTrainBodies): number {
    const sTail =
      (this.ringStartS[this.frontSlot(train)] ?? 0) +
      (trains.trainOffset[train] ?? 0) -
      (trains.trainBodyLength[train] ?? 0);
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
    this.reverseFromOffset[0] = Math.min(Math.max(length - intoTail, 0), length);
    return this.planner.plan(
      reverseEdge(tailEdge),
      this.reverseFromOffset,
      0,
      target,
      this.penalty,
      this.reverseRoute,
    );
  }

  private acquireRoute(train: number, frontEdge: number, trains: KeeperTrains): void {
    for (let p = 0; p < this.penalty.length; p++) {
      const owner = this.placementOwner[p] ?? NO_TRAIN;
      this.penalty[p] = owner !== NO_TRAIN && owner !== train ? this.occupiedPenaltyLdu : 0;
    }
    const target = this.targetBlock[train] ?? NO_BLOCK;
    const count = this.planner.plan(
      frontEdge,
      trains.trainOffset,
      train,
      target,
      this.penalty,
      this.route,
    );
    const ahead = this.routeIsFree(train, this.route, count);
    const aheadLength = this.planner.lastLengthLdu;
    const behindCount = this.planBehind(train, target, trains);
    const behind = this.routeIsFree(train, this.reverseRoute, behindCount);
    if (behind && (!ahead || this.planner.lastLengthLdu < aheadLength)) {
      this.mode[train] = MODE_REVERSING;
      return;
    }
    if (!ahead) return;
    while ((this.ringNext[train] ?? 0) - 1 > (this.frontSeq[train] ?? 0)) this.dropNewest(train);
    const frontSlot = this.frontSlot(train);
    this.heldEndS[train] =
      (this.ringStartS[frontSlot] ?? 0) +
      (this.blocks.edgeLengthLdu[this.ringEdge[frontSlot] ?? 0] ?? 0);
    for (let i = 1; i < count; i++) this.append(train, this.route[i] ?? 0);
    this.mode[train] = MODE_ROUTED;
  }
}

import {
  HALF_TURN_16,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  addZeta16,
  normalizeHeading16,
  pose16,
  subtractZeta16,
  zeta16,
  type Pose16,
} from "@brr/math";
import type { DrawingKit } from "./drawing-kit.ts";
import {
  addRotated,
  coefficientNumbers,
  coefficientsLdu,
  type KitOutlines,
  type MoveFrame,
} from "./kit-outlines.ts";
import {
  NO_OBSTACLE,
  RUN_CROSSING,
  poseLdu,
  studlessTopBlocker,
  type TrackClearance,
} from "./track-clearance.ts";
import type { TrackMove } from "./track-pose.ts";
import {
  DEFAULT_CLOSURE_TURNS,
  closuresWithinTurns,
  runMoves,
  runOfMoves,
  type TrackRun,
} from "./track-solver.ts";

export interface SupportSite {
  readonly studlessTops: TrackClearance;
  supported(frame: MoveFrame, pose: Pose16): boolean;
}

export interface ClosureSite {
  readonly clearance: TrackClearance;
  readonly support: SupportSite;
  readonly outlines: KitOutlines;
  readonly startOwner: number;
  readonly goalOwner: number;
}

export type ClearClosureResult =
  | { readonly kind: "exact"; readonly run: TrackRun }
  | { readonly kind: "blocked"; readonly blocker: number }
  | { readonly kind: "limit" };

export interface AlgebraicClosure {
  readonly run: TrackRun | null;
  readonly fewestPieces: number;
  readonly withinTurns: ReadonlyArray<TrackRun>;
}

const TABLE_DEPTH = 7;
const SEARCH_NODES = 4096;
const DETOUR_PIECES = 3 * ZETA16_ORDER;
const BOUND_SLACK = 1e-9;
const PIECE_COST = 1e6;
const SEGMENT_COST = 1e-3;
const NO_MOVE = -1;
const KEY_HALF = 0x10000;
const ORIGIN = new Float64Array(ZETA16_COEFFICIENT_COUNT);

interface SearchNode {
  readonly coefficients: Float64Array;
  readonly heading: number;
  readonly x: number;
  readonly z: number;
  readonly pieces: number;
  readonly cost: number;
  readonly parent: SearchNode | null;
  readonly move: number;
  readonly priority: number;
}

function keyOf(coefficients: Float64Array, heading: number): string {
  let key = String.fromCharCode(heading);
  for (let k = 0; k < ZETA16_COEFFICIENT_COUNT; k++) {
    const c = (coefficients[k] ?? 0) | 0;
    key += String.fromCharCode(c & (KEY_HALF - 1), (c >>> 16) & (KEY_HALF - 1));
  }
  return key;
}

function headingSteps(a: number, b: number): number {
  const d = normalizeHeading16(a - b);
  return Math.min(d, ZETA16_ORDER - d);
}

class NodeHeap {
  private readonly items: SearchNode[] = [];

  get size(): number {
    return this.items.length;
  }

  push(node: SearchNode): void {
    const items = this.items;
    let i = items.length;
    items.push(node);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const above = items[parent];
      if (!above || above.priority <= node.priority) break;
      items[i] = above;
      i = parent;
    }
    items[i] = node;
  }

  pop(): SearchNode | undefined {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (!top || !last || items.length === 0) return top;
    let i = 0;
    for (;;) {
      const left = 2 * i + 1;
      if (left >= items.length) break;
      let child = left;
      const leftNode = items[left];
      const rightNode = items[left + 1];
      if (rightNode && leftNode && rightNode.priority < leftNode.priority) child = left + 1;
      const childNode = items[child];
      if (!childNode || childNode.priority >= last.priority) break;
      items[i] = childNode;
      i = child;
    }
    items[i] = last;
    return top;
  }
}

class ClosureGeometry {
  readonly frames: ReadonlyArray<MoveFrame>;
  readonly final: Float64Array;
  readonly finalHeading: number;
  private readonly originX: number;
  private readonly originZ: number;

  constructor(
    readonly kit: DrawingKit,
    readonly start: Pose16,
    goal: Pose16,
    readonly site: ClosureSite,
  ) {
    this.frames = site.outlines.frames;
    this.final = coefficientNumbers(subtractZeta16(goal.position, start.position));
    this.finalHeading = normalizeHeading16(goal.heading + HALF_TURN_16);
    const origin = poseLdu(start);
    this.originX = origin.x;
    this.originZ = origin.z;
  }

  worldOf(coefficients: Float64Array): readonly [number, number] {
    const [x, z] = coefficientsLdu(coefficients);
    return [this.originX + x, this.originZ + z];
  }

  isFinal(coefficients: Float64Array, heading: number): boolean {
    if (heading !== this.finalHeading) return false;
    for (let k = 0; k < ZETA16_COEFFICIENT_COUNT; k++) {
      if (coefficients[k] !== this.final[k]) return false;
    }
    return true;
  }

  laidBlocker(
    frame: MoveFrame,
    heading: number,
    at: Float64Array,
    x: number,
    z: number,
    first: boolean,
    last: boolean,
  ): number {
    const { clearance, support, outlines } = this.site;
    const startOwner = first ? this.site.startOwner : NO_OBSTACLE;
    const goalOwner = last ? this.site.goalOwner : NO_OBSTACLE;
    const solid = outlines.blocker(clearance, frame, heading, x, z, startOwner, goalOwner);
    if (solid !== NO_OBSTACLE) return solid;
    const top = outlines.blockerBesideJoins(
      support.studlessTops,
      clearance,
      frame,
      heading,
      x,
      z,
      startOwner,
      goalOwner,
    );
    if (top === NO_OBSTACLE || support.supported(frame, this.poseAt(at, heading)))
      return NO_OBSTACLE;
    return studlessTopBlocker(top);
  }

  private poseAt(at: Float64Array, heading: number): Pose16 {
    const offset = zeta16(Array.from(at, (coefficient) => BigInt(coefficient)));
    return pose16(addZeta16(this.start.position, offset), heading);
  }

  piecesMeet(
    a: MoveFrame,
    aHeading: number,
    ax: number,
    az: number,
    b: MoveFrame,
    bHeading: number,
    bx: number,
    bz: number,
  ): boolean {
    return this.site.outlines.meet(a, aHeading, ax, az, b, bHeading, bx, bz);
  }

  endsBlocker(): number {
    let firstFree = false;
    let lastFree = false;
    let firstBlocker = NO_OBSTACLE;
    let lastBlocker = NO_OBSTACLE;
    const [x, z] = this.worldOf(ORIGIN);
    const before = new Float64Array(ZETA16_COEFFICIENT_COUNT);
    const after = new Float64Array(ZETA16_COEFFICIENT_COUNT);
    for (const frame of this.frames) {
      after.fill(0);
      addRotated(frame.delta, this.start.heading, after, 1);
      const last = this.isFinal(after, normalizeHeading16(this.start.heading + frame.turn));
      const atStart = this.laidBlocker(frame, this.start.heading, ORIGIN, x, z, true, last);
      if (atStart === NO_OBSTACLE) firstFree = true;
      else if (firstBlocker === NO_OBSTACLE) firstBlocker = atStart;
      const heading = normalizeHeading16(this.finalHeading - frame.turn);
      before.set(this.final);
      addRotated(frame.delta, heading, before, -1);
      const first = heading === this.start.heading && before.every((c) => c === 0);
      const [bx, bz] = this.worldOf(before);
      const atGoal = this.laidBlocker(frame, heading, before, bx, bz, first, true);
      if (atGoal === NO_OBSTACLE) lastFree = true;
      else if (lastBlocker === NO_OBSTACLE) lastBlocker = atGoal;
    }
    if (!firstFree) return firstBlocker;
    return lastFree ? NO_OBSTACLE : lastBlocker;
  }

  firstBlocker(moves: ReadonlyArray<TrackMove>): number {
    const coefficients = new Float64Array(ZETA16_COEFFICIENT_COUNT);
    const xs = new Float64Array(moves.length);
    const zs = new Float64Array(moves.length);
    const headings = new Int32Array(moves.length);
    const frames: MoveFrame[] = [];
    let heading = this.start.heading;
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      if (!move) continue;
      const frame = this.site.outlines.frameFor(move);
      const [x, z] = this.worldOf(coefficients);
      const last = i === moves.length - 1;
      const blocker = this.laidBlocker(frame, heading, coefficients, x, z, i === 0, last);
      if (blocker !== NO_OBSTACLE) return blocker;
      for (let j = 0; j < i - 1; j++) {
        const earlier = frames[j];
        if (!earlier) continue;
        if (
          this.piecesMeet(frame, heading, x, z, earlier, headings[j] ?? 0, xs[j] ?? 0, zs[j] ?? 0)
        ) {
          return RUN_CROSSING;
        }
      }
      frames.push(frame);
      xs[i] = x;
      zs[i] = z;
      headings[i] = heading;
      addRotated(frame.delta, heading, coefficients, 1);
      heading = normalizeHeading16(heading + frame.turn);
    }
    return NO_OBSTACLE;
  }

  costOf(moves: ReadonlyArray<TrackMove>): number {
    let cost = 0;
    let previous: TrackMove | null = null;
    for (const move of moves) {
      cost += PIECE_COST + this.site.outlines.frameFor(move).lengthLdu;
      if (move !== previous) cost += SEGMENT_COST;
      previous = move;
    }
    return cost;
  }
}

class ClearClosureSearch {
  private readonly table = new Map<string, number>();
  private readonly finalX: number;
  private readonly finalZ: number;
  private readonly scratch = new Float64Array(ZETA16_COEFFICIENT_COUNT);
  sawBlockedJoin = false;

  constructor(
    private readonly geometry: ClosureGeometry,
    private readonly lowerBound: number,
  ) {
    [this.finalX, this.finalZ] = geometry.worldOf(geometry.final);
    this.buildTable();
  }

  private buildTable(): void {
    const { final, finalHeading, frames } = this.geometry;
    let frontier: Array<readonly [Float64Array, number]> = [[final, finalHeading]];
    this.table.set(keyOf(final, finalHeading), 0);
    for (let depth = 1; depth <= TABLE_DEPTH; depth++) {
      const next: Array<readonly [Float64Array, number]> = [];
      for (const [coefficients, heading] of frontier) {
        for (const frame of frames) {
          const before = normalizeHeading16(heading - frame.turn);
          const previous = Float64Array.from(coefficients);
          addRotated(frame.delta, before, previous, -1);
          const key = keyOf(previous, before);
          if (this.table.has(key)) continue;
          this.table.set(key, depth);
          next.push([previous, before]);
        }
      }
      frontier = next;
    }
  }

  private remaining(key: string, heading: number, x: number, z: number, pieces: number): number {
    const bound =
      this.table.get(key) ??
      Math.max(
        TABLE_DEPTH + 1,
        headingSteps(heading, this.geometry.finalHeading),
        Math.ceil(
          Math.hypot(this.finalX - x, this.finalZ - z) / this.geometry.site.outlines.maxStepLdu -
            BOUND_SLACK,
        ),
      );
    return Math.max(bound, this.lowerBound - pieces);
  }

  private node(
    coefficients: Float64Array,
    key: string,
    heading: number,
    pieces: number,
    cost: number,
    parent: SearchNode | null,
    move: number,
  ): SearchNode {
    const [x, z] = this.geometry.worldOf(coefficients);
    const left = this.remaining(key, heading, x, z, pieces);
    return {
      coefficients,
      heading,
      x,
      z,
      pieces,
      cost,
      parent,
      move,
      priority: cost + left * (PIECE_COST + this.geometry.site.outlines.minLengthLdu),
    };
  }

  private pieceBlocked(at: SearchNode, frame: MoveFrame, last: boolean): boolean {
    const geometry = this.geometry;
    if (
      geometry.laidBlocker(
        frame,
        at.heading,
        at.coefficients,
        at.x,
        at.z,
        at.parent === null,
        last,
      ) !== NO_OBSTACLE
    ) {
      return true;
    }
    for (let earlier = at.parent; earlier?.parent; earlier = earlier.parent) {
      const laidFrom = earlier.parent;
      const earlierFrame = geometry.frames[earlier.move];
      if (!earlierFrame) continue;
      if (
        geometry.piecesMeet(
          frame,
          at.heading,
          at.x,
          at.z,
          earlierFrame,
          laidFrom.heading,
          laidFrom.x,
          laidFrom.z,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  run(ceiling: number): TrackRun | null | "limit" {
    const geometry = this.geometry;
    const open = new NodeHeap();
    const best = new Map<string, number>();
    const origin = new Float64Array(ZETA16_COEFFICIENT_COUNT);
    const rootKey = keyOf(origin, geometry.start.heading);
    const root = this.node(origin, rootKey, geometry.start.heading, 0, 0, null, NO_MOVE);
    const pieceCap = Math.floor(root.priority / PIECE_COST) + DETOUR_PIECES;
    open.push(root);
    best.set(rootKey, 0);
    for (let expanded = 0; open.size > 0; expanded++) {
      if (expanded === SEARCH_NODES) return "limit";
      const current = open.pop();
      if (!current || current.priority >= ceiling) return null;
      if (current.parent && geometry.isFinal(current.coefficients, current.heading)) {
        return this.runOf(current);
      }
      if ((best.get(keyOf(current.coefficients, current.heading)) ?? -1) < current.cost) continue;
      const lastFrame = geometry.frames[current.move];
      for (let m = 0; m < geometry.frames.length; m++) {
        const frame = geometry.frames[m];
        if (!frame) continue;
        const pieces = current.pieces + 1;
        if (pieces > pieceCap) continue;
        const coefficients = this.scratch;
        coefficients.set(current.coefficients);
        addRotated(frame.delta, current.heading, coefficients, 1);
        const heading = normalizeHeading16(current.heading + frame.turn);
        const cost =
          current.cost + PIECE_COST + frame.lengthLdu + (frame === lastFrame ? 0 : SEGMENT_COST);
        const key = keyOf(coefficients, heading);
        const seen = best.get(key);
        if (seen !== undefined && seen <= cost) continue;
        const last = geometry.isFinal(coefficients, heading);
        if (this.pieceBlocked(current, frame, last)) {
          if (last) this.sawBlockedJoin = true;
          continue;
        }
        const child = this.node(
          Float64Array.from(coefficients),
          key,
          heading,
          pieces,
          cost,
          current,
          m,
        );
        if (child.priority >= ceiling) continue;
        best.set(key, cost);
        open.push(child);
      }
    }
    return null;
  }

  private runOf(end: SearchNode): TrackRun {
    const moves: TrackMove[] = [];
    for (let node: SearchNode | null = end; node?.parent; node = node.parent) {
      const frame = this.geometry.frames[node.move];
      if (frame) moves.push(frame.move);
    }
    moves.reverse();
    return runOfMoves(this.geometry.kit, moves);
  }
}

interface Candidate {
  readonly run: TrackRun;
  readonly moves: ReadonlyArray<TrackMove>;
  readonly cost: number;
}

function cheapestFirst(
  geometry: ClosureGeometry,
  kit: DrawingKit,
  runs: ReadonlyArray<TrackRun>,
): ReadonlyArray<Candidate> {
  return runs
    .map((run) => {
      const moves = runMoves(kit, run);
      return { run, moves, cost: geometry.costOf(moves) };
    })
    .toSorted((a, b) => a.cost - b.cost);
}

export function shortClearClosure(
  kit: DrawingKit,
  start: Pose16,
  goal: Pose16,
  site: ClosureSite,
  maxPieces: number,
): TrackRun | null {
  const geometry = new ClosureGeometry(kit, start, goal, site);
  const runs = closuresWithinTurns(kit, start, goal, DEFAULT_CLOSURE_TURNS, maxPieces);
  for (const candidate of cheapestFirst(geometry, kit, runs)) {
    if (geometry.firstBlocker(candidate.moves) === NO_OBSTACLE) return candidate.run;
  }
  return null;
}

export function clearClosure(
  kit: DrawingKit,
  start: Pose16,
  goal: Pose16,
  site: ClosureSite,
  algebraic: AlgebraicClosure,
): ClearClosureResult {
  const geometry = new ClosureGeometry(kit, start, goal, site);
  let blocker = NO_OBSTACLE;
  if (algebraic.run) {
    blocker = geometry.firstBlocker(runMoves(kit, algebraic.run));
    if (blocker === NO_OBSTACLE) return { kind: "exact", run: algebraic.run };
  }
  const ends = geometry.endsBlocker();
  if (ends !== NO_OBSTACLE) return { kind: "blocked", blocker: ends };
  let sawBlockedJoin = algebraic.run !== null;
  let incumbent: Candidate | null = null;
  for (const candidate of cheapestFirst(geometry, kit, algebraic.withinTurns)) {
    const hit = geometry.firstBlocker(candidate.moves);
    if (hit === NO_OBSTACLE) {
      incumbent = candidate;
      break;
    }
    if (blocker === NO_OBSTACLE) blocker = hit;
    sawBlockedJoin = true;
  }
  if (incumbent && incumbent.run.pieces <= algebraic.fewestPieces) {
    return { kind: "exact", run: incumbent.run };
  }
  const search = new ClearClosureSearch(geometry, algebraic.fewestPieces);

  const found = search.run(incumbent?.cost ?? Number.POSITIVE_INFINITY);
  if (found !== null && found !== "limit") return { kind: "exact", run: found };
  if (incumbent) return { kind: "exact", run: incumbent.run };
  if (found === "limit" && !sawBlockedJoin && !search.sawBlockedJoin) return { kind: "limit" };
  return { kind: "blocked", blocker };
}

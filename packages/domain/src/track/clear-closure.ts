import {
  HALF_TURN_16,
  STUD_LDU,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  normalizeHeading16,
  rotateZeta16,
  subtractZeta16,
  zeta16ToStuds,
  type Pose16,
  type Zeta16,
} from "@brr/math";
import type { DrawingKit } from "./drawing-kit.ts";
import {
  NO_OBSTACLE,
  OUTLINE_BOX_FLOATS,
  boxesOverlap,
  outlineBox,
  outlinesOverlap,
  poseLdu,
  rotateOutline,
  type TrackClearance,
} from "./track-clearance.ts";
import type { TrackMove, TrackPieceDef } from "./track-pose.ts";
import { runMoves, runOfMoves, type TrackRun } from "./track-solver.ts";

export interface ClosureSite {
  readonly clearance: TrackClearance;
  readonly outlineOf: (piece: TrackPieceDef) => Float64Array;
  readonly startOwner: number;
  readonly goalOwner: number;
}

export type ClearClosureResult =
  | { readonly kind: "exact"; readonly run: TrackRun }
  | { readonly kind: "blocked" }
  | { readonly kind: "limit" };

export interface AlgebraicClosure {
  readonly run: TrackRun | null;
  readonly fewestPieces: number;
  readonly withinTurns: ReadonlyArray<TrackRun>;
}

const TABLE_DEPTH = 7;
const SEARCH_NODES = 4096;
const DETOUR_PIECES = 3 * ZETA16_ORDER;
const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const BOUND_SLACK = 1e-9;
const PIECE_COST = 1e6;
const SEGMENT_COST = 1e-3;
const NO_MOVE = -1;
const KEY_HALF = 0x10000;
const ORIGIN = new Float64Array(ZETA16_COEFFICIENT_COUNT);

interface MoveFrame {
  readonly move: TrackMove;
  readonly delta: Float64Array;
  readonly turn: number;
  readonly lengthLdu: number;
  readonly outlines: ReadonlyArray<Float64Array>;
  readonly boxes: Float64Array;
}

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

const BASIS_X = Float64Array.from({ length: ZETA16_COEFFICIENT_COUNT }, (_v, k) =>
  Math.cos(k * HEADING_RADIANS),
);
const BASIS_Z = Float64Array.from({ length: ZETA16_COEFFICIENT_COUNT }, (_v, k) =>
  Math.sin(k * HEADING_RADIANS),
);

function numbers(value: Zeta16): Float64Array {
  return Float64Array.from(value, (c) => Number(c));
}

function arcLengthLdu(move: TrackMove): number {
  const studs = zeta16ToStuds(move.delta);
  const chord = Math.hypot(studs.x, studs.z) * STUD_LDU;
  const steps = Math.min(move.turn, ZETA16_ORDER - move.turn);
  if (steps === 0) return chord;
  const angle = steps * HEADING_RADIANS;
  return (chord * angle) / (2 * Math.sin(angle / 2));
}

function addRotated(delta: Float64Array, steps: number, out: Float64Array, sign: number): void {
  const turns = normalizeHeading16(steps);
  for (let power = 0; power < ZETA16_COEFFICIENT_COUNT; power++) {
    const source = power - turns;
    let value: number;
    if (source >= 0) value = delta[source] ?? 0;
    else if (source + ZETA16_COEFFICIENT_COUNT >= 0) {
      value = -(delta[source + ZETA16_COEFFICIENT_COUNT] ?? 0);
    } else value = delta[source + ZETA16_ORDER] ?? 0;
    out[power] = (out[power] ?? 0) + sign * value;
  }
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
  private readonly shifted = new Float64Array(OUTLINE_BOX_FLOATS);

  constructor(
    readonly kit: DrawingKit,
    readonly start: Pose16,
    goal: Pose16,
    private readonly site: ClosureSite,
  ) {
    this.frames = [kit.straight, kit.left, kit.right].map((move) => this.frameOf(move));
    this.final = numbers(subtractZeta16(goal.position, start.position));
    this.finalHeading = normalizeHeading16(goal.heading + HALF_TURN_16);
    const origin = poseLdu(start);
    this.originX = origin.x;
    this.originZ = origin.z;
  }

  private frameOf(move: TrackMove): MoveFrame {
    const entry = move.piece.connectors[move.from];
    if (!entry) throw new RangeError(`${move.piece.id} has no connector ${move.from}`);
    const outline = this.site.outlineOf(move.piece);
    const outlines: Float64Array[] = [];
    const boxes = new Float64Array(ZETA16_ORDER * OUTLINE_BOX_FLOATS);
    for (let heading = 0; heading < ZETA16_ORDER; heading++) {
      const placementHeading = heading + HALF_TURN_16 - entry.heading;
      const offset = zeta16ToStuds(rotateZeta16(entry.position, placementHeading));
      const placed = rotateOutline(
        outline,
        placementHeading,
        -offset.x * STUD_LDU,
        -offset.z * STUD_LDU,
      );
      outlines.push(placed);
      outlineBox(placed, boxes, heading * OUTLINE_BOX_FLOATS);
    }
    return {
      move,
      delta: numbers(move.delta),
      turn: move.turn,
      lengthLdu: arcLengthLdu(move),
      outlines,
      boxes,
    };
  }

  worldOf(coefficients: Float64Array): readonly [number, number] {
    let x = 0;
    let z = 0;
    for (let k = 0; k < ZETA16_COEFFICIENT_COUNT; k++) {
      x += (coefficients[k] ?? 0) * (BASIS_X[k] ?? 0);
      z += (coefficients[k] ?? 0) * (BASIS_Z[k] ?? 0);
    }
    return [this.originX + x * STUD_LDU, this.originZ + z * STUD_LDU];
  }

  isFinal(coefficients: Float64Array, heading: number): boolean {
    if (heading !== this.finalHeading) return false;
    for (let k = 0; k < ZETA16_COEFFICIENT_COUNT; k++) {
      if (coefficients[k] !== this.final[k]) return false;
    }
    return true;
  }

  private frameFor(move: TrackMove): MoveFrame {
    const frame = this.frames.find((f) => f.move === move);
    if (!frame) throw new Error(`${move.piece.id} is not a drawing-kit move`);
    return frame;
  }

  laidBlocked(
    frame: MoveFrame,
    heading: number,
    x: number,
    z: number,
    first: boolean,
    last: boolean,
  ): boolean {
    const outline = frame.outlines[heading];
    if (!outline) throw new RangeError(`no outline at heading ${heading}`);
    return this.site.clearance.blocks(
      outline,
      frame.boxes,
      heading * OUTLINE_BOX_FLOATS,
      x,
      z,
      first ? this.site.startOwner : NO_OBSTACLE,
      last ? this.site.goalOwner : NO_OBSTACLE,
    );
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
    const shifted = this.shifted;
    const bo = bHeading * OUTLINE_BOX_FLOATS;
    shifted[0] = (b.boxes[bo] ?? 0) + bx;
    shifted[1] = (b.boxes[bo + 1] ?? 0) + bz;
    shifted[2] = (b.boxes[bo + 2] ?? 0) + bx;
    shifted[3] = (b.boxes[bo + 3] ?? 0) + bz;
    if (!boxesOverlap(a.boxes, aHeading * OUTLINE_BOX_FLOATS, ax, az, shifted, 0)) return false;
    const aOutline = a.outlines[aHeading];
    const bOutline = b.outlines[bHeading];
    if (!aOutline || !bOutline) return false;
    return outlinesOverlap(aOutline, ax, az, bOutline, bx, bz);
  }

  endsBlocked(): boolean {
    let firstFree = false;
    let lastFree = false;
    const [x, z] = this.worldOf(ORIGIN);
    const before = new Float64Array(ZETA16_COEFFICIENT_COUNT);
    const after = new Float64Array(ZETA16_COEFFICIENT_COUNT);
    for (const frame of this.frames) {
      after.fill(0);
      addRotated(frame.delta, this.start.heading, after, 1);
      const last = this.isFinal(after, normalizeHeading16(this.start.heading + frame.turn));
      if (!this.laidBlocked(frame, this.start.heading, x, z, true, last)) firstFree = true;
      const heading = normalizeHeading16(this.finalHeading - frame.turn);
      before.set(this.final);
      addRotated(frame.delta, heading, before, -1);
      const first = heading === this.start.heading && before.every((c) => c === 0);
      const [bx, bz] = this.worldOf(before);
      if (!this.laidBlocked(frame, heading, bx, bz, first, true)) lastFree = true;
    }
    return !firstFree || !lastFree;
  }

  fits(moves: ReadonlyArray<TrackMove>): boolean {
    const coefficients = new Float64Array(ZETA16_COEFFICIENT_COUNT);
    const xs = new Float64Array(moves.length);
    const zs = new Float64Array(moves.length);
    const headings = new Int32Array(moves.length);
    const frames: MoveFrame[] = [];
    let heading = this.start.heading;
    for (let i = 0; i < moves.length; i++) {
      const move = moves[i];
      if (!move) continue;
      const frame = this.frameFor(move);
      const [x, z] = this.worldOf(coefficients);
      if (this.laidBlocked(frame, heading, x, z, i === 0, i === moves.length - 1)) return false;
      for (let j = 0; j < i - 1; j++) {
        const earlier = frames[j];
        if (!earlier) continue;
        if (
          this.piecesMeet(frame, heading, x, z, earlier, headings[j] ?? 0, xs[j] ?? 0, zs[j] ?? 0)
        ) {
          return false;
        }
      }
      frames.push(frame);
      xs[i] = x;
      zs[i] = z;
      headings[i] = heading;
      addRotated(frame.delta, heading, coefficients, 1);
      heading = normalizeHeading16(heading + frame.turn);
    }
    return true;
  }

  costOf(moves: ReadonlyArray<TrackMove>): number {
    let cost = 0;
    let previous: TrackMove | null = null;
    for (const move of moves) {
      cost += PIECE_COST + this.frameFor(move).lengthLdu;
      if (move !== previous) cost += SEGMENT_COST;
      previous = move;
    }
    return cost;
  }
}

class ClearClosureSearch {
  private readonly table = new Map<string, number>();
  private readonly maxStepLdu: number;
  private readonly minLengthLdu: number;
  private readonly finalX: number;
  private readonly finalZ: number;
  private readonly scratch = new Float64Array(ZETA16_COEFFICIENT_COUNT);
  sawBlockedJoin = false;

  constructor(
    private readonly geometry: ClosureGeometry,
    private readonly lowerBound: number,
  ) {
    let maxStep = 0;
    let minLength = Number.POSITIVE_INFINITY;
    for (const frame of geometry.frames) {
      const studs = zeta16ToStuds(frame.move.delta);
      maxStep = Math.max(maxStep, Math.hypot(studs.x, studs.z) * STUD_LDU);
      minLength = Math.min(minLength, frame.lengthLdu);
    }
    this.maxStepLdu = maxStep;
    this.minLengthLdu = minLength;
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
        Math.ceil(Math.hypot(this.finalX - x, this.finalZ - z) / this.maxStepLdu - BOUND_SLACK),
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
      priority: cost + left * (PIECE_COST + this.minLengthLdu),
    };
  }

  private pieceBlocked(at: SearchNode, frame: MoveFrame, last: boolean): boolean {
    const geometry = this.geometry;
    if (geometry.laidBlocked(frame, at.heading, at.x, at.z, at.parent === null, last)) return true;
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

export function clearClosure(
  kit: DrawingKit,
  start: Pose16,
  goal: Pose16,
  site: ClosureSite,
  algebraic: AlgebraicClosure,
): ClearClosureResult {
  const geometry = new ClosureGeometry(kit, start, goal, site);
  if (algebraic.run && geometry.fits(runMoves(kit, algebraic.run))) {
    return { kind: "exact", run: algebraic.run };
  }
  if (geometry.endsBlocked()) return { kind: "blocked" };
  let sawBlockedJoin = algebraic.run !== null;
  const candidates = algebraic.withinTurns
    .map((run) => {
      const moves = runMoves(kit, run);
      return { run, moves, cost: geometry.costOf(moves) };
    })
    .toSorted((a, b) => a.cost - b.cost);
  let incumbent: { readonly run: TrackRun; readonly cost: number } | null = null;
  for (const candidate of candidates) {
    if (geometry.fits(candidate.moves)) {
      incumbent = candidate;
      break;
    }
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
  return { kind: "blocked" };
}

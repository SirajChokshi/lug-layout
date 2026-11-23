import {
  HALF_TURN_16,
  LATTICE_LIMITS,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  normalizeHeading16,
  subtractZeta16,
  type Pose16,
  type Zeta16,
} from "@brr/math";
import type { DrawingKit, TurnSign } from "./drawing-kit.ts";
import { MAX_TURN_CURVES } from "./drawing-kit.ts";
import type { TrackMove } from "./track-pose.ts";

export type TrackSegment =
  | { readonly kind: "straight"; readonly count: number }
  | { readonly kind: "turn"; readonly sign: TurnSign; readonly curves: number };

export interface TrackRun {
  readonly segments: ReadonlyArray<TrackSegment>;
  readonly pieces: number;
}

const DEFAULT_CLOSURE_TURNS = 3;
const MAX_RUNS = DEFAULT_CLOSURE_TURNS + 1;
const MIN_EXACT_STRAIGHT_STUDS = MAX_RUNS;
const EXACT_DOUBLE_ABS_MAX = 2n ** 52n;
const NEGATIVE_EXACT_DOUBLE_ABS_MAX = -EXACT_DOUBLE_ABS_MAX;
const INT32_MAX = BigInt(LATTICE_LIMITS.INT32_MAX);
const NO_RUNS: ReadonlyArray<TrackRun> = [];

interface TurnSequenceTable {
  readonly turns: Int8Array;
  readonly turnCounts: Uint8Array;
  readonly curves: Uint8Array;
  readonly headings: Uint8Array;
  readonly arcSums: Int32Array;
  readonly indicesByNeeded: ReadonlyArray<Int32Array>;
  readonly exactDoubles: boolean;
  readonly straightStuds: number;
}

const turnSequencesByKit = new WeakMap<DrawingKit, TurnSequenceTable>();
const rotatedDifference = new Float64Array(ZETA16_COEFFICIENT_COUNT);
const straightCounts = new Float64Array(MAX_RUNS);

export function runMoves(kit: DrawingKit, run: TrackRun): ReadonlyArray<TrackMove> {
  const moves: TrackMove[] = [];
  for (const segment of run.segments) {
    switch (segment.kind) {
      case "straight":
        for (let i = 0; i < segment.count; i++) moves.push(kit.straight);
        break;
      case "turn": {
        const curve = segment.sign === 1 ? kit.left : kit.right;
        for (let i = 0; i < segment.curves; i++) moves.push(curve);
        break;
      }
      default: {
        const unhandled: never = segment;
        throw new Error(`unhandled segment ${String(unhandled)}`);
      }
    }
  }
  return moves;
}

export function runOfMoves(kit: DrawingKit, moves: ReadonlyArray<TrackMove>): TrackRun {
  const segments: TrackSegment[] = [];
  for (const move of moves) {
    const lastSegment = segments.at(-1);
    if (move === kit.straight) {
      if (lastSegment?.kind === "straight")
        segments[segments.length - 1] = { kind: "straight", count: lastSegment.count + 1 };
      else segments.push({ kind: "straight", count: 1 });
    } else {
      const sign = move === kit.left ? 1 : -1;
      if (lastSegment?.kind === "turn" && lastSegment.sign === sign) {
        segments[segments.length - 1] = { kind: "turn", sign, curves: lastSegment.curves + 1 };
      } else {
        segments.push({ kind: "turn", sign, curves: 1 });
      }
    }
  }
  return { segments, pieces: moves.length };
}

function signedTurns(maxCurves: number): ReadonlyArray<number> {
  const turns: number[] = [];
  for (let m = 1; m <= maxCurves; m++) turns.push(m, -m);
  return turns;
}

function turnSign(turn: number): TurnSign {
  return turn > 0 ? 1 : -1;
}

function fitsInt32(value: bigint): boolean {
  return value <= INT32_MAX && -value <= INT32_MAX;
}

function turnSequenceCount(choices: number): number {
  let count = 0;
  let level = 1;
  for (let t = 0; t <= DEFAULT_CLOSURE_TURNS; t++) {
    count += level;
    level *= choices;
  }
  return count;
}

function arcSlot(m: number, heading: number): number {
  const sign = m > 0 ? 0 : 1;
  return (
    ((sign * MAX_TURN_CURVES + Math.abs(m) - 1) * ZETA16_ORDER + heading) * ZETA16_COEFFICIENT_COUNT
  );
}

function buildTurnSequenceTable(kit: DrawingKit): TurnSequenceTable {
  const choices = signedTurns(MAX_TURN_CURVES);
  const count = turnSequenceCount(choices.length);
  const turns = new Int8Array(count * DEFAULT_CLOSURE_TURNS);
  const turnCounts = new Uint8Array(count);
  const curves = new Uint8Array(count);
  const headings = new Uint8Array(count * MAX_RUNS);
  const arcSums = new Int32Array(count * ZETA16_COEFFICIENT_COUNT);
  const studs = kit.straightStuds;
  let exactDoubles = studs >= BigInt(MIN_EXACT_STRAIGHT_STUDS) && fitsInt32(studs);
  const arcs = new Int32Array(choices.length * ZETA16_ORDER * ZETA16_COEFFICIENT_COUNT);
  for (const m of choices) {
    for (let heading = 0; heading < ZETA16_ORDER; heading++) {
      const arc = kit.arc(turnSign(m), Math.abs(m), heading);
      const slot = arcSlot(m, heading);
      arc.forEach((coefficient, power) => {
        if (fitsInt32(coefficient)) arcs[slot + power] = Number(coefficient);
        else exactDoubles = false;
      });
    }
  }
  const sums = new Float64Array((DEFAULT_CLOSURE_TURNS + 1) * ZETA16_COEFFICIENT_COUNT);
  const stackEntry = new Int32Array(DEFAULT_CLOSURE_TURNS + 1);
  const stackChild = new Int32Array(DEFAULT_CLOSURE_TURNS + 1);
  let next = 1;
  let depth = 0;
  while (depth >= 0) {
    const child = stackChild[depth] ?? 0;
    if (depth === DEFAULT_CLOSURE_TURNS || child === choices.length) {
      depth--;
      continue;
    }
    stackChild[depth] = child + 1;
    const m = choices[child] ?? 0;
    const parent = stackEntry[depth] ?? 0;
    const entry = next++;
    for (let t = 0; t < depth; t++) {
      turns[entry * DEFAULT_CLOSURE_TURNS + t] = turns[parent * DEFAULT_CLOSURE_TURNS + t] ?? 0;
    }
    turns[entry * DEFAULT_CLOSURE_TURNS + depth] = m;
    for (let r = 0; r <= depth; r++) {
      headings[entry * MAX_RUNS + r] = headings[parent * MAX_RUNS + r] ?? 0;
    }
    const parentHeading = headings[parent * MAX_RUNS + depth] ?? 0;
    headings[entry * MAX_RUNS + depth + 1] = normalizeHeading16(parentHeading + m);
    turnCounts[entry] = depth + 1;
    curves[entry] = (curves[parent] ?? 0) + Math.abs(m);
    const slot = arcSlot(m, parentHeading);
    for (let power = 0; power < ZETA16_COEFFICIENT_COUNT; power++) {
      const sum = (sums[depth * ZETA16_COEFFICIENT_COUNT + power] ?? 0) + (arcs[slot + power] ?? 0);
      sums[(depth + 1) * ZETA16_COEFFICIENT_COUNT + power] = sum;
      if (Math.abs(sum) <= LATTICE_LIMITS.INT32_MAX) {
        arcSums[entry * ZETA16_COEFFICIENT_COUNT + power] = sum;
      } else {
        exactDoubles = false;
      }
    }
    depth++;
    stackEntry[depth] = entry;
    stackChild[depth] = 0;
  }
  const needed = new Int32Array(ZETA16_ORDER);
  for (let entry = 0; entry < count; entry++) {
    const heading = headings[entry * MAX_RUNS + (turnCounts[entry] ?? 0)] ?? 0;
    needed[heading] = (needed[heading] ?? 0) + 1;
  }
  const indicesByNeeded = Array.from(
    { length: ZETA16_ORDER },
    (_v, heading) => new Int32Array(needed[heading] ?? 0),
  );
  needed.fill(0);
  for (let entry = 0; entry < count; entry++) {
    const heading = headings[entry * MAX_RUNS + (turnCounts[entry] ?? 0)] ?? 0;
    const list = indicesByNeeded[heading];
    if (list) list[needed[heading] ?? 0] = entry;
    needed[heading] = (needed[heading] ?? 0) + 1;
  }
  return {
    turns,
    turnCounts,
    curves,
    headings,
    arcSums,
    indicesByNeeded,
    exactDoubles,
    straightStuds: Number(studs),
  };
}

function turnSequenceTable(kit: DrawingKit): TurnSequenceTable {
  const known = turnSequencesByKit.get(kit);
  if (known) return known;
  const table = buildTurnSequenceTable(kit);
  turnSequencesByKit.set(kit, table);
  return table;
}

function fitsExactDouble(value: bigint): boolean {
  return value <= EXACT_DOUBLE_ABS_MAX && value >= NEGATIVE_EXACT_DOUBLE_ABS_MAX;
}

function rotateDifferenceIntoScratch(start: Pose16, goal: Pose16): boolean {
  const turns = normalizeHeading16(-start.heading);
  for (let power = 0; power < ZETA16_COEFFICIENT_COUNT; power++) {
    const source = power - turns;
    let value: bigint;
    if (source >= 0) {
      value = (goal.position[source] ?? 0n) - (start.position[source] ?? 0n);
    } else if (source + ZETA16_COEFFICIENT_COUNT >= 0) {
      const wrapped = source + ZETA16_COEFFICIENT_COUNT;
      value = (start.position[wrapped] ?? 0n) - (goal.position[wrapped] ?? 0n);
    } else {
      const wrapped = source + ZETA16_ORDER;
      value = (goal.position[wrapped] ?? 0n) - (start.position[wrapped] ?? 0n);
    }
    if (!fitsExactDouble(value)) return false;
    rotatedDifference[power] = Number(value);
  }
  return true;
}

function matchingRun(
  table: TurnSequenceTable,
  entry: number,
  runs: number,
  power: number,
  wanted: number,
): number {
  for (let run = 0; run < runs; run++) {
    const heading = table.headings[entry * MAX_RUNS + run] ?? 0;
    if (
      heading % ZETA16_COEFFICIENT_COUNT === power &&
      Math.floor(heading / ZETA16_COEFFICIENT_COUNT) === wanted
    ) {
      return run;
    }
  }
  return -1;
}

function runFromEntry(
  table: TurnSequenceTable,
  entry: number,
  runs: number,
  pieces: number,
): TrackRun {
  const segments: TrackSegment[] = [];
  for (let run = 0; run < runs; run++) {
    const count = straightCounts[run] ?? 0;
    if (count > 0) segments.push({ kind: "straight", count });
    if (run < runs - 1) {
      const m = table.turns[entry * DEFAULT_CLOSURE_TURNS + run] ?? 0;
      segments.push({ kind: "turn", sign: turnSign(m), curves: Math.abs(m) });
    }
  }
  return { segments, pieces };
}

function closureRunFromEntry(
  table: TurnSequenceTable,
  entry: number,
  maxPieces: number,
): TrackRun | undefined {
  const runs = (table.turnCounts[entry] ?? 0) + 1;
  const studs = table.straightStuds;
  straightCounts.fill(0);
  for (let power = 0; power < ZETA16_COEFFICIENT_COUNT; power++) {
    const residual =
      (rotatedDifference[power] ?? 0) -
      (table.arcSums[entry * ZETA16_COEFFICIENT_COUNT + power] ?? 0);
    if (residual === 0) continue;
    if (residual % studs !== 0) return undefined;
    const quotient = residual / studs;
    const run = matchingRun(table, entry, runs, power, quotient > 0 ? 0 : 1);
    if (run < 0) return undefined;
    straightCounts[run] = quotient > 0 ? quotient : -quotient;
  }
  let pieces = table.curves[entry] ?? 0;
  for (let run = 0; run < runs; run++) pieces += straightCounts[run] ?? 0;
  if (pieces > maxPieces) return undefined;
  return runFromEntry(table, entry, runs, pieces);
}

function closureRun(
  kit: DrawingKit,
  start: Pose16,
  goal: Pose16,
  turns: ReadonlyArray<number>,
): TrackRun | undefined {
  let residual: Zeta16 = subtractZeta16(goal.position, start.position);
  const headings: number[] = [start.heading];
  let heading = start.heading;
  for (const m of turns) {
    residual = subtractZeta16(residual, kit.arc(turnSign(m), Math.abs(m), heading));
    heading = normalizeHeading16(heading + m);
    headings.push(heading);
  }
  const counts = Array.from({ length: headings.length }, () => 0);
  for (let i = 0; i < ZETA16_COEFFICIENT_COUNT; i++) {
    const value = residual[i] ?? 0n;
    if (value === 0n) continue;
    if (value % kit.straightStuds !== 0n) return undefined;
    const quotient = value / kit.straightStuds;
    const wanted = quotient > 0n ? 0 : 1;
    const run = headings.findIndex(
      (h) =>
        h % ZETA16_COEFFICIENT_COUNT === i && Math.floor(h / ZETA16_COEFFICIENT_COUNT) === wanted,
    );
    if (run < 0) return undefined;
    counts[run] = Number(quotient > 0n ? quotient : -quotient);
  }
  const segments: TrackSegment[] = [];
  let pieces = 0;
  counts.forEach((count, r) => {
    if (count > 0) segments.push({ kind: "straight", count });
    pieces += count;
    const m = turns[r];
    if (m !== undefined) {
      segments.push({ kind: "turn", sign: turnSign(m), curves: Math.abs(m) });
      pieces += Math.abs(m);
    }
  });
  return { segments, pieces };
}

function turnCount(run: TrackRun): number {
  return run.segments.filter((segment) => segment.kind === "turn").length;
}

export function fewestWithinTurns(runs: ReadonlyArray<TrackRun>): TrackRun | null {
  let best: TrackRun | null = null;
  for (const run of runs) {
    if (
      !best ||
      run.pieces < best.pieces ||
      (run.pieces === best.pieces && turnCount(run) < turnCount(best))
    ) {
      best = run;
    }
  }
  return best;
}

function exactClosures(
  table: TurnSequenceTable,
  entries: Int32Array,
  maxPieces: number,
): ReadonlyArray<TrackRun> {
  let runs: TrackRun[] | null = null;
  for (let e = 0; e < entries.length; e++) {
    const entry = entries[e] ?? 0;
    if ((table.curves[entry] ?? 0) > maxPieces) continue;
    const run = closureRunFromEntry(table, entry, maxPieces);
    if (!run) continue;
    runs ??= [];
    runs.push(run);
  }
  return runs ?? NO_RUNS;
}

function bigIntClosures(
  kit: DrawingKit,
  table: TurnSequenceTable,
  entries: Int32Array,
  start: Pose16,
  goal: Pose16,
  maxPieces: number,
): ReadonlyArray<TrackRun> {
  const runs: TrackRun[] = [];
  for (let e = 0; e < entries.length; e++) {
    const entry = entries[e] ?? 0;
    if ((table.curves[entry] ?? 0) > maxPieces) continue;
    const first = entry * DEFAULT_CLOSURE_TURNS;
    const turns = Array.from(table.turns.subarray(first, first + (table.turnCounts[entry] ?? 0)));
    const run = closureRun(kit, start, goal, turns);
    if (run && run.pieces <= maxPieces) runs.push(run);
  }
  return runs;
}

export function closuresWithinTurns(
  kit: DrawingKit,
  start: Pose16,
  goal: Pose16,
  maxPieces: number = Number.POSITIVE_INFINITY,
): ReadonlyArray<TrackRun> {
  const needed = normalizeHeading16(goal.heading + HALF_TURN_16 - start.heading);
  const table = turnSequenceTable(kit);
  const entries = table.indicesByNeeded[needed];
  if (!entries) return NO_RUNS;
  if (table.exactDoubles && rotateDifferenceIntoScratch(start, goal)) {
    return exactClosures(table, entries, maxPieces);
  }
  return bigIntClosures(kit, table, entries, start, goal, maxPieces);
}

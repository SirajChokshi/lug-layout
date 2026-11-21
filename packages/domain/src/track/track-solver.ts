import {
  HALF_TURN_16,
  ZETA16_COEFFICIENT_COUNT,
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

export const DEFAULT_CLOSURE_TURNS = 3;

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

function turnSequences(
  needed: number,
  maxTurns: number,
  maxCurves: number,
): ReadonlyArray<ReadonlyArray<number>> {
  const all = signedTurns(Math.min(MAX_TURN_CURVES, maxCurves));
  const out: number[][] = [];
  const walk = (prefix: number[], sum: number, curves: number): void => {
    if (normalizeHeading16(sum) === needed) out.push([...prefix]);
    if (prefix.length === maxTurns) return;
    for (const m of all) {
      const used = curves + Math.abs(m);
      if (used > maxCurves) continue;
      prefix.push(m);
      walk(prefix, sum + m, used);
      prefix.pop();
    }
  };
  walk([], 0, 0);
  return out;
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

export function closuresWithinTurns(
  kit: DrawingKit,
  start: Pose16,
  goal: Pose16,
  maxTurns: number = DEFAULT_CLOSURE_TURNS,
  maxPieces: number = Number.POSITIVE_INFINITY,
): ReadonlyArray<TrackRun> {
  const needed = normalizeHeading16(goal.heading + HALF_TURN_16 - start.heading);
  const runs: TrackRun[] = [];
  for (const turns of turnSequences(needed, maxTurns, maxPieces)) {
    const run = closureRun(kit, start, goal, turns);
    if (run && run.pieces <= maxPieces) runs.push(run);
  }
  return runs;
}

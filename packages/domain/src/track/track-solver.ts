import {
  HALF_TURN_16,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  normalizeHeading16,
  subtractZeta16,
  zeta16ToStuds,
  type PlaneStuds,
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

export interface DragPlan extends TrackRun {
  readonly key: string;
  readonly missStuds: number;
  readonly costStuds: number;
}

export const DEFAULT_CLOSURE_TURNS = 3;
const DRAG_MAX_TURN_CURVES = ZETA16_ORDER / 2;
const DRAG_MAX_STRAIGHTS = 96;
const STRAIGHT_COST_STUDS = 0.25;
const CURVE_COST_STUDS = 0.5;
const S_CURVE_COST_STUDS = 3;
const HYSTERESIS_STUDS = 1.5;
const PARALLEL_EPSILON = 1e-9;

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

function signedTurns(maxCurves: number): ReadonlyArray<number> {
  const turns: number[] = [];
  for (let m = 1; m <= maxCurves; m++) turns.push(m, -m);
  return turns;
}

function turnSign(turn: number): TurnSign {
  return turn > 0 ? 1 : -1;
}

function turnSequences(needed: number, maxTurns: number): ReadonlyArray<ReadonlyArray<number>> {
  const all = signedTurns(MAX_TURN_CURVES);
  const out: number[][] = [];
  const walk = (prefix: number[], sum: number): void => {
    if (normalizeHeading16(sum) === needed) out.push([...prefix]);
    if (prefix.length === maxTurns) return;
    for (const m of all) {
      prefix.push(m);
      walk(prefix, sum + m);
      prefix.pop();
    }
  };
  walk([], 0);
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

export function closureWithinTurns(
  kit: DrawingKit,
  start: Pose16,
  goal: Pose16,
  maxTurns: number = DEFAULT_CLOSURE_TURNS,
): TrackRun | null {
  const needed = normalizeHeading16(goal.heading + HALF_TURN_16 - start.heading);
  let best: TrackRun | null = null;
  let bestTurns = Infinity;
  for (const turns of turnSequences(needed, maxTurns)) {
    const run = closureRun(kit, start, goal, turns);
    if (!run) continue;
    if (
      !best ||
      run.pieces < best.pieces ||
      (run.pieces === best.pieces && turns.length < bestTurns)
    ) {
      best = run;
      bestTurns = turns.length;
    }
  }
  return best;
}

interface Vec {
  readonly x: number;
  readonly z: number;
}

function direction(heading: number): Vec {
  const angle = (normalizeHeading16(heading) * 2 * Math.PI) / ZETA16_ORDER;
  return { x: Math.cos(angle), z: Math.sin(angle) };
}

function straightCounts(
  v: Vec,
  u: Vec,
  w: Vec,
  length: number,
): ReadonlyArray<readonly [number, number]> {
  const det = u.x * w.z - u.z * w.x;
  if (Math.abs(det) < PARALLEL_EPSILON) {
    const along = (v.x * u.x + v.z * u.z) / length;
    const sameWay = u.x * w.x + u.z * w.z > 0;
    if (sameWay || along >= 0) {
      const a = Math.max(0, along);
      return [
        [Math.floor(a), 0],
        [Math.ceil(a), 0],
      ];
    }
    return [
      [0, Math.floor(-along)],
      [0, Math.ceil(-along)],
    ];
  }
  const a = Math.max(0, (v.x * w.z - v.z * w.x) / (det * length));
  const b = Math.max(0, (u.x * v.z - u.z * v.x) / (det * length));
  return [
    [Math.floor(a), Math.floor(b)],
    [Math.floor(a), Math.ceil(b)],
    [Math.ceil(a), Math.floor(b)],
    [Math.ceil(a), Math.ceil(b)],
  ];
}

interface Family {
  readonly key: string;
  readonly turns: ReadonlyArray<number>;
  readonly leadingStraight: boolean;
}

function dragFamilies(): ReadonlyArray<Family> {
  const families: Family[] = [{ key: "S", turns: [], leadingStraight: true }];
  const turns = signedTurns(DRAG_MAX_TURN_CURVES);
  for (const m of turns) families.push({ key: `SCS${m}`, turns: [m], leadingStraight: true });
  for (const m of turns) {
    for (const p of turns)
      families.push({ key: `CSCS${m},${p}`, turns: [m, p], leadingStraight: false });
  }
  return families;
}

const DRAG_FAMILIES = dragFamilies();

function arcStuds(kit: DrawingKit, turn: number, heading: number): Vec {
  return zeta16ToStuds(kit.arc(turnSign(turn), Math.abs(turn), heading));
}

function planFor(
  kit: DrawingKit,
  family: Family,
  start: Pose16,
  origin: Vec,
  target: PlaneStuds,
): DragPlan | undefined {
  const length = Number(kit.straightStuds);
  const [m, p] = family.turns;
  const h0 = start.heading;
  let offset: Vec = { x: 0, z: 0 };
  let u: Vec;
  let w: Vec;
  if (family.leadingStraight) {
    u = direction(h0);
    if (m === undefined) {
      w = u;
    } else {
      offset = arcStuds(kit, m, h0);
      w = direction(h0 + m);
    }
  } else {
    if (m === undefined || p === undefined) return undefined;
    const first = arcStuds(kit, m, h0);
    const second = arcStuds(kit, p, h0 + m);
    offset = { x: first.x + second.x, z: first.z + second.z };
    u = direction(h0 + m);
    w = direction(h0 + m + p);
  }
  const v: Vec = { x: target.x - origin.x - offset.x, z: target.z - origin.z - offset.z };
  let best: DragPlan | undefined;
  for (const [a, b] of straightCounts(v, u, w, length)) {
    if (a + b > DRAG_MAX_STRAIGHTS) continue;
    let segments: TrackSegment[];
    let curves = 0;
    let cost = 0;
    if (family.leadingStraight) {
      segments = [];
      if (a > 0) segments.push({ kind: "straight", count: a });
      if (m !== undefined) {
        segments.push({ kind: "turn", sign: turnSign(m), curves: Math.abs(m) });
        curves = Math.abs(m);
        if (b > 0) segments.push({ kind: "straight", count: b });
      }
    } else {
      if (m === undefined || p === undefined) continue;
      if (a === 0 && turnSign(m) === turnSign(p)) continue;
      if (a === 0) cost += S_CURVE_COST_STUDS;
      segments = [{ kind: "turn", sign: turnSign(m), curves: Math.abs(m) }];
      if (a > 0) segments.push({ kind: "straight", count: a });
      segments.push({ kind: "turn", sign: turnSign(p), curves: Math.abs(p) });
      if (b > 0) segments.push({ kind: "straight", count: b });
      curves = Math.abs(m) + Math.abs(p);
    }
    const end = {
      x: origin.x + offset.x + length * (a * u.x + b * w.x),
      z: origin.z + offset.z + length * (a * u.z + b * w.z),
    };
    const missStuds = Math.hypot(end.x - target.x, end.z - target.z);
    const straights = family.leadingStraight && m === undefined ? a : a + b;
    cost += missStuds + STRAIGHT_COST_STUDS * straights + CURVE_COST_STUDS * curves;
    if (!best || cost < best.costStuds) {
      best = { key: family.key, segments, pieces: straights + curves, missStuds, costStuds: cost };
    }
  }
  return best;
}

export function solveDrag(
  kit: DrawingKit,
  start: Pose16,
  target: PlaneStuds,
  previousKey: string | null = null,
): DragPlan {
  const origin = zeta16ToStuds(start.position);
  const stay = Math.hypot(target.x - origin.x, target.z - origin.z);
  let best: DragPlan = { key: "none", segments: [], pieces: 0, missStuds: stay, costStuds: stay };
  let previous: DragPlan | undefined;
  for (const family of DRAG_FAMILIES) {
    const plan = planFor(kit, family, start, origin, target);
    if (!plan) continue;
    if (family.key === previousKey) previous = plan;
    if (plan.costStuds < best.costStuds) best = plan;
  }
  if (previous && previous.costStuds <= best.costStuds + HYSTERESIS_STUDS) return previous;
  return best;
}

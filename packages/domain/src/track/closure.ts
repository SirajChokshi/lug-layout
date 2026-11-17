import {
  HALF_TURN_16,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  normalizeHeading16,
  posesJoin16,
  rotateZeta16,
  subtractZeta16,
  zeta16Equals,
  type Pose16,
} from "@brr/math";
import type { DrawingKit } from "./drawing-kit.ts";
import { layMoves, type TrackMove } from "./track-pose.ts";
import { closureWithinTurns, type TrackRun, type TrackSegment } from "./track-solver.ts";

export interface SearchBudget {
  readonly now: () => number;
  readonly limitMs: number;
}

export const UNLIMITED_BUDGET: SearchBudget = { now: () => 0, limitMs: Number.POSITIVE_INFINITY };

export type ClosureResult =
  | { readonly kind: "exact"; readonly run: TrackRun }
  | { readonly kind: "impossible" }
  | { readonly kind: "limit" };

const BASIS = ZETA16_COEFFICIENT_COUNT;
const EDGES = ZETA16_ORDER;
const BOX_SIZES: ReadonlyArray<number> = [8, 16, 32, 64, 128, 256];
const BUDGET_CHECK_NODES = 256;
const PAIR_FILL_PIECES = 4;

interface Arc {
  readonly edges: Uint8Array;
  readonly vertices: Uint8Array;
}

function arcs(): ReadonlyArray<Arc> {
  const list: Arc[] = [];
  const add = (start: number, length: number): void => {
    const edges = new Uint8Array(EDGES);
    const vertices = new Uint8Array(EDGES);
    for (let i = 0; i < length; i++) {
      edges[(start + i) % EDGES] = 1;
      vertices[(start + i) % EDGES] = 1;
      vertices[(start + i + 1) % EDGES] = 1;
    }
    list.push({ edges, vertices });
  };
  for (let start = 0; start < EDGES; start++) {
    for (let length = 1; length < EDGES; length++) add(start, length);
  }
  add(0, EDGES);
  return list;
}

const ARCS = arcs();

interface Chain {
  readonly length: number;
  readonly residual: Float64Array;
  readonly chords: ReadonlyArray<Float64Array>;
  readonly unaryRows: ReadonlyArray<ReadonlyArray<number>>;
  readonly pairRows: ReadonlyArray<ReadonlyArray<number>>;
  readonly constant: number;
}

interface Crossings {
  readonly pieces: number;
  readonly edges: Int32Array;
  readonly straights: Int32Array;
}

class Deadline {
  private nodes = 0;
  expired = false;
  private readonly started: number;

  constructor(private readonly budget: SearchBudget) {
    this.started = budget.now();
  }

  tick(): boolean {
    this.nodes++;
    if (this.nodes % BUDGET_CHECK_NODES === 0) this.check();
    return this.expired;
  }

  check(): boolean {
    if (this.budget.now() - this.started > this.budget.limitMs) this.expired = true;
    return this.expired;
  }
}

function chordsOf(kit: DrawingKit): ReadonlyArray<Float64Array> | undefined {
  if (!zeta16Equals(rotateZeta16(kit.right.delta, 1), kit.left.delta)) return undefined;
  return Array.from({ length: BASIS }, (_v, j) =>
    Float64Array.from(rotateZeta16(kit.left.delta, j), (c) => Number(c)),
  );
}

function chainOf(
  chords: ReadonlyArray<Float64Array>,
  residual: Float64Array,
  length: number,
): Chain | undefined {
  const unaryRows: number[][] = Array.from({ length: BASIS }, () => []);
  const pairRows: number[][] = Array.from({ length: BASIS }, () => []);
  let constant = 0;
  for (let k = 0; k < BASIS; k++) {
    const support: number[] = [];
    for (let j = 0; j < BASIS; j++) if ((chords[j]?.[k] ?? 0) !== 0) support.push(j);
    const [a, b] = support;
    if (a === undefined) constant += Math.abs(residual[k] ?? 0);
    else if (b === undefined) unaryRows[a]?.push(k);
    else if (support.length === 2 && b === a + 1) pairRows[a]?.push(k);
    else if (support.length === 2 && a === 0 && b === BASIS - 1) pairRows[b]?.push(k);
    else return undefined;
  }
  for (const chord of chords) {
    for (const c of chord) if ((2 * c) % length !== 0) return undefined;
  }
  return { length, residual, chords, unaryRows, pairRows, constant };
}

function crossingParity(h0: number, h1: number): Int32Array {
  const parity = new Int32Array(BASIS);
  if (h0 === h1) return parity;
  for (let j = 0; j < BASIS; j++) {
    let count = 0;
    for (let v = j + 1; v <= j + BASIS; v++) {
      const vertex = v % EDGES;
      if (vertex === h0 || vertex === h1) count++;
    }
    parity[j] = count % 2;
  }
  return parity;
}

function edgeParityPatterns(h0: number, h1: number): ReadonlyArray<Int32Array> {
  return [0, 1].map((first) => {
    const pattern = new Int32Array(EDGES);
    pattern[0] = first;
    for (let v = 1; v < EDGES; v++) {
      const special = h0 !== h1 && (v === h0 || v === h1) ? 1 : 0;
      pattern[v] = (pattern[v - 1] ?? 0) ^ special;
    }
    return pattern;
  });
}

function mod(value: number, m: number): number {
  return ((value % m) + m) % m;
}

class ClosureChain {
  private readonly patterns: ReadonlyArray<Int32Array>;

  constructor(
    private readonly chain: Chain,
    private readonly parity: Int32Array,
    private readonly h0: number,
    private readonly h1: number,
  ) {
    this.patterns = edgeParityPatterns(h0, h1);
  }

  private row(k: number, curves: Int32Array): number {
    let value = this.chain.residual[k] ?? 0;
    for (let j = 0; j < BASIS; j++) value -= (curves[j] ?? 0) * (this.chain.chords[j]?.[k] ?? 0);
    return value;
  }

  get constant(): number {
    return this.chain.constant;
  }

  unary(j: number, x: number): number {
    let total = this.chain.length * Math.abs(x);
    const chord = this.chain.chords[j];
    for (const k of this.chain.unaryRows[j] ?? []) {
      total += Math.abs((this.chain.residual[k] ?? 0) - x * (chord?.[k] ?? 0));
    }
    return total;
  }

  pair(j: number, x: number, y: number): number {
    let total = 0;
    const next = (j + 1) % BASIS;
    const a = this.chain.chords[j];
    const b = this.chain.chords[next];
    for (const k of this.chain.pairRows[j] ?? []) {
      total += Math.abs((this.chain.residual[k] ?? 0) - x * (a?.[k] ?? 0) - y * (b?.[k] ?? 0));
    }
    return total;
  }

  domain(j: number, box: number): Int32Array {
    const values: number[] = [];
    const parity = this.parity[j] ?? 0;
    for (let magnitude = parity; magnitude <= box; magnitude += 2) {
      values.push(magnitude);
      if (magnitude > 0) values.push(-magnitude);
    }
    return Int32Array.from(values);
  }

  crossings(curves: Int32Array): Crossings {
    const straights = new Int32Array(EDGES);
    const required = new Uint8Array(EDGES);
    required[this.h0] = 1;
    required[this.h1] = 1;
    let straightCount = 0;
    for (let k = 0; k < BASIS; k++) {
      const n = this.row(k, curves) / this.chain.length;
      if (n > 0) {
        straights[k] = n;
        required[k] = 1;
      } else if (n < 0) {
        straights[k + BASIS] = -n;
        required[k + BASIS] = 1;
      }
      straightCount += Math.abs(n);
    }
    let best: Int32Array | undefined;
    let bestCurves = Number.POSITIVE_INFINITY;
    for (const pattern of this.patterns) {
      const edges = new Int32Array(EDGES);
      for (let j = 0; j < BASIS; j++) {
        const m = curves[j] ?? 0;
        let forward = Math.max(m, 0);
        let backward = Math.max(-m, 0);
        if (mod(forward, 2) !== (pattern[j] ?? 0)) {
          forward += 1;
          backward += 1;
        }
        edges[j] = forward;
        edges[j + BASIS] = backward;
      }
      const filled = this.connect(edges, required);
      if (!filled) continue;
      let total = 0;
      for (const e of filled) total += e;
      if (total < bestCurves) {
        bestCurves = total;
        best = filled;
      }
    }
    if (!best)
      throw new Error("no Euler trail fits these crossings, which the parity rule excludes");
    return { pieces: bestCurves + straightCount, edges: best, straights };
  }

  private connect(edges: Int32Array, required: Uint8Array): Int32Array | undefined {
    let present = 0;
    for (const e of edges) if (e > 0) present++;
    if (present === 0 && this.h0 === this.h1) {
      let onlyStart = true;
      for (let v = 0; v < EDGES; v++) if (required[v] && v !== this.h0) onlyStart = false;
      if (onlyStart) return edges;
    }
    let best: Int32Array | undefined;
    let bestFill = Number.POSITIVE_INFINITY;
    for (const arc of ARCS) {
      let valid = true;
      for (let h = 0; h < EDGES && valid; h++) {
        if ((edges[h] ?? 0) > 0 && !arc.edges[h]) valid = false;
        if (required[h] && !arc.vertices[h]) valid = false;
      }
      if (!valid) continue;
      const fill = new Uint8Array(BASIS);
      for (let h = 0; h < EDGES && valid; h++) {
        if (!arc.edges[h] || (edges[h] ?? 0) > 0) continue;
        const pairIndex = h % BASIS;
        if (!arc.edges[pairIndex] || !arc.edges[pairIndex + BASIS]) valid = false;
        fill[pairIndex] = 1;
      }
      if (!valid) continue;
      let fills = 0;
      for (const f of fill) fills += f;
      if (fills < bestFill) {
        bestFill = fills;
        const filled = Int32Array.from(edges);
        for (let j = 0; j < BASIS; j++) {
          if (!fill[j]) continue;
          filled[j] = (filled[j] ?? 0) + PAIR_FILL_PIECES / 2;
          filled[j + BASIS] = (filled[j + BASIS] ?? 0) + PAIR_FILL_PIECES / 2;
        }
        best = filled;
      }
    }
    return best;
  }
}

interface Candidate {
  readonly i: number;
  readonly bound: number;
}

function insertByBound(order: Candidate[], candidate: Candidate): void {
  let at = order.length;
  while (at > 0 && (order[at - 1]?.bound ?? 0) > candidate.bound) at--;
  order.splice(at, 0, candidate);
}

interface Incumbent {
  pieces: number;
  curves: Int32Array | undefined;
}

function searchBox(
  problem: ClosureChain,
  box: number,
  incumbent: Incumbent,
  deadline: Deadline,
  scale: number,
): void {
  const domains = Array.from({ length: BASIS }, (_v, j) => problem.domain(j, box));
  const last = BASIS - 1;
  const chosen = new Int32Array(BASIS);
  for (const v0 of domains[0] ?? []) {
    if (deadline.check()) return;
    const toGo: Float64Array[] = Array.from(
      { length: BASIS },
      (_v, j) => new Float64Array(domains[j]?.length ?? 0),
    );
    const lastDomain = domains[last] ?? new Int32Array(0);
    const lastToGo = toGo[last] ?? new Float64Array(0);
    for (let i = 0; i < lastDomain.length; i++) {
      const x = lastDomain[i] ?? 0;
      lastToGo[i] = problem.unary(last, x) + problem.pair(last, x, v0);
    }
    for (let j = last - 1; j >= 1; j--) {
      const domain = domains[j] ?? new Int32Array(0);
      const nextDomain = domains[j + 1] ?? new Int32Array(0);
      const nextToGo = toGo[j + 1] ?? new Float64Array(0);
      const here = toGo[j] ?? new Float64Array(0);
      for (let i = 0; i < domain.length; i++) {
        const x = domain[i] ?? 0;
        let bestNext = Number.POSITIVE_INFINITY;
        for (let n = 0; n < nextDomain.length; n++) {
          const cost = problem.pair(j, x, nextDomain[n] ?? 0) + (nextToGo[n] ?? 0);
          if (cost < bestNext) bestNext = cost;
        }
        here[i] = problem.unary(j, x) + bestNext;
      }
    }
    chosen[0] = v0;
    const descend = (j: number, accumulated: number): void => {
      if (deadline.expired) return;
      const previous = chosen[j - 1] ?? 0;
      const domain = domains[j] ?? new Int32Array(0);
      const here = toGo[j] ?? new Float64Array(0);
      const base = accumulated + problem.unary(j - 1, previous);
      const order: Candidate[] = [];
      for (let i = 0; i < domain.length; i++) {
        const bound = base + problem.pair(j - 1, previous, domain[i] ?? 0) + (here[i] ?? 0);
        if (bound / scale < incumbent.pieces) insertByBound(order, { i, bound });
      }
      for (const { i } of order) {
        if (deadline.tick()) return;
        const x = domain[i] ?? 0;
        chosen[j] = x;
        const next = base + problem.pair(j - 1, previous, x);
        if (j === last) {
          const lowerBound = (next + (here[i] ?? 0)) / scale;
          if (lowerBound >= incumbent.pieces) continue;
          const crossing = problem.crossings(chosen);
          if (crossing.pieces < incumbent.pieces) {
            incumbent.pieces = crossing.pieces;
            incumbent.curves = Int32Array.from(chosen);
          }
        } else {
          descend(j + 1, next);
        }
      }
    };
    descend(1, problem.constant);
  }
}

function trailMoves(
  kit: DrawingKit,
  crossing: Crossings,
  h0: number,
  h1: number,
): ReadonlyArray<TrackMove> {
  const remaining = Int32Array.from(crossing.edges);
  const stack = [h0];
  const trail: number[] = [];
  while (stack.length > 0) {
    const v = stack.at(-1) ?? h0;
    const back = (v + EDGES - 1) % EDGES;
    if ((remaining[v] ?? 0) > 0) {
      remaining[v] = (remaining[v] ?? 0) - 1;
      stack.push((v + 1) % EDGES);
    } else if ((remaining[back] ?? 0) > 0) {
      remaining[back] = (remaining[back] ?? 0) - 1;
      stack.push(back);
    } else {
      trail.push(stack.pop() ?? h0);
    }
  }
  trail.reverse();
  if (trail[0] !== h0 || trail.at(-1) !== h1) {
    throw new Error(`Euler trail runs ${trail[0]} → ${trail.at(-1)}, expected ${h0} → ${h1}`);
  }
  const moves: TrackMove[] = [];
  const placed = new Uint8Array(EDGES);
  trail.forEach((v, i) => {
    if (!placed[v]) {
      placed[v] = 1;
      for (let s = 0; s < (crossing.straights[v] ?? 0); s++) moves.push(kit.straight);
    }
    const next = trail[i + 1];
    if (next === undefined) return;
    moves.push(next === (v + 1) % EDGES ? kit.left : kit.right);
  });
  return moves;
}

function segmentsOf(kit: DrawingKit, moves: ReadonlyArray<TrackMove>): TrackRun {
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

function completeClosure(
  kit: DrawingKit,
  start: Pose16,
  goal: Pose16,
  deadline: Deadline,
): ClosureResult {
  const chords = chordsOf(kit);
  const length = Number(kit.straightStuds);
  const residual = Float64Array.from(subtractZeta16(goal.position, start.position), (c) =>
    Number(c),
  );
  const chain = chords ? chainOf(chords, residual, length) : undefined;
  if (!chain) return { kind: "limit" };
  const h0 = start.heading;
  const h1 = normalizeHeading16(goal.heading + HALF_TURN_16);
  const parity = crossingParity(h0, h1);
  for (let k = 0; k < BASIS; k++) {
    let value = residual[k] ?? 0;
    for (let j = 0; j < BASIS; j++) value -= (parity[j] ?? 0) * (chain.chords[j]?.[k] ?? 0);
    if (mod(value, length) !== 0) return { kind: "impossible" };
  }
  const problem = new ClosureChain(chain, parity, h0, h1);
  const incumbent: Incumbent = { pieces: Number.POSITIVE_INFINITY, curves: undefined };
  for (const box of BOX_SIZES) {
    searchBox(problem, box, incumbent, deadline, length);
    if (deadline.expired || incumbent.pieces <= box) break;
  }
  const curves = incumbent.curves;
  if (!curves) return { kind: "limit" };
  const moves = trailMoves(kit, problem.crossings(curves), h0, h1);
  if (!posesJoin16(layMoves(start, moves).end, goal)) {
    throw new Error("the complete closure laid a run that does not join its goal");
  }
  return { kind: "exact", run: segmentsOf(kit, moves) };
}

export function solveClosure(
  kit: DrawingKit,
  start: Pose16,
  goal: Pose16,
  budget: SearchBudget = UNLIMITED_BUDGET,
): ClosureResult {
  const deadline = new Deadline(budget);
  const simple = closureWithinTurns(kit, start, goal);
  const complete = completeClosure(kit, start, goal, deadline);
  if (!simple) return complete;
  if (complete.kind === "exact" && complete.run.pieces < simple.pieces) return complete;
  return { kind: "exact", run: simple };
}

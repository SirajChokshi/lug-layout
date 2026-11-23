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
import { clearClosure, type ClosureSite } from "./clear-closure.ts";
import { Deadline, UNLIMITED_BUDGET, type SearchBudget } from "./search-deadline.ts";
import {
  closuresWithinTurns,
  fewestWithinTurns,
  runOfMoves,
  type TrackRun,
} from "./track-solver.ts";

export { UNLIMITED_BUDGET, type SearchBudget } from "./search-deadline.ts";

export type ClosureResult =
  | { readonly kind: "exact"; readonly run: TrackRun }
  | { readonly kind: "impossible" }
  | { readonly kind: "blocked"; readonly blocker: number }
  | { readonly kind: "limit" };

const BASIS = ZETA16_COEFFICIENT_COUNT;
const EDGES = ZETA16_ORDER;
const BOX_SIZES: ReadonlyArray<number> = [8, 16, 32, 64, 128, 256];
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
const ARC_COUNT = ARCS.length;
const ARC_EDGE_MASKS = new Uint16Array(ARC_COUNT);
const ARC_VERTEX_MASKS = new Uint16Array(ARC_COUNT);
const ARC_PAIR_FILL_MASKS = new Uint8Array(ARC_COUNT);
const PAIR_FILL_BITS = (1 << BASIS) - 1;
const NO_FILL = -1;
const NO_PATTERN = -1;

ARCS.forEach((arc, a) => {
  let edgeMask = 0;
  let vertexMask = 0;
  for (let h = 0; h < EDGES; h++) {
    if (arc.edges[h]) edgeMask |= 1 << h;
    if (arc.vertices[h]) vertexMask |= 1 << h;
  }
  let pairFillMask = 0;
  for (let j = 0; j < BASIS; j++) {
    if (arc.edges[j] && arc.edges[j + BASIS]) pairFillMask |= 1 << j;
  }
  ARC_EDGE_MASKS[a] = edgeMask;
  ARC_VERTEX_MASKS[a] = vertexMask;
  ARC_PAIR_FILL_MASKS[a] = pairFillMask;
});

const MAX_DOMAIN = (BOX_SIZES.at(-1) ?? 0) + 1;
const crossingStraights = new Int32Array(EDGES);
const crossingEdges = new Int32Array(EDGES);
const toGoRows: ReadonlyArray<Float64Array> = Array.from(
  { length: BASIS },
  () => new Float64Array(MAX_DOMAIN),
);
const orderIndices: ReadonlyArray<Int32Array> = Array.from(
  { length: BASIS },
  () => new Int32Array(MAX_DOMAIN),
);
const orderBounds: ReadonlyArray<Float64Array> = Array.from(
  { length: BASIS },
  () => new Float64Array(MAX_DOMAIN),
);
const chosenCurves = new Int32Array(BASIS);

function bitCount(bits: number): number {
  let count = 0;
  for (let rest = bits; rest !== 0; rest &= rest - 1) count++;
  return count;
}

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
  private bestPattern = NO_PATTERN;
  private bestFill = 0;

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

  crossingPieces(curves: Int32Array): number {
    crossingStraights.fill(0);
    let requiredVertices = (1 << this.h0) | (1 << this.h1);
    let straightCount = 0;
    for (let k = 0; k < BASIS; k++) {
      const n = this.row(k, curves) / this.chain.length;
      if (n > 0) {
        crossingStraights[k] = n;
        requiredVertices |= 1 << k;
      } else if (n < 0) {
        crossingStraights[k + BASIS] = -n;
        requiredVertices |= 1 << (k + BASIS);
      }
      straightCount += Math.abs(n);
    }
    let bestCurves = Number.POSITIVE_INFINITY;
    this.bestPattern = NO_PATTERN;
    this.bestFill = 0;
    for (let p = 0; p < this.patterns.length; p++) {
      const occupiedEdges = this.patternEdges(curves, p);
      const fill = this.connect(occupiedEdges, requiredVertices);
      if (fill === NO_FILL) continue;
      let total = PAIR_FILL_PIECES * bitCount(fill);
      for (let e = 0; e < EDGES; e++) total += crossingEdges[e] ?? 0;
      if (total < bestCurves) {
        bestCurves = total;
        this.bestPattern = p;
        this.bestFill = fill;
      }
    }
    if (this.bestPattern === NO_PATTERN)
      throw new Error("no Euler trail fits these crossings, which the parity rule excludes");
    return bestCurves + straightCount;
  }

  crossings(curves: Int32Array): Crossings {
    const pieces = this.crossingPieces(curves);
    this.patternEdges(curves, this.bestPattern);
    const edges = Int32Array.from(crossingEdges);
    for (let j = 0; j < BASIS; j++) {
      if ((this.bestFill & (1 << j)) === 0) continue;
      edges[j] = (edges[j] ?? 0) + PAIR_FILL_PIECES / 2;
      edges[j + BASIS] = (edges[j + BASIS] ?? 0) + PAIR_FILL_PIECES / 2;
    }
    return { pieces, edges, straights: Int32Array.from(crossingStraights) };
  }

  private patternEdges(curves: Int32Array, patternIndex: number): number {
    const pattern = this.patterns[patternIndex];
    crossingEdges.fill(0);
    let occupiedEdges = 0;
    for (let j = 0; j < BASIS; j++) {
      const m = curves[j] ?? 0;
      let forward = Math.max(m, 0);
      let backward = Math.max(-m, 0);
      if (mod(forward, 2) !== (pattern?.[j] ?? 0)) {
        forward += 1;
        backward += 1;
      }
      crossingEdges[j] = forward;
      crossingEdges[j + BASIS] = backward;
      if (forward > 0) occupiedEdges |= 1 << j;
      if (backward > 0) occupiedEdges |= 1 << (j + BASIS);
    }
    return occupiedEdges;
  }

  private connect(occupiedEdges: number, requiredVertices: number): number {
    if (occupiedEdges === 0 && this.h0 === this.h1 && (requiredVertices & ~(1 << this.h0)) === 0) {
      return 0;
    }
    let best = NO_FILL;
    let bestFills = Number.POSITIVE_INFINITY;
    for (let a = 0; a < ARC_COUNT; a++) {
      const edgeMask = ARC_EDGE_MASKS[a] ?? 0;
      if ((occupiedEdges & ~edgeMask) !== 0) continue;
      if ((requiredVertices & ~(ARC_VERTEX_MASKS[a] ?? 0)) !== 0) continue;
      const missing = edgeMask & ~occupiedEdges;
      const fill = (missing | (missing >>> BASIS)) & PAIR_FILL_BITS;
      if ((fill & ~(ARC_PAIR_FILL_MASKS[a] ?? 0)) !== 0) continue;
      const fills = bitCount(fill);
      if (fills < bestFills) {
        bestFills = fills;
        best = fill;
      }
    }
    return best;
  }
}

interface Incumbent {
  pieces: number;
  curves: Int32Array | undefined;
}

const LAST_CURVE = BASIS - 1;
const NO_DOMAIN = new Int32Array(0);
const NO_ROW = new Float64Array(0);

function descend(
  problem: ClosureChain,
  domains: ReadonlyArray<Int32Array>,
  incumbent: Incumbent,
  deadline: Deadline,
  scale: number,
  j: number,
  accumulated: number,
): void {
  if (deadline.expired) return;
  const previous = chosenCurves[j - 1] ?? 0;
  const domain = domains[j] ?? NO_DOMAIN;
  const here = toGoRows[j] ?? NO_ROW;
  const indices = orderIndices[j] ?? NO_DOMAIN;
  const bounds = orderBounds[j] ?? NO_ROW;
  const base = accumulated + problem.unary(j - 1, previous);
  let ordered = 0;
  for (let i = 0; i < domain.length; i++) {
    const bound = base + problem.pair(j - 1, previous, domain[i] ?? 0) + (here[i] ?? 0);
    if (bound / scale < incumbent.pieces) {
      let at = ordered;
      while (at > 0 && (bounds[at - 1] ?? 0) > bound) {
        bounds[at] = bounds[at - 1] ?? 0;
        indices[at] = indices[at - 1] ?? 0;
        at--;
      }
      bounds[at] = bound;
      indices[at] = i;
      ordered++;
    }
  }
  for (let o = 0; o < ordered; o++) {
    if (deadline.tick()) return;
    const i = indices[o] ?? 0;
    const x = domain[i] ?? 0;
    chosenCurves[j] = x;
    const next = base + problem.pair(j - 1, previous, x);
    if (j === LAST_CURVE) {
      const lowerBound = (next + (here[i] ?? 0)) / scale;
      if (lowerBound >= incumbent.pieces) continue;
      const pieces = problem.crossingPieces(chosenCurves);
      if (pieces < incumbent.pieces) {
        incumbent.pieces = pieces;
        incumbent.curves = Int32Array.from(chosenCurves);
      }
    } else {
      descend(problem, domains, incumbent, deadline, scale, j + 1, next);
    }
  }
}

function searchBox(
  problem: ClosureChain,
  box: number,
  incumbent: Incumbent,
  deadline: Deadline,
  scale: number,
): void {
  const domains = Array.from({ length: BASIS }, (_v, j) => problem.domain(j, box));
  const firstDomain = domains[0] ?? NO_DOMAIN;
  const lastDomain = domains[LAST_CURVE] ?? NO_DOMAIN;
  const lastToGo = toGoRows[LAST_CURVE] ?? NO_ROW;
  chosenCurves.fill(0);
  for (let first = 0; first < firstDomain.length; first++) {
    if (deadline.check()) return;
    const v0 = firstDomain[first] ?? 0;
    for (let i = 0; i < lastDomain.length; i++) {
      const x = lastDomain[i] ?? 0;
      lastToGo[i] = problem.unary(LAST_CURVE, x) + problem.pair(LAST_CURVE, x, v0);
    }
    for (let j = LAST_CURVE - 1; j >= 1; j--) {
      const domain = domains[j] ?? NO_DOMAIN;
      const nextDomain = domains[j + 1] ?? NO_DOMAIN;
      const nextToGo = toGoRows[j + 1] ?? NO_ROW;
      const here = toGoRows[j] ?? NO_ROW;
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
    chosenCurves[0] = v0;
    descend(problem, domains, incumbent, deadline, scale, 1, problem.constant);
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
  return { kind: "exact", run: runOfMoves(kit, moves) };
}

interface Algebraic {
  readonly result: ClosureResult;
  readonly fewestPieces: number;
  readonly withinTurns: ReadonlyArray<TrackRun>;
}

function algebraicClosure(
  kit: DrawingKit,
  start: Pose16,
  goal: Pose16,
  budget: SearchBudget,
): Algebraic {
  const withinTurns = closuresWithinTurns(kit, start, goal);
  const simple = fewestWithinTurns(withinTurns);
  const complete = completeClosure(kit, start, goal, new Deadline(budget));
  const fewestPieces =
    complete.kind === "exact" ? Math.min(complete.run.pieces, simple?.pieces ?? Infinity) : 0;
  if (!simple) return { result: complete, fewestPieces, withinTurns };
  if (complete.kind === "exact" && complete.run.pieces < simple.pieces) {
    return { result: complete, fewestPieces, withinTurns };
  }
  return { result: { kind: "exact", run: simple }, fewestPieces, withinTurns };
}

export function solveClosure(
  kit: DrawingKit,
  start: Pose16,
  goal: Pose16,
  budget: SearchBudget = UNLIMITED_BUDGET,
  site?: ClosureSite,
): ClosureResult {
  const { result, fewestPieces, withinTurns } = algebraicClosure(kit, start, goal, budget);
  if (!site || result.kind === "impossible") return result;
  return clearClosure(kit, start, goal, site, {
    run: result.kind === "exact" ? result.run : null,
    fewestPieces,
    withinTurns,
  });
}

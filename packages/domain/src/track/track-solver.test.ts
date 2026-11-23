import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  HALF_TURN_16,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  ZETA16_ZERO,
  addZeta16,
  conjugateZeta16,
  normalizeHeading16,
  pose16,
  posesJoin16,
  POSE16_IDENTITY,
  pose16Equals,
  rotateZeta16,
  subtractZeta16,
  zeta16,
  zeta16Equals,
  type Pose16,
  type Zeta16,
} from "@brr/math";
import { describe, expect, it } from "vitest";
import { drawingKit, MAX_TURN_CURVES, type DrawingKit, type TurnSign } from "./drawing-kit.ts";
import {
  advance,
  connectorPose,
  layMoves,
  type TrackMove,
  type TrackPieceDef,
} from "./track-pose.ts";
import {
  solveClosure,
  UNLIMITED_BUDGET,
  type ClosureResult,
  type SearchBudget,
} from "./closure.ts";
import { Deadline } from "./search-deadline.ts";
import {
  closuresWithinTurns,
  fewestWithinTurns,
  runMoves,
  runOfMoves,
  type TrackRun,
} from "./track-solver.ts";

interface GeometryEnd {
  readonly fieldCertified: boolean;
  readonly coefficients: ReadonlyArray<string> | null;
  readonly headingSteps: number;
}

interface GeometryTrack {
  readonly part: string;
  readonly relative: ReadonlyArray<GeometryEnd>;
}

const GEOMETRY = new URL("../../../../docs/verified-facts/geometry.json", import.meta.url);
const NINE_VOLT_STRAIGHT_AND_CURVE = ["74746", "74747"];

function yUpPiece(track: GeometryTrack): TrackPieceDef {
  return {
    id: `ldraw:${track.part}`,
    connectors: track.relative.map((end) => {
      if (!end.fieldCertified || !end.coefficients) {
        throw new Error(`${track.part} end is not certified`);
      }
      const ldrawFrame = zeta16(end.coefficients.map((c) => BigInt(c)));
      return pose16(conjugateZeta16(ldrawFrame), -end.headingSteps);
    }),
  };
}

function nineVoltKit(): DrawingKit {
  const geometry = JSON.parse(readFileSync(GEOMETRY, "utf8")) as {
    readonly trackEnds: ReadonlyArray<GeometryTrack>;
  };
  const pieces = geometry.trackEnds
    .filter((t) => NINE_VOLT_STRAIGHT_AND_CURVE.includes(t.part))
    .map(yUpPiece);
  const result = drawingKit(pieces);
  if (result.kind !== "kit") throw new Error(result.reason);
  return result.kit;
}

const kit = nineVoltKit();
const PROPERTY_TIMEOUT_MS = 30_000;

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function randomRun(random: () => number): TrackRun {
  const segments: TrackRun["segments"][number][] = [];
  let pieces = 0;
  const turns = Math.floor(random() * 4);
  for (let t = 0; t <= turns; t++) {
    const count = Math.floor(random() * 6);
    if (count > 0) segments.push({ kind: "straight", count });
    pieces += count;
    if (t < turns) {
      const curves = 1 + Math.floor(random() * 8);
      segments.push({ kind: "turn", sign: random() < 0.5 ? 1 : -1, curves });
      pieces += curves;
    }
  }
  return { segments, pieces };
}

function endOf(start: Pose16, run: TrackRun): Pose16 {
  return layMoves(start, runMoves(kit, run)).end;
}

function openEndFacing(end: Pose16): Pose16 {
  return pose16(end.position, end.heading + 8);
}

describe("exact track composition", () => {
  it("returns to the identity pose after sixteen R40 curves either way", () => {
    for (const curve of [kit.left, kit.right]) {
      let pose = POSE16_IDENTITY;
      for (let i = 0; i < 16; i++) pose = advance(pose, curve);
      expect(pose16Equals(pose, POSE16_IDENTITY)).toBe(true);
    }
  });

  it("joins every laid piece to the next one exactly", () => {
    const random = seeded(7);
    const start = pose16(zeta16([3n, -5n, 0n, 2n, 0n, 0n, 1n, 0n]), 5);
    for (let trial = 0; trial < 50; trial++) {
      const moves = runMoves(kit, randomRun(random));
      const { placed } = layMoves(start, moves);
      let open = start;
      placed.forEach((piece, i) => {
        const move = moves[i];
        if (!move) throw new Error("placed more pieces than moves");
        expect(posesJoin16(connectorPose(piece, move.from), open)).toBe(true);
        open = connectorPose(piece, move.to);
      });
    }
  });
});

function closedBy(start: Pose16, goal: Pose16, result: ClosureResult): boolean {
  return result.kind === "exact" && posesJoin16(endOf(start, result.run), goal);
}

function turnsRun(random: () => number, turns: number): TrackRun {
  const segments: TrackRun["segments"][number][] = [];
  let pieces = 0;
  for (let s = 0; s < turns; s++) {
    const count = Math.floor(random() * 4);
    if (count) segments.push({ kind: "straight", count });
    pieces += count;
    const curves = 1 + Math.floor(random() * 6);
    segments.push({ kind: "turn", sign: random() < 0.5 ? 1 : -1, curves });
    pieces += curves;
  }
  return { segments, pieces };
}

const CLOSURE_BUDGET_MS = 30;

function expiredBudget(): SearchBudget {
  let tick = 0;
  return { now: () => (tick += 1000), limitMs: 1 };
}

describe("solveClosure", () => {
  it(
    "closes any gap a run of up to three turns spans, with no more pieces than that run",
    () => {
      const random = seeded(42);
      for (let trial = 0; trial < 60; trial++) {
        const start = pose16(zeta16([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), Math.floor(random() * 16));
        const reference = randomRun(random);
        const goal = openEndFacing(endOf(start, reference));
        const result = solveClosure(kit, start, goal);
        expect(closedBy(start, goal, result)).toBe(true);
        expect(result.kind === "exact" ? result.run.pieces : Infinity).toBeLessThanOrEqual(
          reference.pieces,
        );
      }
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    "closes every goal a four-turn run reaches, never with more pieces than that run",
    () => {
      const random = seeded(99);
      for (let trial = 0; trial < 400; trial++) {
        const reference = turnsRun(random, 4);
        const goal = openEndFacing(endOf(POSE16_IDENTITY, reference));
        const result = solveClosure(kit, POSE16_IDENTITY, goal);
        expect(closedBy(POSE16_IDENTITY, goal, result)).toBe(true);
        expect(result.kind === "exact" ? result.run.pieces : Infinity).toBeLessThanOrEqual(
          reference.pieces,
        );
      }
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    "closes goals reached by runs of up to eight turns from any heading",
    () => {
      const random = seeded(5);
      for (let trial = 0; trial < 120; trial++) {
        const start = pose16(zeta16([2n, 0n, -1n, 0n, 3n, 0n, 0n, 1n]), Math.floor(random() * 16));
        const goal = openEndFacing(endOf(start, turnsRun(random, 1 + Math.floor(random() * 8))));
        expect(closedBy(start, goal, solveClosure(kit, start, goal))).toBe(true);
      }
    },
    PROPERTY_TIMEOUT_MS,
  );

  it(
    "closes every pose up to six pieces away and calls none of them impossible",
    () => {
      const moves = [kit.straight, kit.left, kit.right];
      const reached = new Map<string, Pose16>();
      let frontier: Pose16[] = [POSE16_IDENTITY];
      for (let depth = 0; depth < 6; depth++) {
        frontier = frontier
          .flatMap((pose) => moves.map((move) => advance(pose, move)))
          .filter((pose) => {
            const key = `${pose.position.join(",")}@${pose.heading}`;
            if (reached.has(key)) return false;
            reached.set(key, pose);
            return true;
          });
      }
      for (const end of reached.values()) {
        const goal = openEndFacing(end);
        expect(closedBy(POSE16_IDENTITY, goal, solveClosure(kit, POSE16_IDENTITY, goal))).toBe(
          true,
        );
      }
    },
    PROPERTY_TIMEOUT_MS,
  );

  it("closes a full oval from one open end back to the other with eight curves", () => {
    const start = POSE16_IDENTITY;
    const oval: TrackRun = {
      segments: [
        { kind: "straight", count: 4 },
        { kind: "turn", sign: 1, curves: 8 },
        { kind: "straight", count: 4 },
      ],
      pieces: 16,
    };
    const end = endOf(start, oval);
    const back = pose16(start.position, start.heading + 8);
    const result = solveClosure(kit, end, back);
    expect(result.kind === "exact" ? result.run.pieces : 0).toBe(8);
    expect(closedBy(end, back, result)).toBe(true);
  });

  it("proves a gap one stud off any reachable pose impossible, even with no time left", () => {
    const random = seeded(3);
    for (let trial = 0; trial < 30; trial++) {
      const goal = openEndFacing(endOf(POSE16_IDENTITY, randomRun(random)));
      const coefficient = Math.floor(random() * 8);
      const shifted = goal.position.map((c, k) => (k === coefficient ? c + 1n : c));
      const offGoal = pose16(zeta16(shifted), goal.heading);
      expect(solveClosure(kit, POSE16_IDENTITY, offGoal).kind).toBe("impossible");
      expect(solveClosure(kit, POSE16_IDENTITY, offGoal, expiredBudget()).kind).toBe("impossible");
    }
  });

  it("reports the search limit, not impossibility, when time runs out before a join is found", () => {
    const random = seeded(99);
    let limited = 0;
    for (let trial = 0; trial < 40; trial++) {
      const goal = openEndFacing(endOf(POSE16_IDENTITY, turnsRun(random, 4)));
      const result = solveClosure(kit, POSE16_IDENTITY, goal, expiredBudget());
      expect(result.kind).not.toBe("impossible");
      if (result.kind === "limit") limited++;
    }
    expect(limited).toBeGreaterThan(0);
  });

  it("gives the unlimited closure even when building the kit's turn table takes longer than the whole 30 ms budget on the solve's own clock", () => {
    const goal = pose16(zeta16([112n, 16n, 0n, 0n, 72n, 0n, 0n, -56n]), 3);
    const clock = { ms: 0 };
    const slowKit: DrawingKit = {
      ...kit,
      arc: (sign, curves, heading) => {
        clock.ms += 1;
        return kit.arc(sign, curves, heading);
      },
    };
    const unlimited = solveClosure(kit, POSE16_IDENTITY, goal);
    const budgeted = solveClosure(slowKit, POSE16_IDENTITY, goal, {
      now: () => clock.ms,
      limitMs: CLOSURE_BUDGET_MS,
    });
    expect(clock.ms).toBeGreaterThan(CLOSURE_BUDGET_MS);
    expect(budgeted).toEqual(unlimited);
    expect(solveClosure(kit, POSE16_IDENTITY, goal, { now: () => 0, limitMs: -1 })).not.toEqual(
      unlimited,
    );
  });
});

const REFERENCE_TURNS = 3;
const DIFFERENTIAL_TRIALS = 160;
const SHORT_STRAIGHT_TRIALS = 32;
const DIFFERENTIAL_TIMEOUT_MS = 120_000;
const RECORDED_CAP = 23;
const RECORDED_RUNS = 15;

function referenceTurnSign(turn: number): TurnSign {
  return turn > 0 ? 1 : -1;
}

function referenceClosureRun(
  closureKit: DrawingKit,
  start: Pose16,
  goal: Pose16,
  turns: ReadonlyArray<number>,
): TrackRun | undefined {
  let residual: Zeta16 = subtractZeta16(goal.position, start.position);
  const headings: number[] = [start.heading];
  let heading = start.heading;
  for (const m of turns) {
    residual = subtractZeta16(residual, closureKit.arc(referenceTurnSign(m), Math.abs(m), heading));
    heading = normalizeHeading16(heading + m);
    headings.push(heading);
  }
  const counts = Array.from({ length: headings.length }, () => 0);
  for (let i = 0; i < ZETA16_COEFFICIENT_COUNT; i++) {
    const value = residual[i] ?? 0n;
    if (value === 0n) continue;
    if (value % closureKit.straightStuds !== 0n) return undefined;
    const quotient = value / closureKit.straightStuds;
    const wanted = quotient > 0n ? 0 : 1;
    const run = headings.findIndex(
      (h) =>
        h % ZETA16_COEFFICIENT_COUNT === i && Math.floor(h / ZETA16_COEFFICIENT_COUNT) === wanted,
    );
    if (run < 0) return undefined;
    counts[run] = Number(quotient > 0n ? quotient : -quotient);
  }
  const segments: TrackRun["segments"][number][] = [];
  let pieces = 0;
  counts.forEach((count, r) => {
    if (count > 0) segments.push({ kind: "straight", count });
    pieces += count;
    const m = turns[r];
    if (m !== undefined) {
      segments.push({ kind: "turn", sign: referenceTurnSign(m), curves: Math.abs(m) });
      pieces += Math.abs(m);
    }
  });
  return { segments, pieces };
}

function referenceClosures(
  closureKit: DrawingKit,
  start: Pose16,
  goal: Pose16,
  maxPieces = Number.POSITIVE_INFINITY,
): ReadonlyArray<TrackRun> {
  const needed = normalizeHeading16(goal.heading + HALF_TURN_16 - start.heading);
  const signed: number[] = [];
  for (let m = 1; m <= Math.min(MAX_TURN_CURVES, maxPieces); m++) signed.push(m, -m);
  const runs: TrackRun[] = [];
  const walk = (prefix: number[], sum: number, curves: number): void => {
    if (normalizeHeading16(sum) === needed) {
      const run = referenceClosureRun(closureKit, start, goal, prefix);
      if (run && run.pieces <= maxPieces) runs.push(run);
    }
    if (prefix.length === REFERENCE_TURNS) return;
    for (const m of signed) {
      const used = curves + Math.abs(m);
      if (used > maxPieces) continue;
      prefix.push(m);
      walk(prefix, sum + m, used);
      prefix.pop();
    }
  };
  walk([], 0, 0);
  return runs;
}

function curvesOf(run: TrackRun): number {
  return run.segments.reduce((sum, s) => sum + (s.kind === "turn" ? s.curves : 0), 0);
}

function oneStraightShorter(run: TrackRun): TrackRun | null {
  const last = run.segments.findLastIndex((s) => s.kind === "straight");
  const segment = run.segments[last];
  if (segment?.kind !== "straight") return null;
  const segments = run.segments.map((s, i) =>
    i === last ? { kind: "straight" as const, count: segment.count - 1 } : s,
  );
  return { segments, pieces: run.pieces - 1 };
}

function oneStudOff(goal: Pose16, coefficient: number): Pose16 {
  return pose16(
    zeta16(goal.position.map((c, k) => (k === coefficient ? c + 1n : c))),
    goal.heading,
  );
}

function generatedCases(closureKit: DrawingKit, seed: number, trials: number) {
  const random = seeded(seed);
  const cases: Array<{ start: Pose16; goal: Pose16; cap: number }> = [];
  for (let trial = 0; trial < trials; trial++) {
    const walked = layMoves(POSE16_IDENTITY, runMoves(closureKit, randomRun(random))).end;
    const start = pose16(walked.position, trial % ZETA16_ORDER);
    const laid = randomRun(random);
    const lay = (run: TrackRun) => openEndFacing(layMoves(start, runMoves(closureKit, run)).end);
    const shorter = oneStraightShorter(laid);
    const goals = [
      lay(laid),
      ...(shorter ? [lay(shorter)] : []),
      oneStudOff(lay(laid), Math.floor(random() * ZETA16_COEFFICIENT_COUNT)),
    ];
    const curves = curvesOf(laid);
    const caps = [0, laid.pieces, laid.pieces - 1, Number.POSITIVE_INFINITY];
    if (curves < laid.pieces) caps.push(curves);
    for (const goal of goals) for (const cap of caps) cases.push({ start, goal, cap });
  }
  return cases;
}

function goalAhead(coefficient: bigint): Pose16 {
  return pose16(zeta16([coefficient, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), HALF_TURN_16);
}

function arcSumOf(turns: ReadonlyArray<number>): Zeta16 {
  let sum: Zeta16 = ZETA16_ZERO;
  let heading = 0;
  for (const m of turns) {
    sum = addZeta16(sum, kit.arc(referenceTurnSign(m), Math.abs(m), heading));
    heading = normalizeHeading16(heading + m);
  }
  return sum;
}

describe("closuresWithinTurns", () => {
  it(
    "lists the same closing runs, in the same order, as the turn-by-turn search for generated starts on every heading, goals that close, fall a straight short or sit a stud off, and every cap",
    () => {
      const cases = generatedCases(kit, 0xc105, DIFFERENTIAL_TRIALS);
      const needed = new Set(
        cases.map((c) => normalizeHeading16(c.goal.heading + 8 - c.start.heading)),
      );
      let multiRun = 0;
      for (const { start, goal, cap } of cases) {
        const expected = referenceClosures(kit, start, goal, cap);
        if (expected.length > 1) multiRun++;
        expect(closuresWithinTurns(kit, start, goal, cap)).toEqual(expected);
      }
      expect(needed.size).toBe(ZETA16_ORDER);
      expect(multiRun).toBeGreaterThan(0);
    },
    DIFFERENTIAL_TIMEOUT_MS,
  );

  it("lists all fifteen runs of a recorded drag-join backoff point at its cap above twenty, in the search's order", () => {
    const start = pose16(ZETA16_ZERO, 3);
    const goal = pose16(zeta16([96n, 0n, 0n, 0n, 24n, 0n, 0n, 40n]), 8);
    const expected = referenceClosures(kit, start, goal, RECORDED_CAP);

    expect(expected).toHaveLength(RECORDED_RUNS);
    expect(closuresWithinTurns(kit, start, goal, RECORDED_CAP)).toEqual(expected);
  });

  it("puts a revisited heading's straights on its first run, as the search does", () => {
    const start = pose16(zeta16([5n, 0n, -3n, 0n, 0n, 2n, 0n, 0n]), 6);
    for (const curves of [1, 2]) {
      const laid: TrackRun = {
        segments: [
          { kind: "straight", count: 2 },
          { kind: "turn", sign: 1, curves },
          { kind: "straight", count: 1 },
          { kind: "turn", sign: -1, curves },
          { kind: "straight", count: 3 },
        ],
        pieces: 6 + 2 * curves,
      };
      const goal = openEndFacing(endOf(start, laid));
      const expected = referenceClosures(kit, start, goal);

      expect(expected).toContainEqual({
        segments: [
          { kind: "straight", count: 5 },
          { kind: "turn", sign: 1, curves },
          { kind: "straight", count: 1 },
          { kind: "turn", sign: -1, curves },
        ],
        pieces: 6 + 2 * curves,
      });
      expect(closuresWithinTurns(kit, start, goal)).toEqual(expected);
    }
  });

  it("drops a run whose straights take it past the cap even when its curves fit", () => {
    const laid: TrackRun = {
      segments: [
        { kind: "straight", count: 2 },
        { kind: "turn", sign: 1, curves: 3 },
        { kind: "straight", count: 1 },
      ],
      pieces: 6,
    };
    const goal = openEndFacing(endOf(POSE16_IDENTITY, laid));
    const between = curvesOf(laid) + 1;

    expect(curvesOf(laid)).toBeLessThan(laid.pieces);
    expect(between).toBeLessThan(laid.pieces);
    for (const cap of [between, laid.pieces]) {
      expect(closuresWithinTurns(kit, POSE16_IDENTITY, goal, cap)).toEqual(
        referenceClosures(kit, POSE16_IDENTITY, goal, cap),
      );
    }
  });

  it("keeps a run whose straight count needs a coefficient of 2^52, and invents none where a double would round", () => {
    const exact = goalAhead(2n ** 52n);
    const odd = goalAhead(2n ** 53n + 1n);
    const revisit = [-8, 8, -8];
    const arcs = arcSumOf(revisit);
    const coefficient = arcs.findIndex((c) => c === -240n);
    const nearMaxSafe = pose16(
      zeta16(arcs.map((c, k) => (k === coefficient ? 2n ** 53n - 15n : c))),
      0,
    );
    const straightOnly = Number(2n ** 52n / kit.straightStuds);

    expect(closuresWithinTurns(kit, POSE16_IDENTITY, exact)).toEqual(
      referenceClosures(kit, POSE16_IDENTITY, exact),
    );
    expect(closuresWithinTurns(kit, POSE16_IDENTITY, exact)).toContainEqual({
      segments: [{ kind: "straight", count: straightOnly }],
      pieces: straightOnly,
    });
    expect(referenceClosures(kit, POSE16_IDENTITY, odd)).toEqual([]);
    expect(closuresWithinTurns(kit, POSE16_IDENTITY, odd)).toEqual([]);
    expect(coefficient).toBeGreaterThanOrEqual(0);
    expect(closuresWithinTurns(kit, POSE16_IDENTITY, nearMaxSafe)).toEqual(
      referenceClosures(kit, POSE16_IDENTITY, nearMaxSafe),
    );
  });

  it(
    "lists the same runs as the turn-by-turn search on a kit whose straight is shorter than four studs",
    () => {
      const shortKit: DrawingKit = { ...kit, straightStuds: 2n };
      for (const { start, goal, cap } of generatedCases(shortKit, 0x5702, SHORT_STRAIGHT_TRIALS)) {
        expect(closuresWithinTurns(shortKit, start, goal, cap)).toEqual(
          referenceClosures(shortKit, start, goal, cap),
        );
      }
    },
    DIFFERENTIAL_TIMEOUT_MS,
  );
});

const REFERENCE_BASIS = ZETA16_COEFFICIENT_COUNT;
const REFERENCE_EDGES = ZETA16_ORDER;
const REFERENCE_BOX_SIZES: ReadonlyArray<number> = [8, 16, 32, 64, 128, 256];
const REFERENCE_PAIR_FILL_PIECES = 4;

interface ReferenceArc {
  readonly edges: Uint8Array;
  readonly vertices: Uint8Array;
}

function referenceArcs(): ReadonlyArray<ReferenceArc> {
  const list: ReferenceArc[] = [];
  const add = (start: number, length: number): void => {
    const edges = new Uint8Array(REFERENCE_EDGES);
    const vertices = new Uint8Array(REFERENCE_EDGES);
    for (let i = 0; i < length; i++) {
      edges[(start + i) % REFERENCE_EDGES] = 1;
      vertices[(start + i) % REFERENCE_EDGES] = 1;
      vertices[(start + i + 1) % REFERENCE_EDGES] = 1;
    }
    list.push({ edges, vertices });
  };
  for (let start = 0; start < REFERENCE_EDGES; start++) {
    for (let length = 1; length < REFERENCE_EDGES; length++) add(start, length);
  }
  add(0, REFERENCE_EDGES);
  return list;
}

const REFERENCE_ARCS = referenceArcs();

interface ReferenceChain {
  readonly length: number;
  readonly residual: Float64Array;
  readonly chords: ReadonlyArray<Float64Array>;
  readonly unaryRows: ReadonlyArray<ReadonlyArray<number>>;
  readonly pairRows: ReadonlyArray<ReadonlyArray<number>>;
  readonly constant: number;
}

interface ReferenceCrossings {
  readonly pieces: number;
  readonly edges: Int32Array;
  readonly straights: Int32Array;
}

function referenceChordsOf(closureKit: DrawingKit): ReadonlyArray<Float64Array> | undefined {
  if (!zeta16Equals(rotateZeta16(closureKit.right.delta, 1), closureKit.left.delta))
    return undefined;
  return Array.from({ length: REFERENCE_BASIS }, (_v, j) =>
    Float64Array.from(rotateZeta16(closureKit.left.delta, j), (c) => Number(c)),
  );
}

function referenceChainOf(
  chords: ReadonlyArray<Float64Array>,
  residual: Float64Array,
  length: number,
): ReferenceChain | undefined {
  const unaryRows: number[][] = Array.from({ length: REFERENCE_BASIS }, () => []);
  const pairRows: number[][] = Array.from({ length: REFERENCE_BASIS }, () => []);
  let constant = 0;
  for (let k = 0; k < REFERENCE_BASIS; k++) {
    const support: number[] = [];
    for (let j = 0; j < REFERENCE_BASIS; j++) if ((chords[j]?.[k] ?? 0) !== 0) support.push(j);
    const [a, b] = support;
    if (a === undefined) constant += Math.abs(residual[k] ?? 0);
    else if (b === undefined) unaryRows[a]?.push(k);
    else if (support.length === 2 && b === a + 1) pairRows[a]?.push(k);
    else if (support.length === 2 && a === 0 && b === REFERENCE_BASIS - 1) pairRows[b]?.push(k);
    else return undefined;
  }
  for (const chord of chords) {
    for (const c of chord) if ((2 * c) % length !== 0) return undefined;
  }
  return { length, residual, chords, unaryRows, pairRows, constant };
}

function referenceCrossingParity(h0: number, h1: number): Int32Array {
  const parity = new Int32Array(REFERENCE_BASIS);
  if (h0 === h1) return parity;
  for (let j = 0; j < REFERENCE_BASIS; j++) {
    let count = 0;
    for (let v = j + 1; v <= j + REFERENCE_BASIS; v++) {
      const vertex = v % REFERENCE_EDGES;
      if (vertex === h0 || vertex === h1) count++;
    }
    parity[j] = count % 2;
  }
  return parity;
}

function referenceEdgeParityPatterns(h0: number, h1: number): ReadonlyArray<Int32Array> {
  return [0, 1].map((first) => {
    const pattern = new Int32Array(REFERENCE_EDGES);
    pattern[0] = first;
    for (let v = 1; v < REFERENCE_EDGES; v++) {
      const special = h0 !== h1 && (v === h0 || v === h1) ? 1 : 0;
      pattern[v] = (pattern[v - 1] ?? 0) ^ special;
    }
    return pattern;
  });
}

function referenceMod(value: number, m: number): number {
  return ((value % m) + m) % m;
}

class ReferenceClosureChain {
  private readonly patterns: ReadonlyArray<Int32Array>;

  constructor(
    private readonly chain: ReferenceChain,
    private readonly parity: Int32Array,
    private readonly h0: number,
    private readonly h1: number,
  ) {
    this.patterns = referenceEdgeParityPatterns(h0, h1);
  }

  private row(k: number, curves: Int32Array): number {
    let value = this.chain.residual[k] ?? 0;
    for (let j = 0; j < REFERENCE_BASIS; j++)
      value -= (curves[j] ?? 0) * (this.chain.chords[j]?.[k] ?? 0);
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
    const next = (j + 1) % REFERENCE_BASIS;
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

  crossings(curves: Int32Array): ReferenceCrossings {
    const straights = new Int32Array(REFERENCE_EDGES);
    const required = new Uint8Array(REFERENCE_EDGES);
    required[this.h0] = 1;
    required[this.h1] = 1;
    let straightCount = 0;
    for (let k = 0; k < REFERENCE_BASIS; k++) {
      const n = this.row(k, curves) / this.chain.length;
      if (n > 0) {
        straights[k] = n;
        required[k] = 1;
      } else if (n < 0) {
        straights[k + REFERENCE_BASIS] = -n;
        required[k + REFERENCE_BASIS] = 1;
      }
      straightCount += Math.abs(n);
    }
    let best: Int32Array | undefined;
    let bestCurves = Number.POSITIVE_INFINITY;
    for (const pattern of this.patterns) {
      const edges = new Int32Array(REFERENCE_EDGES);
      for (let j = 0; j < REFERENCE_BASIS; j++) {
        const m = curves[j] ?? 0;
        let forward = Math.max(m, 0);
        let backward = Math.max(-m, 0);
        if (referenceMod(forward, 2) !== (pattern[j] ?? 0)) {
          forward += 1;
          backward += 1;
        }
        edges[j] = forward;
        edges[j + REFERENCE_BASIS] = backward;
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
      for (let v = 0; v < REFERENCE_EDGES; v++) if (required[v] && v !== this.h0) onlyStart = false;
      if (onlyStart) return edges;
    }
    let best: Int32Array | undefined;
    let bestFill = Number.POSITIVE_INFINITY;
    for (const arc of REFERENCE_ARCS) {
      let valid = true;
      for (let h = 0; h < REFERENCE_EDGES && valid; h++) {
        if ((edges[h] ?? 0) > 0 && !arc.edges[h]) valid = false;
        if (required[h] && !arc.vertices[h]) valid = false;
      }
      if (!valid) continue;
      const fill = new Uint8Array(REFERENCE_BASIS);
      for (let h = 0; h < REFERENCE_EDGES && valid; h++) {
        if (!arc.edges[h] || (edges[h] ?? 0) > 0) continue;
        const pairIndex = h % REFERENCE_BASIS;
        if (!arc.edges[pairIndex] || !arc.edges[pairIndex + REFERENCE_BASIS]) valid = false;
        fill[pairIndex] = 1;
      }
      if (!valid) continue;
      let fills = 0;
      for (const f of fill) fills += f;
      if (fills < bestFill) {
        bestFill = fills;
        const filled = Int32Array.from(edges);
        for (let j = 0; j < REFERENCE_BASIS; j++) {
          if (!fill[j]) continue;
          filled[j] = (filled[j] ?? 0) + REFERENCE_PAIR_FILL_PIECES / 2;
          filled[j + REFERENCE_BASIS] =
            (filled[j + REFERENCE_BASIS] ?? 0) + REFERENCE_PAIR_FILL_PIECES / 2;
        }
        best = filled;
      }
    }
    return best;
  }
}

interface ReferenceCandidate {
  readonly i: number;
  readonly bound: number;
}

function referenceInsertByBound(order: ReferenceCandidate[], candidate: ReferenceCandidate): void {
  let at = order.length;
  while (at > 0 && (order[at - 1]?.bound ?? 0) > candidate.bound) at--;
  order.splice(at, 0, candidate);
}

interface ReferenceIncumbent {
  pieces: number;
  curves: Int32Array | undefined;
}

function referenceSearchBox(
  problem: ReferenceClosureChain,
  box: number,
  incumbent: ReferenceIncumbent,
  deadline: Deadline,
  scale: number,
): void {
  const domains = Array.from({ length: REFERENCE_BASIS }, (_v, j) => problem.domain(j, box));
  const last = REFERENCE_BASIS - 1;
  const chosen = new Int32Array(REFERENCE_BASIS);
  for (const v0 of domains[0] ?? []) {
    if (deadline.check()) return;
    const toGo: Float64Array[] = Array.from(
      { length: REFERENCE_BASIS },
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
      const order: ReferenceCandidate[] = [];
      for (let i = 0; i < domain.length; i++) {
        const bound = base + problem.pair(j - 1, previous, domain[i] ?? 0) + (here[i] ?? 0);
        if (bound / scale < incumbent.pieces) referenceInsertByBound(order, { i, bound });
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

function referenceTrailMoves(
  closureKit: DrawingKit,
  crossing: ReferenceCrossings,
  h0: number,
  h1: number,
): ReadonlyArray<TrackMove> {
  const remaining = Int32Array.from(crossing.edges);
  const stack = [h0];
  const trail: number[] = [];
  while (stack.length > 0) {
    const v = stack.at(-1) ?? h0;
    const back = (v + REFERENCE_EDGES - 1) % REFERENCE_EDGES;
    if ((remaining[v] ?? 0) > 0) {
      remaining[v] = (remaining[v] ?? 0) - 1;
      stack.push((v + 1) % REFERENCE_EDGES);
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
  const placed = new Uint8Array(REFERENCE_EDGES);
  trail.forEach((v, i) => {
    if (!placed[v]) {
      placed[v] = 1;
      for (let s = 0; s < (crossing.straights[v] ?? 0); s++) moves.push(closureKit.straight);
    }
    const next = trail[i + 1];
    if (next === undefined) return;
    moves.push(next === (v + 1) % REFERENCE_EDGES ? closureKit.left : closureKit.right);
  });
  return moves;
}

function referenceCompleteClosure(
  closureKit: DrawingKit,
  start: Pose16,
  goal: Pose16,
  deadline: Deadline,
  searched: { boxes: number },
): ClosureResult {
  const chords = referenceChordsOf(closureKit);
  const length = Number(closureKit.straightStuds);
  const residual = Float64Array.from(subtractZeta16(goal.position, start.position), (c) =>
    Number(c),
  );
  const chain = chords ? referenceChainOf(chords, residual, length) : undefined;
  if (!chain) return { kind: "limit" };
  const h0 = start.heading;
  const h1 = normalizeHeading16(goal.heading + HALF_TURN_16);
  const parity = referenceCrossingParity(h0, h1);
  for (let k = 0; k < REFERENCE_BASIS; k++) {
    let value = residual[k] ?? 0;
    for (let j = 0; j < REFERENCE_BASIS; j++)
      value -= (parity[j] ?? 0) * (chain.chords[j]?.[k] ?? 0);
    if (referenceMod(value, length) !== 0) return { kind: "impossible" };
  }
  const problem = new ReferenceClosureChain(chain, parity, h0, h1);
  const incumbent: ReferenceIncumbent = { pieces: Number.POSITIVE_INFINITY, curves: undefined };
  for (const box of REFERENCE_BOX_SIZES) {
    searched.boxes++;
    referenceSearchBox(problem, box, incumbent, deadline, length);
    if (deadline.expired || incumbent.pieces <= box) break;
  }
  const curves = incumbent.curves;
  if (!curves) return { kind: "limit" };
  const moves = referenceTrailMoves(closureKit, problem.crossings(curves), h0, h1);
  if (!posesJoin16(layMoves(start, moves).end, goal)) {
    throw new Error("the complete closure laid a run that does not join its goal");
  }
  return { kind: "exact", run: runOfMoves(closureKit, moves) };
}

const COMPLETE_TRIALS = 60;
const MAX_LAID_TURNS = 5;
const STEP_LIMITS: ReadonlyArray<number> = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
const STEPPED_CASES = 24;
const MANY_BOXES = 3;

interface ReferenceSolve {
  readonly result: ClosureResult;
  readonly fromComplete: boolean;
  readonly boxes: number;
}

function referenceSolve(start: Pose16, goal: Pose16, budget: SearchBudget): ReferenceSolve {
  const withinTurns = closuresWithinTurns(kit, start, goal);
  const simple = fewestWithinTurns(withinTurns);
  const searched = { boxes: 0 };
  const complete = referenceCompleteClosure(kit, start, goal, new Deadline(budget), searched);
  if (!simple) return { result: complete, fromComplete: true, boxes: searched.boxes };
  if (complete.kind === "exact" && complete.run.pieces < simple.pieces) {
    return { result: complete, fromComplete: true, boxes: searched.boxes };
  }
  return { result: { kind: "exact", run: simple }, fromComplete: false, boxes: searched.boxes };
}

function steppedBudget(limitMs: number): SearchBudget {
  let steps = 0;
  return { now: () => ++steps, limitMs };
}

const RECORDED_COMPLETE_CASES: ReadonlyArray<{ start: Pose16; goal: Pose16 }> = [
  {
    start: pose16(zeta16([-80n, 0n, 0n, 0n, 256n, 0n, 0n, 0n]), 0),
    goal: pose16(zeta16([16n, 0n, 0n, 0n, 320n, 0n, 0n, 0n]), 8),
  },
  {
    start: pose16(zeta16([80n, 0n, 0n, 0n, 320n, 0n, 0n, 0n]), 0),
    goal: pose16(zeta16([144n, 0n, 0n, 0n, 384n, 0n, 0n, 0n]), 8),
  },
  {
    start: pose16(zeta16([80n, 0n, 0n, 0n, 320n, 0n, 0n, 0n]), 0),
    goal: pose16(zeta16([128n, 0n, 0n, 0n, 368n, 0n, 0n, 0n]), 8),
  },
  { start: POSE16_IDENTITY, goal: pose16(zeta16([112n, 16n, 0n, 0n, 72n, 0n, 0n, -56n]), 3) },
  {
    start: pose16(ZETA16_ZERO, 2),
    goal: pose16(zeta16([0n, -64n, 16n, 16n, -24n, 0n, 40n, -80n]), 8),
  },
  {
    start: pose16(ZETA16_ZERO, 10),
    goal: pose16(zeta16([16n, -48n, 16n, -80n, 88n, 80n, -120n, 16n]), 0),
  },
];

function completeCases(seed: number, trials: number): Array<{ start: Pose16; goal: Pose16 }> {
  const random = seeded(seed);
  const cases: Array<{ start: Pose16; goal: Pose16 }> = [];
  for (let trial = 0; trial < trials; trial++) {
    const walked = layMoves(POSE16_IDENTITY, runMoves(kit, randomRun(random))).end;
    const start = pose16(walked.position, trial % ZETA16_ORDER);
    const laid = turnsRun(random, 1 + Math.floor(random() * MAX_LAID_TURNS));
    const goal = openEndFacing(endOf(start, laid));
    cases.push({ start, goal });
    cases.push({ start, goal: oneStudOff(goal, Math.floor(random() * ZETA16_COEFFICIENT_COUNT)) });
  }
  return [...cases, ...RECORDED_COMPLETE_CASES];
}

describe("completeClosure", () => {
  it(
    "closes every generated and recorded gap with exactly the run today's search finds, from complete-only joins to impossible ones and searches of three or more box sizes",
    () => {
      let completeOnly = 0;
      let impossible = 0;
      let manyBoxes = 0;
      for (const { start, goal } of completeCases(0xc0de, COMPLETE_TRIALS)) {
        const reference = referenceSolve(start, goal, UNLIMITED_BUDGET);
        expect(solveClosure(kit, start, goal)).toEqual(reference.result);
        if (reference.fromComplete && reference.result.kind === "exact") completeOnly++;
        if (reference.result.kind === "impossible") impossible++;
        if (reference.boxes >= MANY_BOXES) manyBoxes++;
      }
      expect(completeOnly).toBeGreaterThan(0);
      expect(impossible).toBeGreaterThan(0);
      expect(manyBoxes).toBeGreaterThan(0);
    },
    DIFFERENTIAL_TIMEOUT_MS,
  );

  it(
    "keeps today's result when a deadline counted in clock reads cuts the search, at every limit",
    () => {
      const cases = completeCases(0xc0de, COMPLETE_TRIALS)
        .filter(({ start, goal }) => solveClosure(kit, start, goal).kind !== "impossible")
        .slice(-STEPPED_CASES);
      let cut = 0;
      for (const { start, goal } of cases) {
        const unlimited = solveClosure(kit, start, goal);
        for (const limit of STEP_LIMITS) {
          const reference = referenceSolve(start, goal, steppedBudget(limit)).result;
          expect(solveClosure(kit, start, goal, steppedBudget(limit))).toEqual(reference);
          if (!isDeepStrictEqual(reference, unlimited)) cut++;
        }
      }
      expect(cut).toBeGreaterThan(0);
    },
    DIFFERENTIAL_TIMEOUT_MS,
  );
});

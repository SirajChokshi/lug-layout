import { readFileSync } from "node:fs";
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
  subtractZeta16,
  zeta16,
  type Pose16,
  type Zeta16,
} from "@brr/math";
import { describe, expect, it } from "vitest";
import { drawingKit, MAX_TURN_CURVES, type DrawingKit, type TurnSign } from "./drawing-kit.ts";
import { advance, connectorPose, layMoves, type TrackPieceDef } from "./track-pose.ts";
import { solveClosure, type ClosureResult, type SearchBudget } from "./closure.ts";
import { closuresWithinTurns, runMoves, type TrackRun } from "./track-solver.ts";

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

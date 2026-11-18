import { readFileSync } from "node:fs";
import {
  conjugateZeta16,
  pose16,
  posesJoin16,
  POSE16_IDENTITY,
  pose16Equals,
  zeta16,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import { describe, expect, it } from "vitest";
import { drawingKit, type DrawingKit } from "./drawing-kit.ts";
import { advance, connectorPose, layMoves, type TrackPieceDef } from "./track-pose.ts";
import { solveClosure, type ClosureResult, type SearchBudget } from "./closure.ts";
import { runMoves, solveDrag, type TrackRun } from "./track-solver.ts";

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

describe("solveDrag", () => {
  it("lays a run whose exact end lies within one straight of any target ahead", () => {
    const random = seeded(11);
    const start = pose16(zeta16([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0);
    let worst = 0;
    for (let trial = 0; trial < 300; trial++) {
      const angle = (random() - 0.5) * Math.PI * 1.6;
      const distance = 40 + random() * 300;
      const target = { x: distance * Math.cos(angle), z: distance * Math.sin(angle) };
      const plan = solveDrag(kit, start, target);
      const end = zeta16ToStuds(endOf(start, plan).position);
      const miss = Math.hypot(end.x - target.x, end.z - target.z);
      expect(miss).toBeCloseTo(plan.missStuds, 6);
      worst = Math.max(worst, miss);
    }
    expect(worst).toBeLessThan(Number(kit.straightStuds));
  });

  it("keeps the previous shape while it stays nearly as good", () => {
    const start = POSE16_IDENTITY;
    const first = solveDrag(kit, start, { x: 120, z: 60 });
    const nudged = solveDrag(kit, start, { x: 121, z: 60 }, first.key);
    expect(nudged.key).toBe(first.key);
  });
});

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
import { runMoves, solveClosure, solveDrag, type TrackRun } from "./track-solver.ts";

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

describe("solveClosure", () => {
  it("closes any gap a run of straights and curves can span, with no more pieces than that run", () => {
    const random = seeded(42);
    for (let trial = 0; trial < 60; trial++) {
      const start = pose16(zeta16([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), Math.floor(random() * 16));
      const reference = randomRun(random);
      const goal = openEndFacing(endOf(start, reference));
      const run = solveClosure(kit, start, goal);
      expect(run).not.toBeNull();
      if (!run) continue;
      expect(posesJoin16(endOf(start, run), goal)).toBe(true);
      expect(run.pieces).toBeLessThanOrEqual(reference.pieces);
    }
  });

  it("closes a full oval from one open end back to the other", () => {
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
    const run = solveClosure(kit, end, back);
    expect(run?.pieces).toBe(8);
    if (run) expect(posesJoin16(endOf(end, run), back)).toBe(true);
  });

  it("refuses a gap that is one stud off any reachable pose", () => {
    const random = seeded(3);
    for (let trial = 0; trial < 30; trial++) {
      const start = POSE16_IDENTITY;
      const goal = openEndFacing(endOf(start, randomRun(random)));
      const coefficient = Math.floor(random() * 8);
      const shifted = goal.position.map((c, k) => (k === coefficient ? c + 1n : c));
      expect(solveClosure(kit, start, pose16(zeta16(shifted), goal.heading))).toBeNull();
    }
  });

  it("refuses an end whose heading is turned by one step", () => {
    const start = POSE16_IDENTITY;
    const goal = openEndFacing(
      endOf(start, { segments: [{ kind: "straight", count: 5 }], pieces: 5 }),
    );
    expect(solveClosure(kit, start, pose16(goal.position, goal.heading + 1), 1)).toBeNull();
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

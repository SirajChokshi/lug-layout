import { readFileSync } from "node:fs";
import {
  conjugateZeta16,
  HALF_TURN_16,
  POSE16_IDENTITY,
  STUD_LDU,
  pose16,
  zeta16,
} from "@brr/math";
import { describe, expect, it } from "vitest";
import { WORLD_TRACK_FRAME, endGaps, type TrackFrame } from "./end-gaps.ts";
import { NO_END, TrackGraph } from "./track-graph.ts";
import { TrackLayout, type TrackPieceSpec } from "./track-layout.ts";

function straight(studs: bigint): TrackPieceSpec {
  return {
    connectors: [
      pose16(zeta16([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), HALF_TURN_16),
      pose16(zeta16([studs, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0),
    ],
    routes: [{ from: 0, to: 1 }],
  };
}

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

function certifiedSpec(part: string): TrackPieceSpec {
  const geometry = JSON.parse(readFileSync(GEOMETRY, "utf8")) as {
    readonly trackEnds: ReadonlyArray<GeometryTrack>;
  };
  const track = geometry.trackEnds.find((t) => t.part === part);
  if (!track) throw new Error(`${part} is not in geometry.json`);
  return {
    connectors: track.relative.map((end) => {
      if (!end.fieldCertified || !end.coefficients) throw new Error(`${part} end not certified`);
      return pose16(conjugateZeta16(zeta16(end.coefficients.map(BigInt))), -end.headingSteps);
    }),
    routes: [{ from: 0, to: 1 }],
  };
}

function partnerOf(graph: TrackGraph, placement: number, connector: number): number {
  return graph.endPartner[(graph.endStart[placement] ?? 0) + connector] ?? NO_END;
}

function laidPieces(layout: TrackLayout) {
  return Array.from({ length: layout.count }, (_, p) => ({
    piece: layout.piece(p),
    pose: layout.pose(p),
    yPlates: layout.yPlates(p),
    rise: layout.rise(p),
    frame: layout.frame(p),
  }));
}

const RUN_FRAMES: ReadonlyArray<TrackFrame> = [
  WORLD_TRACK_FRAME,
  { id: 1, xLdu: 0.25, zLdu: -0.125 },
  { id: 2, xLdu: -0.5, zLdu: 0.375 },
];

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state;
  };
}

it("removes any laid piece by its index and inserts it back there, leaving every other piece exact and in order", () => {
  const next = lcg(7);
  const pieces = [straight(16n), straight(8n), straight(4n)];
  const layout = new TrackLayout(pieces);
  for (let p = 0; p < 150; p++) {
    const coefficients = Array.from({ length: 8 }, () => BigInt((next() % 2001) - 1000));
    layout.place(
      next() % pieces.length,
      pose16(zeta16(coefficients), next() % 16),
      next() % 5,
      next() % 3,
      RUN_FRAMES[next() % RUN_FRAMES.length],
    );
  }
  const before = laidPieces(layout);

  for (let trial = 0; trial < 40; trial++) {
    const at = next() % layout.count;
    const removed = before[at];
    if (!removed) throw new Error(`no piece at ${at}`);
    layout.remove(at);
    expect(laidPieces(layout)).toEqual(before.toSpliced(at, 1));
    const { piece, pose, yPlates, rise, frame } = removed;
    expect(layout.insert(at, piece, pose, yPlates, rise, frame)).toBe(at);
    expect(laidPieces(layout)).toEqual(before);
  }
  expect(() => layout.remove(layout.count)).toThrow(RangeError);
  expect(() => layout.insert(layout.count + 1, 0, POSE16_IDENTITY, 0)).toThrow(RangeError);
  expect(laidPieces(layout)).toEqual(before);
});

it("forgets a run frame's offset once its last piece is removed, as if it had never been laid", () => {
  const layout = new TrackLayout([straight(16n)]);
  const [world, run] = RUN_FRAMES;
  if (!world || !run) throw new Error("no run frames");
  layout.place(0, POSE16_IDENTITY, 0, 0, run);
  layout.place(0, POSE16_IDENTITY, 0, 0, run);
  layout.place(0, POSE16_IDENTITY, 0, 0, world);
  const moved = { ...run, xLdu: run.xLdu + 1 };

  layout.remove(0);
  expect(() => layout.place(0, POSE16_IDENTITY, 0, 0, moved)).toThrow(RangeError);
  layout.remove(0);
  expect(layout.place(0, POSE16_IDENTITY, 0, 0, moved)).toBe(1);
  expect(layout.frame(1)).toEqual(moved);
});

describe("track heights", () => {
  const STRAIGHT = 0;
  const CROSSING = 1;
  const pieces = [certifiedSpec("74746"), certifiedSpec("32087")];

  it("joins a ramp's high end only to track laid at that height", () => {
    const layout = new TrackLayout(pieces);
    const ramp = layout.place(STRAIGHT, POSE16_IDENTITY, 2, 1);
    const above = layout.attach(STRAIGHT, 0, { placement: ramp, connector: 1 });
    const level = layout.place(STRAIGHT, layout.pose(above), 2);
    const graph = new TrackGraph(layout);

    expect(layout.endYPlates(ramp, 0)).toBe(2);
    expect(layout.endYPlates(above, 0)).toBe(3);
    expect(partnerOf(graph, ramp, 1)).toBe((graph.endStart[above] ?? 0) + 0);
    expect(partnerOf(graph, level, 0)).toBe(NO_END);
    expect(graph.issues).toEqual([]);
  });

  it("refuses to lay a piece with more than two ends as a ramp", () => {
    const layout = new TrackLayout(pieces);
    expect(() => layout.place(CROSSING, POSE16_IDENTITY, 0, 1)).toThrow(/only be laid level/);
    expect(layout.place(CROSSING, POSE16_IDENTITY, 4)).toBe(0);
  });
});

describe("run frames", () => {
  const runFrame: TrackFrame = { id: 1, xLdu: 0.25, zLdu: -0.125 };
  const otherRun: TrackFrame = { id: 2, xLdu: 0.25, zLdu: -0.125 };
  const exit = pose16(zeta16([16n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0);

  it("joins ends only inside one frame, never across frames at the same exact pose", () => {
    const layout = new TrackLayout([straight(16n)]);
    const world = layout.place(0, POSE16_IDENTITY, 0);
    const inRun = layout.place(0, exit, 0, 0, runFrame);
    const sameRun = layout.place(
      0,
      pose16(zeta16([32n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0),
      0,
      0,
      runFrame,
    );
    const inOtherRun = layout.place(0, exit, 0, 0, otherRun);
    const graph = new TrackGraph(layout);
    expect(partnerOf(graph, world, 1)).toBe(NO_END);
    expect(partnerOf(graph, inOtherRun, 0)).toBe(NO_END);
    expect(partnerOf(graph, inRun, 1)).toBe((graph.endStart[sameRun] ?? 0) + 0);
    expect(graph.joinCount).toBe(1);
    expect(graph.issues).toEqual([]);
  });

  it("places a run frame's ends at its float offset for play, and reports the gap to world track", () => {
    const layout = new TrackLayout([straight(16n)]);
    layout.place(0, POSE16_IDENTITY, 0);
    const inRun = layout.place(0, exit, 0, 0, runFrame);
    const graph = new TrackGraph(layout);
    const end = graph.endStart[inRun] ?? 0;
    expect([graph.endXLdu[end], graph.endZLdu[end], graph.endFrame[end]]).toEqual([
      16 * STUD_LDU + runFrame.xLdu,
      runFrame.zLdu,
      runFrame.id,
    ]);
    const gaps = endGaps([
      { pose: layout.connectorPose(0, 1), yPlates: 0, frame: WORLD_TRACK_FRAME },
      { pose: layout.connectorPose(inRun, 0), yPlates: 0, frame: runFrame },
    ]);
    expect(gaps.map((gap) => gap.gapLdu)).toEqual([Math.hypot(runFrame.xLdu, runFrame.zLdu)]);
  });

  it("refuses a frame id already placed at another offset", () => {
    const layout = new TrackLayout([straight(16n)]);
    layout.place(0, POSE16_IDENTITY, 0, 0, runFrame);
    expect(() => layout.place(0, exit, 0, 0, { ...runFrame, xLdu: 1 })).toThrow(RangeError);
  });
});

import { readFileSync } from "node:fs";
import { conjugateZeta16, HALF_TURN_16, POSE16_IDENTITY, pose16, zeta16 } from "@brr/math";
import { describe, expect, it } from "vitest";
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

it("swaps a placement to a piece with the same ends and refuses one whose ends differ", () => {
  const layout = new TrackLayout([straight(16n), straight(16n), straight(17n)]);
  const placed = layout.place(0, POSE16_IDENTITY, 0);
  const before = layout.connectorPose(placed, 1);
  layout.replace(placed, 1);
  expect(layout.piece(placed)).toBe(1);
  expect(layout.connectorPose(placed, 1)).toEqual(before);
  expect(() => layout.replace(placed, 2)).toThrow(RangeError);
  expect(layout.piece(placed)).toBe(1);
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

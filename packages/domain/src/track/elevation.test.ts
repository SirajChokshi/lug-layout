import { readFileSync } from "node:fs";
import { conjugateZeta16, pose16, POSE16_IDENTITY, zeta16 } from "@brr/math";
import { describe, expect, it } from "vitest";
import { crossing, PLATES_PER_BRICK, rampRises, riserCourses } from "./elevation.ts";
import { NO_END, TrackGraph } from "./track-graph.ts";
import { INT8_MAX, TrackLayout, type TrackPieceSpec } from "./track-layout.ts";

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

const STRAIGHT = 0;
const CROSSING = 1;
const pieces = [certifiedSpec("74746"), certifiedSpec("32087")];

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function partnerOf(graph: TrackGraph, placement: number, connector: number): number {
  return graph.endPartner[(graph.endStart[placement] ?? 0) + connector] ?? NO_END;
}

describe("track heights", () => {
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

describe("riserCourses", () => {
  it("stacks whole bricks, then fewer than a brick's worth of plates, to the exact height", () => {
    for (let height = 0; height <= 60; height++) {
      const { bricks, plates } = riserCourses(height);
      expect(bricks * PLATES_PER_BRICK + plates).toBe(height);
      expect(plates).toBeLessThan(PLATES_PER_BRICK);
    }
    expect(() => riserCourses(-1)).toThrow(RangeError);
    expect(() => riserCourses(1.5)).toThrow(RangeError);
  });
});

describe("rampRises", () => {
  it("reaches the target height within the per-piece limit, on preferred pieces first", () => {
    const random = seeded(7);
    for (let trial = 0; trial < 500; trial++) {
      const length = Math.floor(random() * 12);
      const preferred = Array.from({ length }, () => random() < 0.6);
      const from = Math.floor(random() * 20) - 5;
      const to = Math.floor(random() * 20) - 5;
      const max = 1 + Math.floor(random() * 2);
      const rises = rampRises(from, to, preferred, max);
      expect(rises === null).toBe(Math.abs(to - from) > length * max);
      if (!rises) continue;
      const sparePreferred = preferred.some((p, i) => p && Math.abs(rises[i] ?? 0) < max);
      const violations = Array.from(rises).filter(
        (rise, i) =>
          Math.abs(rise) > max ||
          rise * Math.sign(to - from) < 0 ||
          (!preferred[i] && sparePreferred && rise !== 0),
      );
      expect(rises.reduce((sum, rise) => sum + rise, 0)).toBe(to - from);
      expect(violations).toEqual([]);
    }
  });
});

describe("rampRises rate bound", () => {
  it("refuses a per-piece rise that a piece's int8 rise can't hold, instead of wrapping", () => {
    expect(() => rampRises(0, 200, [true], 200)).toThrow(RangeError);
    expect(() => rampRises(0, 130, [true, false], 130)).toThrow(RangeError);
    expect(() => rampRises(0, 128, [true], INT8_MAX + 1)).toThrow(RangeError);
    expect(rampRises(0, INT8_MAX, [true], INT8_MAX)).toEqual(Int8Array.of(INT8_MAX));
    expect(rampRises(0, -INT8_MAX, [true], INT8_MAX)).toEqual(Int8Array.of(-INT8_MAX));
  });
});

describe("crossing", () => {
  const ground = { bottomLdu: 0, railTopLdu: 24 };

  it("refuses spans that share height", () => {
    expect(crossing(ground, { bottomLdu: 16, railTopLdu: 40 }, 100)).toEqual({
      kind: "intersects",
    });
  });

  it("measures the gap from the lower rail top to the upper underside", () => {
    const bridge = { bottomLdu: 120, railTopLdu: 144 };
    expect(crossing(ground, bridge, 96)).toEqual({ kind: "clear", upper: 1, gapLdu: 96 });
    expect(crossing(bridge, ground, 97)).toEqual({
      kind: "low",
      upper: 0,
      gapLdu: 96,
      needLdu: 97,
    });
  });
});

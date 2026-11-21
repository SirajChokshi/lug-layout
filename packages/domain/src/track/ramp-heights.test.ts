import { readFileSync } from "node:fs";
import { conjugateZeta16, pose16, POSE16_IDENTITY, zeta16 } from "@brr/math";
import { describe, expect, it } from "vitest";
import { drawingKit, type DrawingKit } from "./drawing-kit.ts";
import { rampRises, reachablePlates, runHeights } from "./ramp-heights.ts";
import { NO_END, TrackGraph } from "./track-graph.ts";
import { INT8_MAX, TrackLayout } from "./track-layout.ts";
import { layMoves, type TrackMove, type TrackPieceDef } from "./track-pose.ts";

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
      return pose16(conjugateZeta16(zeta16(end.coefficients.map(BigInt))), -end.headingSteps);
    }),
  };
}

function nineVolt(): { readonly kit: DrawingKit; readonly pieces: ReadonlyArray<TrackPieceDef> } {
  const geometry = JSON.parse(readFileSync(GEOMETRY, "utf8")) as {
    readonly trackEnds: ReadonlyArray<GeometryTrack>;
  };
  const pieces = geometry.trackEnds
    .filter((t) => NINE_VOLT_STRAIGHT_AND_CURVE.includes(t.part))
    .map(yUpPiece);
  const result = drawingKit(pieces);
  if (result.kind !== "kit") throw new Error(result.reason);
  return { kit: result.kit, pieces };
}

function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

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

  it("refuses a per-piece rise that a piece's int8 rise can't hold, instead of wrapping", () => {
    expect(() => rampRises(0, 128, [true], INT8_MAX + 1)).toThrow(RangeError);
    expect(rampRises(0, INT8_MAX, [true], INT8_MAX)).toEqual(Int8Array.of(INT8_MAX));
    expect(rampRises(0, -INT8_MAX, [true], INT8_MAX)).toEqual(Int8Array.of(-INT8_MAX));
  });

  it("climbs a short run only as far as its pieces can, and a long one exactly to the target", () => {
    expect(reachablePlates(0, 10, 4, 1)).toBe(4);
    expect(reachablePlates(9, 2, 3, 2)).toBe(3);
    expect(reachablePlates(0, 3, 8, 1)).toBe(3);
    expect(rampRises(0, reachablePlates(0, 10, 4, 1), [true, true, true, true], 1)).toEqual(
      Int8Array.of(1, 1, 1, 1),
    );
  });
});

describe("runHeights", () => {
  it("lays every run so each piece's ends meet at one height, whichever end each piece enters by", () => {
    const { kit, pieces } = nineVolt();
    const specs = pieces.map((piece) => ({ connectors: piece.connectors, routes: [] }));
    const indexOf = (move: TrackMove): number => pieces.findIndex((p) => p.id === move.piece.id);
    const random = seeded(11);
    const kinds = [kit.straight, kit.left, kit.right];
    for (let trial = 0; trial < 200; trial++) {
      const moves = Array.from({ length: 1 + Math.floor(random() * 8) }, () => {
        return kinds[Math.floor(random() * kinds.length)] ?? kit.straight;
      });
      const start = Math.floor(random() * 10);
      const rises = Int8Array.from(moves, () => Math.floor(random() * 5) - 2);
      const heights = runHeights(moves, start, rises);
      const layout = new TrackLayout(specs);
      const { placed } = layMoves(POSE16_IDENTITY, moves);
      placed.forEach(({ placement }, i) => {
        const move = moves[i];
        if (!move) return;
        layout.place(indexOf(move), placement, heights.yPlates[i] ?? 0, heights.rise[i] ?? 0);
      });
      const graph = new TrackGraph(layout);
      const unjoinedInside = moves.slice(1).filter((move, i) => {
        const entry = (graph.endStart[i + 1] ?? 0) + move.from;
        return graph.endPartner[entry] === NO_END;
      });
      const first = moves[0];
      const last = moves.at(-1);
      expect(unjoinedInside).toEqual([]);
      expect(first && layout.endYPlates(0, first.from)).toBe(start);
      expect(last && layout.endYPlates(moves.length - 1, last.to)).toBe(heights.endPlates);
      expect(heights.endPlates).toBe(start + rises.reduce((sum, rise) => sum + rise, 0));
    }
  });
});

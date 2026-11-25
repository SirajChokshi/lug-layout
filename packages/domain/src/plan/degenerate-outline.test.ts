import type { PlanOutline, PlanPoint } from "@brr/schema/bundle";
import { describe, expect, it } from "vitest";
import { withoutDegeneratePieces } from "./degenerate-outline.ts";

const S = 24_000_000;

const SQUARE: PlanPoint[] = [
  [0, 0],
  [S, 0],
  [S, S],
  [0, S],
];

describe("withoutDegeneratePieces", () => {
  it("merges a point listed twice in a row, including across the ring's seam", () => {
    const outline: PlanOutline = [
      [
        [0, 0],
        [S, 0],
        [S, 0],
        [S, S],
        [0, S],
        [0, 0],
      ],
    ];
    expect(withoutDegeneratePieces(outline)).toEqual([
      [
        [S, 0],
        [S, S],
        [0, S],
        [0, 0],
      ],
    ]);
  });

  it("removes a spike that goes out along a line and back to the point it left", () => {
    const outline: PlanOutline = [
      [
        [0, 0],
        [S, 0],
        [S, S / 4],
        [2 * S, S / 4],
        [S, S / 4],
        [S, S],
        [0, S],
      ],
    ];
    expect(withoutDegeneratePieces(outline)).toEqual([
      [
        [0, 0],
        [S, 0],
        [S, S / 4],
        [S, S],
        [0, S],
      ],
    ]);
  });

  it("removes a spike that comes back along its line short of the point it left", () => {
    const outline: PlanOutline = [
      [
        [0, 0],
        [S, 0],
        [S, S / 4],
        [2 * S, S / 4],
        [(3 * S) / 2, S / 4],
        [S, S / 2],
        [S, S],
        [0, S],
      ],
    ];
    expect(withoutDegeneratePieces(outline)).toEqual([
      [
        [0, 0],
        [S, 0],
        [S, S / 4],
        [(3 * S) / 2, S / 4],
        [S, S / 2],
        [S, S],
        [0, S],
      ],
    ]);
  });

  it("removes the tips that removing a spike exposes", () => {
    const outline: PlanOutline = [
      [
        [0, 0],
        [S, 0],
        [S, S / 4],
        [(3 * S) / 2, S / 2],
        [2 * S, S / 4],
        [(3 * S) / 2, S / 2],
        [S, S / 4],
        [S, S],
        [0, S],
      ],
    ];
    expect(withoutDegeneratePieces(outline)).toEqual([
      [
        [0, 0],
        [S, 0],
        [S, S / 4],
        [S, S],
        [0, S],
      ],
    ]);
  });

  it("removes a spike whose tip is the ring's first point, the only tip in the ring", () => {
    const outline: PlanOutline = [
      [
        [2 * S, S / 4],
        [S, S / 4],
        [S, S],
        [0, S],
        [0, 0],
        [S, 0],
        [S, S / 4],
      ],
    ];
    expect(withoutDegeneratePieces(outline)).toEqual([
      [
        [S, S],
        [0, S],
        [0, 0],
        [S, 0],
        [S, S / 4],
      ],
    ]);
  });

  it("drops needles of two points, a ring of one point repeated, and a bent needle that goes out and comes straight back", () => {
    const outline: PlanOutline = [
      SQUARE,
      [
        [S / 2, S / 2],
        [S / 2, S / 2],
        [S / 2, S / 2],
      ],
      [
        [S / 4, S / 4],
        [S / 4, S / 4],
        [S / 2, S / 3],
      ],
      [
        [S / 8, S / 2],
        [S / 4, (2 * S) / 3],
        [S / 2, (3 * S) / 4],
        [S / 2, (3 * S) / 4],
        [S / 4, (2 * S) / 3],
        [S / 8, S / 2],
      ],
    ];
    expect(withoutDegeneratePieces(outline)).toEqual([SQUARE]);
  });

  it("drops a ring of three points on one line", () => {
    const outline: PlanOutline = [
      SQUARE,
      [
        [S / 4, S / 2],
        [S / 2, S / 2],
        [(3 * S) / 8, S / 2],
      ],
    ];
    expect(withoutDegeneratePieces(outline)).toEqual([SQUARE]);
  });

  it("keeps a sliver one unit wide that has area", () => {
    const outline: PlanOutline = [
      SQUARE,
      [
        [S / 4, S / 2],
        [S / 2, S / 2 + 1],
        [(3 * S) / 4, S / 2],
      ],
    ];
    expect(withoutDegeneratePieces(outline)).toEqual(outline);
  });

  it("keeps a point one unit off the line through its neighbours, however far apart they are", () => {
    const outline: PlanOutline = [
      [
        [0, 0],
        [433_494_437, 267_914_296],
        [165_580_141, 102_334_155],
      ],
    ];
    expect(withoutDegeneratePieces(outline)).toEqual(outline);
  });

  it("keeps a point where the boundary runs straight on", () => {
    const outline: PlanOutline = [
      [
        [0, 0],
        [S / 2, 0],
        [S, 0],
        [S, S],
        [0, S],
      ],
    ];
    expect(withoutDegeneratePieces(outline)).toEqual(outline);
  });

  it("keeps rings that touch at a point", () => {
    const outline: PlanOutline = [
      SQUARE,
      [
        [S, S],
        [2 * S, S],
        [2 * S, 2 * S],
        [S, 2 * S],
      ],
    ];
    expect(withoutDegeneratePieces(outline)).toEqual(outline);
  });

  it("keeps a ring that crosses itself, though its two lobes cancel in signed area", () => {
    const outline: PlanOutline = [
      [
        [0, 0],
        [S, S],
        [S, 0],
        [0, S],
      ],
    ];
    expect(withoutDegeneratePieces(outline)).toEqual(outline);
  });

  it("returns its input unchanged when nothing is degenerate", () => {
    const outline: PlanOutline = [
      SQUARE,
      [
        [S / 4, S / 4],
        [S / 4, (3 * S) / 4],
        [(3 * S) / 4, (3 * S) / 4],
        [(3 * S) / 4, S / 4],
      ],
    ];
    expect(withoutDegeneratePieces(outline)).toEqual(outline);
  });
});

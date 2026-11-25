import { ZETA16_ORDER, pose16, zeta16 } from "@brr/math";
import { describe, expect, it } from "vitest";
import { PlacedOutline, type OutlineRing } from "./placed-outline.ts";

const MICRO = 1_000_000;
const SQUARE: ReadonlyArray<OutlineRing> = [
  [
    [0, 0],
    [20 * MICRO, 0],
    [20 * MICRO, 20 * MICRO],
    [0, 20 * MICRO],
  ],
];
const SQUARE_CORNER_TWICE: ReadonlyArray<OutlineRing> = [
  [
    [0, 0],
    [20 * MICRO, 0],
    [20 * MICRO, 20 * MICRO],
    [20 * MICRO, 20 * MICRO],
    [0, 20 * MICRO],
  ],
];
const SQUARE_CLOSED_REPEAT: ReadonlyArray<OutlineRing> = [
  [
    [0, 0],
    [20 * MICRO, 0],
    [20 * MICRO, 20 * MICRO],
    [0, 20 * MICRO],
    [0, 0],
  ],
];
const INNER_SQUARE: ReadonlyArray<OutlineRing> = [
  [
    [5 * MICRO, 5 * MICRO],
    [6 * MICRO, 5 * MICRO],
    [6 * MICRO, 6 * MICRO],
    [5 * MICRO, 6 * MICRO],
  ],
];
const SQUARES: ReadonlyArray<readonly [string, ReadonlyArray<OutlineRing>]> = [
  ["plain", SQUARE],
  ["corner listed twice", SQUARE_CORNER_TWICE],
  ["first vertex repeated at the end", SQUARE_CLOSED_REPEAT],
];
const AT_ORIGIN = zeta16([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]);
const QUARTER = ZETA16_ORDER / 4;
const HALF = ZETA16_ORDER / 2;

function turned(heading: number, rings = SQUARE): PlacedOutline {
  return PlacedOutline.ofTrackPiece(rings, pose16(AT_ORIGIN, heading));
}

describe("PlacedOutline", () => {
  it("tells overlap from touching exactly at every ZETA16 heading, for a plain square and for squares that list a corner twice or close by repeating the first vertex", () => {
    for (const [variant, rings] of SQUARES) {
      for (let heading = 0; heading < ZETA16_ORDER; heading++) {
        const square = turned(heading, rings);
        const headingLabel = `heading ${heading}`;
        expect(
          square.overlaps(turned(heading)),
          `${headingLabel} on the plain square (${variant})`,
        ).toBe(true);
        expect(
          square.overlaps(turned(heading + QUARTER)),
          `${headingLabel} edge to edge (${variant})`,
        ).toBe(false);
        expect(
          square.overlaps(turned(heading + HALF)),
          `${headingLabel} corner to corner (${variant})`,
        ).toBe(false);
        expect(
          square.overlaps(turned(heading + 1)),
          `${headingLabel} one step on (${variant})`,
        ).toBe(true);
        expect(
          square.overlaps(turned(heading, INNER_SQUARE)),
          `${headingLabel} against the inner square (${variant})`,
        ).toBe(true);
      }
    }
  });

  it("counts a rectangle sharing only an edge or a corner as clear, and any shared area as overlap", () => {
    const square = PlacedOutline.ofRect({ minX: 0, minZ: 0, maxX: 20, maxZ: 20 });
    const rect = (minX: number, minZ: number, maxX: number, maxZ: number) =>
      square.overlaps(PlacedOutline.ofRect({ minX, minZ, maxX, maxZ }));
    expect({
      edge: rect(20, 0, 40, 20),
      corner: rect(20, 20, 40, 40),
      sliver: rect(19, 0, 40, 20),
      inside: rect(5, 5, 6, 6),
      around: rect(-5, -5, 25, 25),
    }).toEqual({ edge: false, corner: false, sliver: true, inside: true, around: true });
  });

  it("sees a hole as empty, so a rectangle inside it is clear", () => {
    const frame = PlacedOutline.onLattice(
      [
        [
          [0, 0],
          [60 * MICRO, 0],
          [60 * MICRO, 60 * MICRO],
          [0, 60 * MICRO],
        ],
        [
          [20 * MICRO, 20 * MICRO],
          [20 * MICRO, 40 * MICRO],
          [40 * MICRO, 40 * MICRO],
          [40 * MICRO, 20 * MICRO],
        ],
      ],
      100,
      0,
      1,
    );
    expect(
      frame.overlaps(PlacedOutline.ofRect({ minX: 120, minZ: -40, maxX: 140, maxZ: -20 })),
    ).toBe(false);
    expect(
      frame.overlaps(PlacedOutline.ofRect({ minX: 110, minZ: -40, maxX: 140, maxZ: -20 })),
    ).toBe(true);
  });

  it("runs along a segment only where one of its edges shares a stretch of it, and a repeated corner adds no stretch and no axis edge", () => {
    const square = PlacedOutline.ofRect({ minX: 0, minZ: 0, maxX: 20, maxZ: 20 });
    const rotations = [0, 1, 2, 3] as const;
    expect({
      sharedStretch: square.runsAlong([20, -10], [20, 10]),
      endpointOnly: square.runsAlong([20, 20], [20, 30]),
      parallelOff: square.runsAlong([21, 0], [21, 20]),
      throughRepeatedCorner: PlacedOutline.onLattice(SQUARE_CORNER_TWICE, 0, 0, 0).runsAlong(
        [10, 10],
        [30, 30],
      ),
      axisEdgesByRotation: rotations.map((rot) =>
        PlacedOutline.onLattice(SQUARE_CORNER_TWICE, 0, 0, rot).axisEdges(),
      ),
    }).toEqual({
      sharedStretch: true,
      endpointOnly: false,
      parallelOff: false,
      throughRepeatedCorner: false,
      axisEdgesByRotation: rotations.map((rot) =>
        PlacedOutline.onLattice(SQUARE, 0, 0, rot).axisEdges(),
      ),
    });
  });
});

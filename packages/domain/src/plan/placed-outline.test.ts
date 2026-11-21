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
const AT_ORIGIN = zeta16([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]);
const QUARTER = ZETA16_ORDER / 4;
const HALF = ZETA16_ORDER / 2;

function turned(heading: number): PlacedOutline {
  return PlacedOutline.ofTrackPiece(SQUARE, pose16(AT_ORIGIN, heading));
}

describe("PlacedOutline", () => {
  it("tells overlap from touching exactly at every ZETA16 heading", () => {
    for (let heading = 0; heading < ZETA16_ORDER; heading++) {
      const square = turned(heading);
      expect(square.overlaps(turned(heading)), `heading ${heading} on itself`).toBe(true);
      expect(square.overlaps(turned(heading + QUARTER)), `heading ${heading} edge to edge`).toBe(
        false,
      );
      expect(square.overlaps(turned(heading + HALF)), `heading ${heading} corner to corner`).toBe(
        false,
      );
      expect(square.overlaps(turned(heading + 1)), `heading ${heading} one step on`).toBe(true);
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

  it("runs along a segment only where one of its edges shares a stretch of it", () => {
    const square = PlacedOutline.ofRect({ minX: 0, minZ: 0, maxX: 20, maxZ: 20 });
    expect({
      sharedStretch: square.runsAlong([20, -10], [20, 10]),
      endpointOnly: square.runsAlong([20, 20], [20, 30]),
      parallelOff: square.runsAlong([21, 0], [21, 20]),
    }).toEqual({ sharedStretch: true, endpointOnly: false, parallelOff: false });
  });
});

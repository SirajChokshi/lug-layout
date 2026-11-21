import { pose16, zeta16, type Pose16 } from "@brr/math";
import { OUTLINE_UNITS_PER_LDU } from "@brr/schema/bundle";
import { describe, expect, it } from "vitest";
import { ExactFrame } from "./exact-rect.ts";
import { ALONG_X, ALONG_Z } from "./plan-table-edges.ts";
import type { LduRect } from "./plan-region.ts";
import { OutlineEdges, TrackOutline } from "./track-outline.ts";

const SIDE_LDU = 10;
const SIDE = SIDE_LDU * OUTLINE_UNITS_PER_LDU;
const SQUARE = new OutlineEdges([
  [
    [0, 0],
    [SIDE, 0],
    [SIDE, SIDE],
    [0, SIDE],
  ],
]);
const ORIGIN = zeta16([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]);
const EIGHTH_TURN = 2;
const NO_ENDS: ReadonlyArray<Pose16> = [];
const SEAM_ALONG_X = true;
const SEAM_ALONG_Z = false;
const HALF_DIAGONAL = SIDE_LDU / Math.SQRT2;

function units(ldu: number): number {
  return ldu * OUTLINE_UNITS_PER_LDU;
}

function squareRing(x: number, z: number, side = SIDE): ReadonlyArray<readonly [number, number]> {
  return [
    [x, z],
    [x + side, z],
    [x + side, z + side],
    [x, z + side],
  ];
}

function bothWays(outline: TrackOutline, r: LduRect): boolean {
  const exact = meetsExactly(outline, r);
  const floats = meets(outline, r);
  if (exact !== floats)
    throw new Error(`the float and exact paths disagree on ${JSON.stringify(r)}`);
  return floats;
}

function flatOutline(rings: ReadonlyArray<ReadonlyArray<readonly [number, number]>>): TrackOutline {
  return new TrackOutline(new OutlineEdges(rings), pose16(ORIGIN, 0), NO_ENDS);
}

function rect(minX: number, minZ: number, maxX: number, maxZ: number): LduRect {
  return { minX, minZ, maxX, maxZ };
}

function meets(outline: TrackOutline, r: LduRect): boolean {
  return outline.meetsOpenRect(Float64Array.of(r.minX, r.minZ, r.maxX, r.maxZ), 0);
}

function seam(alongX: boolean, line: number, from: number, to: number): Float64Array {
  return Float64Array.of(alongX ? ALONG_X : ALONG_Z, line, from, to, 0);
}

function meetsExactly(outline: TrackOutline, r: LduRect): boolean {
  const frame = new ExactFrame([r.minX, r.minZ, r.maxX, r.maxZ]);
  return outline.meetsExactRect(frame.rect(r), frame.shift);
}

const square = new TrackOutline(SQUARE, pose16(ORIGIN, 0), NO_ENDS);
const diamond = new TrackOutline(SQUARE, pose16(ORIGIN, EIGHTH_TURN), NO_ENDS);

const squareCases: ReadonlyArray<readonly [string, LduRect, boolean]> = [
  ["the square itself", rect(0, 0, 10, 10), true],
  ["a rectangle inside it", rect(2, 2, 3, 3), true],
  ["a rectangle around it", rect(-5, -5, 15, 15), true],
  ["a rectangle across its right edge", rect(9.5, -1, 10.5, 11), true],
  ["a sliver inside along its left edge", rect(0, 0, 1e-6, 10), true],
  ["a rectangle flush against its right edge", rect(10, 0, 20, 10), false],
  ["a rectangle flush against its top edge", rect(-5, 10, 15, 11), false],
  ["a rectangle touching only its corner", rect(10, 10, 20, 20), false],
  ["a rectangle 2^-40 LDU right of its edge", rect(10 + 2 ** -40, 0, 20, 10), false],
  ["a rectangle reaching 2^-40 LDU into it", rect(10 - 2 ** -40, 0, 20, 10), true],
  ["a rectangle reaching 2^-49 LDU into it", rect(10 - 2 ** -49, 0, 20, 10), true],
];

const diamondCases: ReadonlyArray<readonly [string, LduRect, boolean]> = [
  ["a rectangle around its middle", rect(-1, HALF_DIAGONAL - 1, 1, HALF_DIAGONAL + 1), true],
  ["a rectangle in its box's corner, outside it", rect(4, 0, 7, 2), false],
  ["a rectangle whose corner lies on its lower right edge, below it", rect(1, -5, 5, 1), false],
  ["a rectangle whose corner lies on its lower right edge, inside it", rect(-1, 1, 1, 3), true],
  ["a rectangle above its top vertex", rect(-1, 14.2, 1, 20), false],
  ["a rectangle over its top vertex", rect(-1, 14.1, 1, 20), true],
];

describe("a 10 LDU square outline at heading 0", () => {
  it.each(squareCases)("%s: %s", (_name, r, expected) => {
    expect([meets(square, r), meetsExactly(square, r)]).toEqual([expected, expected]);
  });
});

describe("the same square turned an eighth of a turn, a diamond on its corner", () => {
  it.each(diamondCases)("%s: %s", (_name, r, expected) => {
    expect([meets(diamond, r), meetsExactly(diamond, r)]).toEqual([expected, expected]);
  });
});

describe("an outline of two separate rings", () => {
  const apart = new OutlineEdges([
    [
      [0, 0],
      [SIDE, 0],
      [SIDE, SIDE],
      [0, SIDE],
    ],
    [
      [3 * SIDE, 0],
      [4 * SIDE, 0],
      [4 * SIDE, SIDE],
      [3 * SIDE, SIDE],
    ],
  ]);
  const two = new TrackOutline(apart, pose16(ORIGIN, 0), NO_ENDS);

  it("meets a rectangle over either ring and not one in the gap between them", () => {
    expect([
      meets(two, rect(2, 2, 3, 3)),
      meets(two, rect(32, 2, 33, 3)),
      meets(two, rect(10, 0, 30, 10)),
      meets(two, rect(10, -1, 30, 11)),
    ]).toEqual([true, true, false, false]);
  });
});

describe("a square placed at a position reached through diagonal steps", () => {
  const DIAGONAL_STEPS = 3n;
  const placed = new TrackOutline(
    SQUARE,
    pose16(zeta16([0n, 0n, DIAGONAL_STEPS, 0n, 0n, 0n, DIAGONAL_STEPS, 0n]), 0),
    NO_ENDS,
  );
  const z = Number(DIAGONAL_STEPS) * 20 * Math.SQRT2;

  it("has an irrational origin and still decides a rectangle flush with its left edge at x = 0 exactly", () => {
    expect([
      meets(placed, rect(-10, z, 0, z + 10)),
      meets(placed, rect(-10, z, 1e-9, z + 10)),
      meets(placed, rect(0, z + 9, 1, z + 11)),
      meets(placed, rect(0, z + 10.01, 1, z + 11)),
    ]).toEqual([false, true, true, false]);
  });
});

describe("the ends of a straight-shaped outline, 16 studs long with joiner tabs 9 LDU past each end", () => {
  const TAB_LDU = 9;
  const LENGTH_STUDS = 16n;
  const HALF_WIDTH_LDU = 80;
  const body = new OutlineEdges([
    [
      [units(-TAB_LDU), units(-HALF_WIDTH_LDU)],
      [units(320 + TAB_LDU), units(-HALF_WIDTH_LDU)],
      [units(320 + TAB_LDU), units(HALF_WIDTH_LDU)],
      [units(-TAB_LDU), units(HALF_WIDTH_LDU)],
    ],
  ]);
  const ends = [pose16(ORIGIN, 8), pose16(zeta16([LENGTH_STUDS, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0)];
  const along = new TrackOutline(body, pose16(ORIGIN, 0), ends);
  const across = new TrackOutline(body, pose16(ORIGIN, 4), ends);
  const diagonal = new TrackOutline(body, pose16(ORIGIN, EIGHTH_TURN), ends);

  it("finds a joint on a seam through either end, facing across it, and none through its body", () => {
    expect([
      along.jointOnSeam(seam(SEAM_ALONG_Z, 0, -100, 100), 0),
      along.jointOnSeam(seam(SEAM_ALONG_Z, 320, -100, 100), 0),
      along.jointOnSeam(seam(SEAM_ALONG_Z, 160, -100, 100), 0),
      along.jointOnSeam(seam(SEAM_ALONG_Z, 1, -100, 100), 0),
    ]).toEqual([true, true, false, false]);
  });

  it("finds none when the end lies on the seam's line but outside its span, or the seam runs along the end's heading", () => {
    expect([
      along.jointOnSeam(seam(SEAM_ALONG_Z, 0, 10, 100), 0),
      along.jointOnSeam(seam(SEAM_ALONG_Z, 0, 0, 100), 0),
      along.jointOnSeam(seam(SEAM_ALONG_X, 0, -100, 400), 0),
    ]).toEqual([false, true, false]);
  });

  it("turns its ends with it: a quarter turn faces them across a seam along x, an eighth turn faces none across an axis seam", () => {
    expect([
      across.jointOnSeam(seam(SEAM_ALONG_X, 0, -100, 100), 0),
      across.jointOnSeam(seam(SEAM_ALONG_X, 320, -100, 100), 0),
      across.jointOnSeam(seam(SEAM_ALONG_Z, 0, -100, 100), 0),
      diagonal.jointOnSeam(seam(SEAM_ALONG_Z, 0, -100, 100), 0),
      diagonal.jointOnSeam(seam(SEAM_ALONG_X, 0, -100, 100), 0),
    ]).toEqual([true, true, false, false, false]);
  });
});

describe("outline rings with the degenerate pieces that rounding to whole outline units leaves", () => {
  const S = SIDE;

  it("a collinear ring has no inside, so a rectangle over it meets nothing", () => {
    const sliver = flatOutline([
      squareRing(0, 0),
      [
        [3 * S, 0],
        [4 * S, 0],
        [3.5 * S, 0],
      ],
    ]);
    expect([bothWays(sliver, rect(34, -1, 36, 1)), bothWays(sliver, rect(2, 2, 3, 3))]).toEqual([
      false,
      true,
    ]);
  });

  it("two squares sharing an edge fill both sides of it", () => {
    const pair = flatOutline([squareRing(0, 0), squareRing(S, 0)]);
    expect([
      meets(pair, rect(9, 2, 11, 3)),
      meets(pair, rect(10 - 1e-6, 0, 10 + 1e-6, 10)),
    ]).toEqual([true, true]);
  });

  it("a square inside another of the same direction is inside it", () => {
    const nested = flatOutline([squareRing(0, 0), squareRing(S / 4, S / 4, S / 2)]);
    expect([bothWays(nested, rect(4, 4, 6, 6)), bothWays(nested, rect(1, 1, 2, 2))]).toEqual([
      true,
      true,
    ]);
  });

  it("a spike that goes out and back along one line adds nothing", () => {
    const spiked = flatOutline([
      [
        [0, 0],
        [S, 0],
        [S, S / 2],
        [2 * S, S / 2],
        [S, S / 2],
        [S, S],
        [0, S],
      ],
    ]);
    expect([bothWays(spiked, rect(12, 4, 18, 6)), bothWays(spiked, rect(8, 4, 9, 6))]).toEqual([
      false,
      true,
    ]);
  });
});

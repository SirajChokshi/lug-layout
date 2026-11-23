import { describe, expect, it } from "vitest";
import {
  SOLID_MATRIX_FLOATS,
  boxesCross,
  solidsCross,
  type PartSolid,
  type StudSolid,
} from "./solid-contact.ts";

type Vec = readonly [number, number, number];

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] as const;
const QUARTER_TURN = [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0] as const;
const MIRROR_X = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0] as const;
const SQRT_HALF = Math.SQRT1_2;
const EIGHTH_TURN = [SQRT_HALF, 0, SQRT_HALF, 0, 0, 1, 0, 0, -SQRT_HALF, 0, SQRT_HALF, 0] as const;
const NO_STUDS: ReadonlyArray<StudSolid> = [];

function frame(rows: ReadonlyArray<number>, [x, y, z]: Vec): Float64Array {
  const m = Float64Array.from(rows);
  m[3] = x;
  m[7] = y;
  m[11] = z;
  return m;
}

function shellTriangles(lo: Vec, hi: Vec, openBottom = false): number[] {
  const corner = (i: number): Vec => [
    i & 1 ? hi[0] : lo[0],
    i & 2 ? hi[1] : lo[1],
    i & 4 ? hi[2] : lo[2],
  ];
  const faces = [
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
    [0, 2, 3, 1],
    [4, 5, 7, 6],
  ].filter((face) => !openBottom || face.join() !== "0,1,5,4");
  return faces.flatMap(([a = 0, b = 0, c = 0, d = 0]) =>
    [a, b, c, a, c, d].flatMap((i) => [...corner(i)]),
  );
}

function boxSolid(lo: Vec, hi: Vec, cavity: readonly [Vec, Vec] | null = null): PartSolid {
  const triangles = [...shellTriangles(lo, hi), ...(cavity ? shellTriangles(...cavity) : [])];
  return {
    box: Float64Array.of(...lo, ...hi),
    triangles: Float64Array.from(triangles),
    bodyTriangles: triangles.length / 9,
    studFrames: new Float64Array(0),
    studPrimitive: new Uint8Array(0),
    primitives: NO_STUDS,
  };
}

const STUD: StudSolid = {
  box: Float64Array.of(-6, 0, -6, 6, 4, 6),
  triangles: Float64Array.from(shellTriangles([-6, 0, -6], [6, 4, 6], true)),
};

function studdedPlate(): PartSolid {
  const body = shellTriangles([-10, -8, -10], [10, 0, 10]);
  const stud = shellTriangles([-6, 0, -6], [6, 4, 6], true);
  return {
    box: Float64Array.of(-10, -8, -10, 10, 4, 10),
    triangles: Float64Array.from([...body, ...stud]),
    bodyTriangles: body.length / 9,
    studFrames: Float64Array.from(IDENTITY),
    studPrimitive: Uint8Array.of(0),
    primitives: [STUD],
  };
}

function cross(a: PartSolid, at: Float64Array, b: PartSolid, bt: Float64Array): boolean {
  const there = solidsCross(a, at, 0, b, bt, 0);
  const back = solidsCross(b, bt, 0, a, at, 0);
  if (there !== back) throw new Error("solidsCross is not symmetric for this pair");
  return there;
}

const CUBE = boxSolid([-10, -10, -10], [10, 10, 10]);

describe("solids cross only where their insides meet", () => {
  it.each([
    { offset: -30, crosses: false },
    { offset: -20, crosses: false },
    { offset: -19.5, crosses: true },
    { offset: 0, crosses: true },
    { offset: 7, crosses: true },
    { offset: 20, crosses: false },
  ])("cubes $offset LDU apart along every axis and in every frame", ({ offset, crosses }) => {
    for (const rows of [IDENTITY, QUARTER_TURN, MIRROR_X]) {
      for (const axis of [0, 1, 2]) {
        const shift: [number, number, number] = [40, -16, 8];
        shift[axis] = (shift[axis] ?? 0) + offset;
        const at = frame(rows, [40, -16, 8]);
        const bt = frame(rows, shift);
        expect({ rows, axis, crosses: cross(CUBE, at, CUBE, bt) }).toEqual({
          rows,
          axis,
          crosses,
        });
      }
    }
  });

  it("counts cubes meeting only at an edge or a corner as clear", () => {
    const at = frame(IDENTITY, [0, 0, 0]);
    expect(cross(CUBE, at, CUBE, frame(IDENTITY, [20, 20, 0]))).toBe(false);
    expect(cross(CUBE, at, CUBE, frame(IDENTITY, [20, 20, 20]))).toBe(false);
  });

  it("crosses a solid held wholly inside another, where no faces cross", () => {
    const small = boxSolid([-2, -2, -2], [2, 2, 2]);
    expect(cross(CUBE, frame(IDENTITY, [0, 0, 0]), small, frame(EIGHTH_TURN, [3, -1, 2]))).toBe(
      true,
    );
  });

  it("crosses a slab laid flush beside another of the same height and overlapping it", () => {
    const slab = boxSolid([-20, 0, -10], [20, 8, 10]);
    expect(cross(slab, frame(IDENTITY, [0, 0, 0]), slab, frame(IDENTITY, [30, 0, 0]))).toBe(true);
    expect(cross(slab, frame(IDENTITY, [0, 0, 0]), slab, frame(IDENTITY, [40, 0, 0]))).toBe(false);
  });

  it("leaves a solid inside another's hollow clear, and crosses one reaching into its wall", () => {
    const hollow = boxSolid(
      [-20, -20, -20],
      [20, 20, 20],
      [
        [-16, -16, -16],
        [16, 16, 16],
      ],
    );
    const small = boxSolid([-4, -4, -4], [4, 4, 4]);
    const at = frame(IDENTITY, [0, 0, 0]);
    expect(cross(hollow, at, small, frame(IDENTITY, [5, 0, 0]))).toBe(false);
    expect(cross(hollow, at, small, frame(IDENTITY, [12, 0, 0]))).toBe(false);
    expect(cross(hollow, at, small, frame(IDENTITY, [13, 0, 0]))).toBe(true);
  });

  it("crosses what sits inside a stud, clears what rests on its top, and crosses what sits in the plate below it", () => {
    const plate = studdedPlate();
    const tiny = boxSolid([-1, -1, -1], [1, 1, 1]);
    const at = frame(IDENTITY, [0, 0, 0]);
    expect(cross(plate, at, tiny, frame(IDENTITY, [0, 2, 0]))).toBe(true);
    expect(cross(plate, at, tiny, frame(IDENTITY, [0, 5, 0]))).toBe(false);
    expect(cross(plate, at, tiny, frame(IDENTITY, [8, 1, 8]))).toBe(false);
    expect(cross(plate, at, tiny, frame(IDENTITY, [0, -4, 0]))).toBe(true);
  });
});

describe("posed boxes cross only where their volumes meet", () => {
  const box = Float64Array.of(-10, -10, -10, 10, 10, 10);

  it("separates an eighth-turned box whose axis-aligned bounds overlap the other's", () => {
    const at = frame(IDENTITY, [0, 0, 0]);
    const turnedReach = 10 * Math.SQRT2;
    const apart = 10 + turnedReach - 2;
    const touchingDiagonal = 10 + turnedReach;
    expect(boxesCross(at, 0, box, 0, frame(EIGHTH_TURN, [apart, 0, apart]), 0, box, 0)).toBe(false);
    expect(boxesCross(at, 0, box, 0, frame(EIGHTH_TURN, [apart, 0, 0]), 0, box, 0)).toBe(true);
    expect(
      boxesCross(at, 0, box, 0, frame(EIGHTH_TURN, [touchingDiagonal + 1, 0, 0]), 0, box, 0),
    ).toBe(false);
  });

  it("counts boxes that only touch as clear and any overlap as crossing", () => {
    const at = frame(IDENTITY, [0, 0, 0]);
    expect(boxesCross(at, 0, box, 0, frame(QUARTER_TURN, [20, 0, 0]), 0, box, 0)).toBe(false);
    expect(boxesCross(at, 0, box, 0, frame(MIRROR_X, [19.75, 0, 0]), 0, box, 0)).toBe(true);
  });

  it("reads boxes from any offset in packed arrays", () => {
    const packed = new Float64Array(2 * SOLID_MATRIX_FLOATS);
    packed.set(frame(QUARTER_TURN, [0, 0, 0]), 0);
    packed.set(frame(IDENTITY, [0, 19, 0]), SOLID_MATRIX_FLOATS);
    const boxes = Float64Array.of(0, 0, 0, 0, 0, 0, ...box);
    expect(boxesCross(packed, 0, boxes, 6, packed, SOLID_MATRIX_FLOATS, boxes, 6)).toBe(true);
  });
});

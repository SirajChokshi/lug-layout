import type { PlacementPose } from "@brr/domain";
import {
  PLATE_LDU,
  STUD_LDU,
  composePose16,
  isRot90,
  pose16,
  rot90Cos,
  rot90Sin,
  zeta16,
  type Rot90,
} from "@brr/math";
import { describe, expect, it } from "vitest";
import { latticeFrame } from "../connect/model-track-ends.ts";
import {
  QUAD_FLOATS,
  footprintInside,
  latticeCentre,
  pieceRelativePose,
  pieceTranslated,
  pieceTurnedAbout,
  relativePose,
  restStacks,
  stacksOf,
  translated,
  turnedAbout,
} from "./group-transform.ts";

function pose(x: number, z: number, rot: Rot90, yPlates = 0): PlacementPose {
  return { refId: 0, colorId: 0, x, z, yPlates, rot };
}

type Point = readonly [number, number, number];

function toWorld(at: PlacementPose, [lx, ly, lz]: Point): Point {
  if (!isRot90(at.rot)) throw new Error(`rotation ${at.rot} is not a quarter turn`);
  const cos = rot90Cos(at.rot);
  const sin = rot90Sin(at.rot);
  return [
    at.x + cos * lx + sin * lz + 0,
    at.yPlates * PLATE_LDU + ly + 0,
    at.z - sin * lx + cos * lz + 0,
  ];
}

const POSES: ReadonlyArray<PlacementPose> = [
  pose(0, 0, 0),
  pose(340, -1260, 1),
  pose(-2000, 60, 2, 3),
  pose(15_360, 15_360, 3),
];
const PIVOTS = [
  { x: 0, z: 0 },
  { x: 320, z: -40 },
  { x: -15_340, z: 20 },
];
const LOCAL_POINTS: ReadonlyArray<Point> = [
  [0, 0, 0],
  [-310, 8, 150],
  [10, 24, -20],
];

describe("quarter turns about a lattice pivot", () => {
  it.each(PIVOTS)(
    "keep every model on the stud lattice, undo exactly, and come back after four, about %o",
    (pivot) => {
      for (const start of POSES) {
        const once = turnedAbout(start, pivot, 1);
        const four = [1, 2, 3].reduce((at) => turnedAbout(at, pivot, 1), once);

        expect([once.x % STUD_LDU, once.z % STUD_LDU].map(Math.abs)).toEqual([0, 0]);
        expect(turnedAbout(once, pivot, -1)).toEqual(start);
        expect(four).toEqual(start);
      }
    },
  );

  it("move every point of a model the way the whole group turns", () => {
    const pivot = { x: 320, z: -40 };
    for (const start of POSES) {
      const turned = turnedAbout(start, pivot, 1);
      for (const local of LOCAL_POINTS) {
        const [x, y, z] = toWorld(start, local);
        expect(toWorld(turned, local)).toEqual([pivot.x + z - pivot.z, y, pivot.z - x + pivot.x]);
      }
    }
  });
});

describe("track pieces in a group", () => {
  const CARRIED = [
    pose16(zeta16([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0),
    pose16(zeta16([3n, 1n, 0n, -2n, 5n, 0n, 1n, 0n]), 3),
    pose16(zeta16([-16n, 0n, 0n, 0n, 8n, 0n, 0n, 0n]), 12),
  ];

  function worldTrack(model: PlacementPose, carried: (typeof CARRIED)[number]) {
    const frame = latticeFrame(model.x, model.z, model.rot);
    if (!frame) throw new Error(`${model.x}, ${model.z} is off the stud lattice`);
    return composePose16(frame, carried);
  }

  it.each(PIVOTS)(
    "turn and translate exactly as the model that would carry them, and sit where it holds them, about %o",
    (pivot) => {
      for (const model of POSES) {
        for (const carried of CARRIED) {
          const laid = worldTrack(model, carried);
          for (const direction of [1, -1] as const) {
            expect(pieceTurnedAbout(laid, pivot, direction)).toEqual(
              worldTrack(turnedAbout(model, pivot, direction), carried),
            );
          }
          expect(pieceTranslated(laid, -360, 1280)).toEqual(
            worldTrack(translated(model, -360, 1280), carried),
          );
          expect(pieceRelativePose(laid, model)).toEqual(carried);
        }
      }
    },
  );
});

describe("a pose relative to another", () => {
  it("places every point of a model where its own pose does, seen through the other pose", () => {
    for (const frame of POSES) {
      for (const member of POSES) {
        const relative = relativePose(member, frame);
        for (const local of LOCAL_POINTS) {
          expect(toWorld(frame, toWorld(relative, local))).toEqual(toWorld(member, local));
        }
      }
    }
  });
});

describe("stacks in a group", () => {
  it("joins riders to the stack under them, and rests each stack as one on the highest support any member finds", () => {
    const rests = new Set(["1>0", "2>1"]);
    const stacks = stacksOf(4, (rider, base) => rests.has(`${rider}>${base}`));
    const poses = [pose(0, 0, 0, 0), pose(0, 0, 0, 3), pose(0, 0, 0, 6), pose(640, 0, 0, 2)];

    const rested = restStacks(poses, stacks, [1, 0, 9, 0]).map((at) => at.yPlates);

    expect(new Set([stacks[0], stacks[1], stacks[2]]).size).toBe(1);
    expect(stacks[3]).not.toBe(stacks[0]);
    expect(rested).toEqual([3, 6, 9, 0]);
  });
});

function quad(corners: ReadonlyArray<readonly [number, number]>): Float64Array {
  const out = new Float64Array(QUAD_FLOATS);
  corners.forEach(([x, z], corner) => out.set([x, z], corner * 2));
  return out;
}

function box(minX: number, minZ: number, maxX: number, maxZ: number) {
  return { minX, minY: 0, minZ, maxX, maxY: 8, maxZ };
}

describe("box select", () => {
  it.each([
    ["a footprint wholly inside a skewed ground quad", box(-100, -100, 100, 100), true],
    ["a footprint crossing its edge", box(-100, -100, 900, 100), false],
    ["a footprint wholly outside", box(2000, 2000, 2100, 2100), false],
  ])("takes %s only when it lies wholly inside", (_, footprint, inside) => {
    const skewed = quad([
      [-400, -300],
      [500, -350],
      [700, 400],
      [-600, 300],
    ]);
    expect(footprintInside(skewed, footprint)).toBe(inside);
  });

  it("takes nothing from a quad with no area", () => {
    const line = quad([
      [0, 0],
      [100, 0],
      [100, 0],
      [0, 0],
    ]);
    expect(footprintInside(line, box(10, 0, 20, 0))).toBe(false);
  });
});

it("finds the stud lattice point nearest a box's centre, and translates without turning", () => {
  expect(latticeCentre({ minX: -320, minY: 0, minZ: 15, maxX: 970, maxY: 8, maxZ: 335 })).toEqual({
    x: 320,
    z: 180,
  });
  expect(translated(pose(20, 40, 3, 2), -640, 20)).toEqual(pose(-620, 60, 3, 2));
});

import { RAY_FLOATS, type WorldBox } from "@brr/render";
import { describe, expect, it } from "vitest";
import { ScreenRect, rectMode, type RectMode } from "./selection.ts";

const EYE_Y = 1000;
const HALF_SPAN = 100;

function rayTo(eye: readonly [number, number, number], x: number, z: number): Float64Array {
  const ray = new Float64Array(RAY_FLOATS);
  ray.set([eye[0], eye[1], eye[2], x - eye[0], -eye[1], z - eye[2]]);
  return ray;
}

function perspectiveRect(eye: readonly [number, number, number]): ScreenRect {
  return new ScreenRect(
    [
      rayTo(eye, -HALF_SPAN, -HALF_SPAN),
      rayTo(eye, HALF_SPAN, -HALF_SPAN),
      rayTo(eye, HALF_SPAN, HALF_SPAN),
      rayTo(eye, -HALF_SPAN, HALF_SPAN),
    ],
    rayTo(eye, 0, 0),
  );
}

function down(x: number, z: number): Float64Array {
  const ray = new Float64Array(RAY_FLOATS);
  ray.set([x, EYE_Y, z, 0, -1, 0]);
  return ray;
}

function parallelRect(): ScreenRect {
  return new ScreenRect(
    [
      down(-HALF_SPAN, -HALF_SPAN),
      down(HALF_SPAN, -HALF_SPAN),
      down(HALF_SPAN, HALF_SPAN),
      down(-HALF_SPAN, HALF_SPAN),
    ],
    down(0, 0),
  );
}

function flat(minX: number, minZ: number, maxX: number, maxZ: number): WorldBox {
  return { minX, minY: 0, minZ, maxX, maxY: 0, maxZ };
}

const cases: ReadonlyArray<readonly [string, WorldBox, boolean, boolean]> = [
  ["wholly inside", flat(-50, -50, 50, 50), true, true],
  ["across one edge", flat(80, -20, 150, 20), false, true],
  ["over a corner", flat(90, 90, 160, 160), false, true],
  ["enclosing the whole rect", flat(-300, -300, 300, 300), false, true],
  ["outside beside it", flat(120, -20, 200, 20), false, false],
  ["outside diagonally", flat(150, 150, 250, 250), false, false],
];

describe.each([
  ["perspective from straight above", () => perspectiveRect([0, EYE_Y, 0])],
  ["perspective from an oblique eye", () => perspectiveRect([400, EYE_Y, -300])],
  ["parallel rays", parallelRect],
] as const)("ScreenRect with %s", (_, make) => {
  it.each(cases)("a box %s: window %s, crossing %s", (_name, box, window, crossing) => {
    const rect = make();
    expect(rect.picks(box, "window")).toBe(window);
    expect(rect.picks(box, "crossing")).toBe(crossing);
  });
});

it("takes the box's mode from the drag direction: left to right is a window, right to left a crossing", () => {
  const modes: ReadonlyArray<readonly [number, number, RectMode]> = [
    [-0.5, 0.5, "window"],
    [0.5, -0.5, "crossing"],
  ];
  for (const [from, to, mode] of modes) expect(rectMode(from, to)).toBe(mode);
});

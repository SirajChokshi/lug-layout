import { describe, expect, it } from "vitest";
import {
  AXIS_NEG_X,
  AXIS_NEG_Z,
  AXIS_POS_X,
  AXIS_POS_Z,
  TechnicJoins,
  placedHoleEnds,
  type HoleEnds,
} from "./technic-joins.ts";

const ROTATIONS = [0, 1, 2, 3] as const;
const BRICK_FACE_LDU = 10;
const HOLE_Y_LDU = 14;

function ends(list: ReadonlyArray<readonly [number, number, number, number]>): HoleEnds {
  return {
    count: list.length,
    x: Int32Array.from(list.map(([x]) => x)),
    y: Int32Array.from(list.map(([, y]) => y)),
    z: Int32Array.from(list.map(([, , z]) => z)),
    axis: Uint8Array.from(list.map(([, , , axis]) => axis)),
  };
}

const edgeBrick = ends([
  [-20, HOLE_Y_LDU, BRICK_FACE_LDU, AXIS_NEG_Z],
  [0, HOLE_Y_LDU, BRICK_FACE_LDU, AXIS_NEG_Z],
  [20, HOLE_Y_LDU, BRICK_FACE_LDU, AXIS_NEG_Z],
  [-20, HOLE_Y_LDU, -BRICK_FACE_LDU, AXIS_POS_Z],
  [0, HOLE_Y_LDU, -BRICK_FACE_LDU, AXIS_POS_Z],
  [20, HOLE_Y_LDU, -BRICK_FACE_LDU, AXIS_POS_Z],
]);

const AXIS_STEP = [
  [1, 0],
  [-1, 0],
  [0, 0],
  [0, 0],
  [0, 1],
  [0, -1],
] as const;

describe("placedHoleEnds", () => {
  it.each(ROTATIONS)("keeps every hole axis pointing into its brick at quarter turn %i", (rot) => {
    const placed = placedHoleEnds(edgeBrick, { x: 400, z: -60, yLdu: 32, rot });
    for (let i = 0; i < placed.count; i++) {
      const [ax, az] = AXIS_STEP[placed.axis[i] ?? 0] ?? [0, 0];
      const towardCentreX = 400 - (placed.x[i] ?? 0);
      const towardCentreZ = -60 - (placed.z[i] ?? 0);
      expect(ax * towardCentreX + az * towardCentreZ).toBeGreaterThan(0);
      expect(placed.y[i]).toBe(32 + HOLE_Y_LDU);
    }
  });
});

describe("TechnicJoins", () => {
  const joins = new TechnicJoins();
  joins.add(1, placedHoleEnds(edgeBrick, { x: 0, z: 0, yLdu: 0, rot: 0 }));

  it.each([
    ["face to face across the brick's front", 0, 2 * BRICK_FACE_LDU, 3],
    ["one stud along the face", 20, 2 * BRICK_FACE_LDU, 2],
    ["half a stud along the face", 10, 2 * BRICK_FACE_LDU, 0],
    ["one LDU apart", 0, 2 * BRICK_FACE_LDU + 1, 0],
    ["overlapping the brick", 0, 0, 0],
  ])("pins only ends that meet exactly with opposite axes: %s", (_, dx, dz, pinned) => {
    const held = placedHoleEnds(edgeBrick, { x: dx, z: dz, yLdu: 0, rot: 0 });
    expect(joins.joinsAt(held, 0, 0, null)).toBe(pinned);
  });

  it("ignores ends at another height", () => {
    const held = placedHoleEnds(edgeBrick, { x: 0, z: 2 * BRICK_FACE_LDU, yLdu: 8, rot: 0 });
    expect(joins.joinsAt(held, 0, 0, null)).toBe(0);
  });

  it("offers the shifts that make ends meet, most pins first, then nearest", () => {
    const held = placedHoleEnds(edgeBrick, { x: 30, z: 37, yLdu: 0, rot: 0 });
    const shifts = joins.shiftsWithin(held, 60);
    expect(shifts.length).toBeGreaterThan(0);
    let previous = { pins: Number.POSITIVE_INFINITY, distance: 0 };
    for (let s = 0; s < shifts.length; s += 2) {
      const dx = shifts[s] ?? 0;
      const dz = shifts[s + 1] ?? 0;
      const distance = dx * dx + dz * dz;
      const pins = joins.joinsAt(held, dx, dz, null);
      expect(pins).toBeGreaterThan(0);
      expect(distance).toBeLessThanOrEqual(60 * 60);
      expect(pins < previous.pins || distance >= previous.distance).toBe(true);
      expect(pins).toBeLessThanOrEqual(previous.pins);
      previous = { pins, distance };
    }
    expect([shifts[0], shifts[1]]).toEqual([-30, -17]);
  });

  it("matches a rotated neighbour as well as an unrotated one", () => {
    const sideways = new TechnicJoins();
    sideways.add(2, placedHoleEnds(edgeBrick, { x: 0, z: 0, yLdu: 0, rot: 1 }));
    const held = placedHoleEnds(edgeBrick, { x: 2 * BRICK_FACE_LDU, z: 0, yLdu: 0, rot: 3 });
    expect(sideways.joinsAt(held, 0, 0, null)).toBe(3);
    expect([AXIS_POS_X, AXIS_NEG_X]).toContain(held.axis[0]);
  });
});

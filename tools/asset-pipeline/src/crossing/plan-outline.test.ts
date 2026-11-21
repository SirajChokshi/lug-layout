import { describe, expect, it } from "vitest";
import type { PlacedPolygon } from "../ldraw/walk.ts";
import { outlineAreaLdu2, planOutline } from "./plan-outline.ts";

const MICRO = 1_000_000;

function flatQuad(minX: number, minZ: number, maxX: number, maxZ: number, y = 0): PlacedPolygon {
  return {
    color: 16,
    vertices: [
      [minX, y, minZ],
      [maxX, y, minZ],
      [maxX, y, maxZ],
      [minX, y, maxZ],
    ],
  };
}

function wall(x: number, minZ: number, maxZ: number): PlacedPolygon {
  return {
    color: 16,
    vertices: [
      [x, 0, minZ],
      [x, 0, maxZ],
      [x, -24, maxZ],
      [x, -24, minZ],
    ],
  };
}

describe("planOutline", () => {
  it("unions overlapping faces into one exact boundary, not their hull, moving no vertex", () => {
    const { rings, roundedLdu } = planOutline([
      flatQuad(0, 0, 20, 20),
      flatQuad(10, 10, 30, 30, -8),
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(8);
    expect(outlineAreaLdu2(rings)).toBe(700);
    expect(roundedLdu).toBe(0);
  });

  it("keeps a see-through gap as a hole and drops faces that stand edge-on to the plan", () => {
    const frame = [
      flatQuad(0, 0, 60, 20),
      flatQuad(0, 40, 60, 60),
      flatQuad(0, 20, 20, 40),
      flatQuad(40, 20, 60, 40),
      wall(30, 20, 40),
    ];
    const { rings } = planOutline(frame);
    expect(rings.map((ring) => ring.length)).toEqual([4, 4]);
    expect(outlineAreaLdu2(rings)).toBe(60 * 60 - 20 * 20);
  });

  it("joins faces that only share an edge into a single ring", () => {
    const { rings } = planOutline([flatQuad(0, 0, 20, 20), flatQuad(20, 0, 40, 20)]);
    expect(rings).toEqual([
      expect.arrayContaining([
        [0, 0],
        [40 * MICRO, 0],
        [40 * MICRO, -20 * MICRO],
        [0, -20 * MICRO],
      ]),
    ]);
  });
});

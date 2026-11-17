import { describe, expect, it } from "vitest";
import { planTrianglesMeetRect } from "./level-crossings.ts";

const CELL = { minX: 0, maxX: 20, minZ: 0, maxZ: 20 } as const;

function meets(...triangle: ReadonlyArray<number>): boolean {
  return planTrianglesMeetRect(
    Float64Array.from(triangle),
    CELL.minX,
    CELL.maxX,
    CELL.minZ,
    CELL.maxZ,
  );
}

describe("track geometry against a road cell", () => {
  it.each<readonly [string, ReadonlyArray<number>, boolean]>([
    ["a sleeper face lying on the cell's edge only touches it", [20, -5, 20, 25, 30, 10], false],
    ["a triangle reaching a little way into the cell overlaps it", [19, -5, 19, 25, 30, 10], true],
    [
      "a vertical wall seen from above as a segment across the cell",
      [-5, 10, 25, 10, 25, 10],
      true,
    ],
    ["a triangle past the cell's corner along the diagonal", [21, 21, 40, 21, 21, 40], false],
    ["a triangle cutting the corner off", [12, 25, 25, 12, 25, 25], true],
  ])("%s", (_case, triangle, expected) => {
    expect(meets(...triangle)).toBe(expected);
  });
});

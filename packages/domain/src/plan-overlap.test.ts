import { describe, expect, it } from "vitest";
import { planTrianglesOverlap } from "./plan-overlap.ts";

const everywhere = { minX: -1000, minZ: -1000, maxX: 1000, maxZ: 1000 };

function square(x0: number, z0: number, x1: number, z1: number): Float64Array {
  return Float64Array.of(x0, z0, x1, z0, x1, z1, x0, z0, x1, z1, x0, z1);
}

describe("planTrianglesOverlap", () => {
  it.each([
    ["two squares sharing an edge", square(0, 0, 20, 20), square(20, 0, 40, 20), false],
    [
      "two squares 1e-7 LDU into each other",
      square(0, 0, 20, 20),
      square(20 - 1e-7, 0, 40, 20),
      false,
    ],
    [
      "two squares 1e-3 LDU into each other",
      square(0, 0, 20, 20),
      square(20 - 1e-3, 0, 40, 20),
      true,
    ],
    [
      "a square crossing another at 45 degrees",
      square(0, 0, 20, 20),
      Float64Array.of(10, -5, 25, 10, 10, 25),
      true,
    ],
    [
      "a zero-area face lying across a square",
      square(0, 0, 20, 20),
      Float64Array.of(-5, 10, 25, 10, 40, 10),
      false,
    ],
  ] as const)("%s", (_name, a, b, overlaps) => {
    expect(planTrianglesOverlap(a, b, everywhere)).toBe(overlaps);
  });

  it("looks only inside the given box", () => {
    const a = square(0, 0, 20, 20);
    const b = square(10, 10, 30, 30);
    expect(planTrianglesOverlap(a, b, { minX: 40, minZ: 40, maxX: 60, maxZ: 60 })).toBe(false);
  });
});

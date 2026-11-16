import { describe, expect, it } from "vitest";
import { findZeta16Representation } from "./cyclotomic.ts";

const R40_LEFT_ARC_STUDS = [0n, 0n, 0n, 0n, 40n, -40n, 0n, 0n];

describe("findZeta16Representation", () => {
  it("recovers the exact R40 arc chord 40ζ⁴ − 40ζ⁵ from its decimal endpoint", () => {
    const chord = { x: 40 * Math.sin(Math.PI / 8), y: 40 * (1 - Math.cos(Math.PI / 8)) };
    const found = findZeta16Representation(chord, 1e-9);
    expect(found?.coefficients).toEqual(R40_LEFT_ARC_STUDS);
    expect(found?.residual).toBeLessThan(1e-12);
  });

  it("rejects a point off the field at a tight tolerance", () => {
    expect(findZeta16Representation({ x: 0.3, y: Math.SQRT2 / 3 }, 1e-9)).toBeUndefined();
  });
});

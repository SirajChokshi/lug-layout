import { describe, expect, it } from "vitest";
import {
  UNROUNDED_TOLERANCE_LDU,
  certifiedZeta16,
  findZeta16Representation,
} from "./cyclotomic.ts";
import { STUD_LDU as LDU_PER_STUD } from "./units.ts";

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

describe("certifiedZeta16", () => {
  const exactChord = { x: 40 * Math.sin(Math.PI / 8), y: 40 * (1 - Math.cos(Math.PI / 8)) };

  it("certifies the unique field element behind exact data", () => {
    expect(certifiedZeta16(exactChord, UNROUNDED_TOLERANCE_LDU)).toEqual(R40_LEFT_ARC_STUDS);
  });

  it("refuses data perturbed by more than the exact-data tolerance", () => {
    const nudged = { x: exactChord.x + 1e-5 / LDU_PER_STUD, y: exactChord.y };
    expect(certifiedZeta16(nudged, UNROUNDED_TOLERANCE_LDU)).toBeNull();
  });

  it("refuses the same point once it has been rounded to float32", () => {
    const rounded = { x: Math.fround(exactChord.x), y: Math.fround(exactChord.y) };
    expect(certifiedZeta16(rounded, UNROUNDED_TOLERANCE_LDU)).toBeNull();
  });
});

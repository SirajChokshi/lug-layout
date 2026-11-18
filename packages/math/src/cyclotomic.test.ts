import { describe, expect, it } from "vitest";
import {
  COEFFICIENT_BOUND,
  UNROUNDED_TOLERANCE_LDU,
  ZETA16_STEP_RADIANS,
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

function nearZeroOnAxis(
  basis: readonly [number, number, number],
  bound: number,
  reach: number,
): ReadonlyArray<readonly [number, number, number, number]> {
  const hits: Array<readonly [number, number, number, number]> = [];
  for (let first = -bound; first <= bound; first++) {
    for (let second = -bound; second <= bound; second++) {
      for (let third = -bound; third <= bound; third++) {
        const irrational = first * basis[0] + second * basis[1] + third * basis[2];
        const rational = Math.round(-irrational);
        if (Math.abs(rational) <= bound && Math.abs(irrational + rational) <= reach) {
          hits.push([rational, first, second, third]);
        }
      }
    }
  }
  return hits;
}

describe("the certification window", () => {
  it("never holds two candidates: no nonzero element of the doubled coefficient domain lies within its diameter of zero", () => {
    const doubled = 2 * COEFFICIENT_BOUND;
    const diameter = (2 * UNROUNDED_TOLERANCE_LDU) / LDU_PER_STUD;
    const [cos1, cos2, cos3] = [1, 2, 3].map((k) => Math.cos(k * ZETA16_STEP_RADIANS));
    const real = nearZeroOnAxis([cos1 ?? 0, cos2 ?? 0, cos3 ?? 0], doubled, diameter);
    const imaginary = nearZeroOnAxis([cos3 ?? 0, cos2 ?? 0, cos1 ?? 0], doubled, diameter);
    const nonzero = real.flatMap((x) =>
      imaginary.filter(
        (z) =>
          (x[1] - z[1]) % 2 === 0 &&
          (x[2] - z[2]) % 2 === 0 &&
          (x[3] - z[3]) % 2 === 0 &&
          [...x, ...z].some((value) => value !== 0),
      ),
    );
    expect(nonzero).toEqual([]);
  });
});

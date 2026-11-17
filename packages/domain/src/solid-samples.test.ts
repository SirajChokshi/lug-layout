import { STUD_LDU } from "@brr/math";
import { describe, expect, it } from "vitest";
import {
  PlanShell,
  solidMeetsShellInCell,
  solidPatternSpans,
  solidsMeetInCell,
  type Contact,
  type PlacedSolid,
  type SolidSamples,
} from "./solid-samples.ts";

const PER_STUD = 10;
const STEPS = 16;
const BRICK_STEPS = 24 * STEPS;

function contact(): Contact {
  return { xLdu: 0, zLdu: 0, bottomLdu: 0, topLdu: 0, candidateBottomLdu: 0, candidateTopLdu: 0 };
}

function blockOfFourCells(solidSample: (a: number, b: number) => boolean): SolidSamples {
  const pattern: number[] = [];
  for (let b = 0; b < PER_STUD; b++) {
    for (let a = 0; a < PER_STUD; a++) pattern.push(solidSample(a, b) ? 1 : 0);
  }
  return {
    samplesPerStud: PER_STUD,
    stepsPerLdu: STEPS,
    lists: Int32Array.of(0, 1, 0, BRICK_STEPS),
    patterns: Int32Array.from(pattern),
    cells: Int32Array.of(0, 0, 0, 0),
  };
}

function placed(samples: SolidSamples, rot: number, ySteps = 0): PlacedSolid {
  const cos = [1, 0, -1, 0][rot] ?? 1;
  const sin = [0, 1, 0, -1][rot] ?? 0;
  return { samples, cellX0: -1, cellZ0: -1, width: 2, depth: 2, x: 0, z: 0, cos, sin, ySteps };
}

function meetsAnywhere(a: PlacedSolid, b: PlacedSolid): boolean {
  const out = contact();
  return [-1, 0].some((cx) => [-1, 0].some((cz) => solidsMeetInCell(a, b, cx, cz, out)));
}

describe("solid samples on a lattice pose", () => {
  const westHalves = blockOfFourCells((a) => a < PER_STUD / 2);

  it.each([
    [0, 0, true],
    [0, 1, true],
    [0, 2, false],
    [0, 3, true],
    [1, 3, false],
    [2, 2, true],
  ])("half-stud strips turned %i and %i quarter turns meet: %s", (rotA, rotB, expected) => {
    expect(meetsAnywhere(placed(westHalves, rotA), placed(westHalves, rotB))).toBe(expected);
  });

  it("treats spans that only touch as apart, and one step of overlap as a meeting", () => {
    const full = blockOfFourCells(() => true);
    expect(meetsAnywhere(placed(full, 0), placed(full, 1, BRICK_STEPS))).toBe(false);
    const out = contact();
    expect(solidsMeetInCell(placed(full, 0), placed(full, 3, BRICK_STEPS - 1), 0, -1, out)).toBe(
      true,
    );
    expect(out).toMatchObject({
      xLdu: 1,
      zLdu: -19,
      bottomLdu: (BRICK_STEPS - 1) / STEPS,
      candidateTopLdu: 24,
    });
  });

  it("unions each pattern's sample spans into whole-LDU cell spans, rounded outward", () => {
    const samples: SolidSamples = {
      samplesPerStud: 1,
      stepsPerLdu: STEPS,
      lists: Int32Array.of(0, 2, 1, 40, 200, 300),
      patterns: Int32Array.of(1),
      cells: Int32Array.of(0),
    };
    expect(Array.from(solidPatternSpans(samples).spans)).toEqual([0, 3, 12, 19]);
  });
});

function quad(x0: number, x1: number, y: number): number[] {
  return [x0, y, 0, x1, y, 0, x1, y, STUD_LDU, x0, y, 0, x1, y, STUD_LDU, x0, y, STUD_LDU];
}

function studsUnder(xFrom: number): PlacedSolid {
  const pattern: number[] = [];
  for (let b = 0; b < PER_STUD; b++) {
    for (let a = 0; a < PER_STUD; a++) pattern.push(a * 2 + 1 > xFrom ? 4 : 1);
  }
  return {
    samples: {
      samplesPerStud: PER_STUD,
      stepsPerLdu: STEPS,
      lists: Int32Array.of(0, 1, -4 * STEPS, 0, 1, -4 * STEPS, 4 * STEPS),
      patterns: Int32Array.from(pattern),
      cells: Int32Array.of(0),
    },
    cellX0: 0,
    cellZ0: 0,
    width: 1,
    depth: 1,
    x: 0,
    z: 0,
    cos: 1,
    sin: 0,
    ySteps: 0,
  };
}

describe("solid against a track piece's shell", () => {
  const tieWithAntiStud = new PlanShell(
    Float64Array.from([...quad(0, STUD_LDU, 8), ...quad(0, 10, 0), ...quad(10, STUD_LDU, 4)]),
  );

  it("reads the shell from its lowest to its highest face, so an anti-stud cavity stays open", () => {
    const span = new Float64Array(2);
    expect(tieWithAntiStud.spanAt(5, 3, span)).toBe(true);
    expect(Array.from(span)).toEqual([0, 8]);
    expect(tieWithAntiStud.spanAt(15, 5, span)).toBe(true);
    expect(Array.from(span)).toEqual([4, 8]);
    expect(tieWithAntiStud.spanAt(25, 5, span)).toBe(false);
  });

  it("lets studs stand in the cavity and refuses studs under the solid part", () => {
    const out = contact();
    expect(solidMeetsShellInCell(studsUnder(10), tieWithAntiStud, false, 0, 0, out)).toBe(false);
    expect(solidMeetsShellInCell(studsUnder(4), tieWithAntiStud, false, 0, 0, out)).toBe(true);
    expect(out).toMatchObject({ xLdu: 5, bottomLdu: -4, topLdu: 4, candidateBottomLdu: 0 });
  });
});

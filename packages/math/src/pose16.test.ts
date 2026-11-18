import { describe, expect, it } from "vitest";
import {
  attachPose16,
  composePose16,
  HALF_TURN_16,
  isLatticePose16,
  pose16,
  pose16Equals,
  POSE16_IDENTITY,
  posesJoin16,
  type Pose16,
} from "./pose16.ts";
import {
  addZeta16,
  conjugateZeta16,
  rotateZeta16,
  subtractZeta16,
  zeta16,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  ZETA16_ZERO,
  zeta16Direction,
  zeta16Equals,
  zeta16ToStuds,
  type Zeta16,
} from "./zeta16.ts";

const SEED = 0x2545f491;
const SAMPLES = 64;
const STEP_RADIANS = (2 * Math.PI) / ZETA16_ORDER;

function seededValues(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state;
  };
}

const next = seededValues(SEED);
const smallInteger = (): bigint => BigInt((next() % 97) - 48);
const heading = (): number => next() % ZETA16_ORDER;
const element = (): Zeta16 =>
  zeta16(Array.from({ length: ZETA16_COEFFICIENT_COUNT }, smallInteger));
const pose = (): Pose16 => pose16(element(), heading());
const samples = Array.from({ length: SAMPLES }, () => [pose(), pose(), heading()] as const);

describe("ℤ[ζ₁₆] ring", () => {
  it("rotation is multiplication by ζᵏ: it matches the plane rotation and ζ⁸ = −1", () => {
    for (const [a, , steps] of samples) {
      const plane = zeta16ToStuds(a.position);
      const rotated = zeta16ToStuds(rotateZeta16(a.position, steps));
      const angle = steps * STEP_RADIANS;
      expect(rotated.x).toBeCloseTo(plane.x * Math.cos(angle) - plane.z * Math.sin(angle), 9);
      expect(rotated.z).toBeCloseTo(plane.x * Math.sin(angle) + plane.z * Math.cos(angle), 9);
      expect(rotateZeta16(a.position, HALF_TURN_16)).toEqual(
        subtractZeta16(ZETA16_ZERO, a.position),
      );
      expect(rotateZeta16(rotateZeta16(a.position, steps), -steps)).toEqual(a.position);
    }
  });

  it("conjugation mirrors z, is an involution and reverses rotation", () => {
    for (const [a, , steps] of samples) {
      const plane = zeta16ToStuds(a.position);
      const mirrored = zeta16ToStuds(conjugateZeta16(a.position));
      expect(mirrored.x).toBeCloseTo(plane.x, 9);
      expect(mirrored.z).toBeCloseTo(-plane.z, 9);
      expect(conjugateZeta16(conjugateZeta16(a.position))).toEqual(a.position);
      expect(conjugateZeta16(rotateZeta16(a.position, steps))).toEqual(
        rotateZeta16(conjugateZeta16(a.position), -steps),
      );
    }
  });

  it("puts a lattice value on whole studs exactly, however far from the origin", () => {
    const far = 2n ** 40n;
    for (const [x, z] of [
      [0n, 1n],
      [1n, 0n],
      [-3n, 7n],
      [far, -far],
      [-far + 1n, far - 1n],
      [123_456_789n, -987_654_321n],
    ] as const) {
      expect(zeta16ToStuds(zeta16([x, 0n, 0n, 0n, z, 0n, 0n, 0n]))).toEqual({
        x: Number(x),
        z: Number(z),
      });
    }
  });

  it("a quarter turn maps the plane point (x, z) to exactly (−z, x)", () => {
    for (const [a] of samples) {
      const far = zeta16(a.position.map((c) => c * 1_000_003n));
      for (const value of [a.position, far]) {
        const plane = zeta16ToStuds(value);
        const turned = zeta16ToStuds(rotateZeta16(value, ZETA16_ORDER / 4));
        expect(turned.x).toBe(-plane.z);
        expect(turned.z).toBe(plane.x);
      }
    }
  });

  it("gives every heading its unit direction, exactly on the axes at quarter turns", () => {
    for (let steps = 0; steps < ZETA16_ORDER; steps++) {
      const direction = zeta16Direction(steps);
      expect(direction.x).toBeCloseTo(Math.cos(steps * STEP_RADIANS), 14);
      expect(direction.z).toBeCloseTo(Math.sin(steps * STEP_RADIANS), 14);
    }
    expect([0, 4, 8, 12].map(zeta16Direction)).toEqual([
      { x: 1, z: 0 },
      { x: 0, z: 1 },
      { x: -1, z: 0 },
      { x: 0, z: -1 },
    ]);
  });

  it("rejects a value that is not eight coefficients", () => {
    expect(() => zeta16([1n, 2n, 3n])).toThrow("needs 8 coefficients, got 3");
  });
});

function latticeAt(coefficients: ReadonlyArray<bigint>, facing: number): boolean {
  return isLatticePose16(pose16(zeta16(coefficients), facing));
}

describe("lattice poses", () => {
  it("are whole-stud ζ⁰ and ζ⁴ positions facing a quarter turn, and nothing else", () => {
    for (const facing of [0, 4, 8, 12, 16, -4]) {
      expect(latticeAt([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n], facing)).toBe(true);
      expect(latticeAt([32n, 0n, 0n, 0n, -48n, 0n, 0n, 0n], facing)).toBe(true);
    }
    for (const facing of [1, 2, 3, 7, 9, 15]) {
      expect(latticeAt([32n, 0n, 0n, 0n, -48n, 0n, 0n, 0n], facing)).toBe(false);
    }
    for (const power of [1, 2, 3, 5, 6, 7]) {
      const offLattice = Array.from({ length: ZETA16_COEFFICIENT_COUNT }, (_, k) =>
        k === power ? 1n : 0n,
      );
      expect(latticeAt(offLattice, 0)).toBe(false);
    }
  });
});

describe("exact track-end joins", () => {
  it("attaching a piece end to a target joins them, symmetrically", () => {
    for (const [local, target] of samples) {
      const placed = composePose16(attachPose16(local, target), local);
      expect(posesJoin16(placed, target)).toBe(true);
      expect(posesJoin16(target, placed)).toBe(true);
    }
  });

  it("rejects a join off by one coefficient unit or one heading step", () => {
    for (const [a, , steps] of samples) {
      const facing = pose16(a.position, a.heading + HALF_TURN_16);
      const nudge = zeta16(
        Array.from({ length: ZETA16_COEFFICIENT_COUNT }, (_, power) =>
          power === steps % ZETA16_COEFFICIENT_COUNT ? 1n : 0n,
        ),
      );
      expect(posesJoin16(a, facing)).toBe(true);
      expect(posesJoin16(a, pose16(addZeta16(a.position, nudge), facing.heading))).toBe(false);
      expect(posesJoin16(a, pose16(a.position, facing.heading + 1))).toBe(false);
      expect(posesJoin16(a, a)).toBe(false);
    }
  });

  it("composing a turn of 1/16 sixteen times returns exactly to the start", () => {
    for (const [step] of samples) {
      const turn = pose16(step.position, 1);
      let loop = POSE16_IDENTITY;
      for (let piece = 0; piece < ZETA16_ORDER; piece += 1) loop = composePose16(loop, turn);
      expect(pose16Equals(loop, POSE16_IDENTITY)).toBe(true);
      expect(zeta16Equals(loop.position, ZETA16_ZERO)).toBe(true);
    }
  });
});

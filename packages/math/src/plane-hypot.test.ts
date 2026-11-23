import { describe, expect, it } from "vitest";
import { planeHypot } from "./plane-hypot.ts";

const SEED = 0x9e3779b9;
const SAMPLED_PAIRS = 50_000;
const SMALLEST_SUBNORMAL = Number.MIN_VALUE;
const LARGEST_SUBNORMAL = 2.2250738585072009e-308;
const SMALLEST_NORMAL = 2.2250738585072014e-308;
const SMALLEST_EXPONENT = -1074;
const LARGEST_EXPONENT = 1023;
const EXPONENT_SPAN = LARGEST_EXPONENT - SMALLEST_EXPONENT + 1;
const DEEPEST_RATIO_EXPONENT = 1100;
const ORDINARY_EXPONENT_SPAN = 61;
const ORDINARY_SMALLEST_EXPONENT = -30;
const WORD = 2 ** 32;
const NEAR_EQUAL_SPREAD = 2 ** 40;
const MANTISSAS = [1, 1 + 2 ** -52, 1.5, 2 - 2 ** -52];
const RATIO_TOPS = [Number.MAX_VALUE, 2 ** 511, 1, 2 ** -537, SMALLEST_NORMAL];

const EDGES = [
  0,
  -0,
  SMALLEST_SUBNORMAL,
  -SMALLEST_SUBNORMAL,
  LARGEST_SUBNORMAL,
  -LARGEST_SUBNORMAL,
  SMALLEST_NORMAL,
  -SMALLEST_NORMAL,
  Number.MAX_VALUE,
  -Number.MAX_VALUE,
  Infinity,
  -Infinity,
  Number.NaN,
  1,
  -1,
  3,
  4,
  0.1,
  2 ** -537,
  2 ** 511,
  1e-300,
  1e300,
];

function mismatches(pairs: Iterable<readonly [number, number]>): string[] {
  const found: string[] = [];
  for (const [a, b] of pairs) {
    if (!Object.is(planeHypot(a, b), Math.hypot(a, b))) found.push(`${a}, ${b}`);
    if (!Object.is(planeHypot(b, a), Math.hypot(b, a))) found.push(`${b}, ${a}`);
  }
  return found;
}

function* everyExponent(): Generator<readonly [number, number]> {
  for (let exponent = SMALLEST_EXPONENT; exponent <= LARGEST_EXPONENT; exponent++) {
    const power = 2 ** exponent;
    yield [power, 0];
    yield [power, -power];
    yield [power, power / 2];
    for (const first of MANTISSAS) {
      for (const second of MANTISSAS) yield [first * power, second * power];
    }
  }
}

function* everyRatio(): Generator<readonly [number, number]> {
  for (const top of RATIO_TOPS) {
    for (let exponent = 0; exponent <= DEEPEST_RATIO_EXPONENT; exponent++) {
      yield [top, top * 2 ** -exponent];
      yield [top, -1.5 * top * 2 ** -exponent];
    }
  }
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

function* seededSample(): Generator<readonly [number, number]> {
  const next = xorshift32(SEED);
  const bits = new Float64Array(1);
  const words = new Uint32Array(bits.buffer);
  const signed = (magnitude: number): number => (next() & 1 ? -magnitude : magnitude);
  const withExponent = (exponent: number): number => signed((1 + next() / WORD) * 2 ** exponent);
  const anyDouble = (): number => {
    if (next() % 4 === 0) {
      words[0] = next();
      words[1] = next();
      const value = bits[0] ?? 0;
      return Number.isFinite(value) ? value : 1;
    }
    return withExponent((next() % EXPONENT_SPAN) + SMALLEST_EXPONENT);
  };
  const ordinary = (): number =>
    withExponent((next() % ORDINARY_EXPONENT_SPAN) + ORDINARY_SMALLEST_EXPONENT);
  for (let i = 0; i < SAMPLED_PAIRS; i++) {
    const shape = i % 4;
    if (shape === 0) {
      const a = anyDouble();
      yield [a, a * (1 + next() / NEAR_EQUAL_SPREAD)];
    } else if (shape === 1) {
      const a = anyDouble();
      yield [a, a * 2 ** -(next() % DEEPEST_RATIO_EXPONENT)];
    } else if (shape === 2) {
      yield [anyDouble(), anyDouble()];
    } else {
      yield [ordinary(), ordinary()];
    }
  }
}

describe("planeHypot", () => {
  it("gives Math.hypot's exact result for every pair of edge values: zeros of both signs, subnormals, the normal limits, infinities and NaN", () => {
    const pairs = EDGES.flatMap((a) => EDGES.map((b) => [a, b] as const));
    expect(mismatches(pairs)).toEqual([]);
  });

  it("gives Math.hypot's exact result for exact powers of two at every binary exponent, against zero, themselves, half themselves and their mantissa neighbours", () => {
    expect(mismatches(everyExponent())).toEqual([]);
  });

  it("gives Math.hypot's exact result for ratios down to 2^-1100 below the largest double, 2^511, 1, 2^-537 and the smallest normal", () => {
    expect(mismatches(everyRatio())).toEqual([]);
  });

  it("gives Math.hypot's exact result for fifty thousand seeded pairs: near-equal, far apart in scale, independent over every exponent, and ordinary magnitudes", () => {
    expect(mismatches(seededSample())).toEqual([]);
  });
});

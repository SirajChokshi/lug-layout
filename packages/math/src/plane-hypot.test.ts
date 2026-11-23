import { describe, expect, it } from "vitest";
import { planeHypot } from "./plane-hypot.ts";

const SEED = 0x9e3779b9n;
const MASK_64 = 0xffffffffffffffffn;
const GENERATED_PAIRS = 2_000_000;
const SMALLEST_SUBNORMAL = Number.MIN_VALUE;
const LARGEST_SUBNORMAL = 2.2250738585072009e-308;
const SMALLEST_NORMAL = 2.2250738585072014e-308;

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

function xorshift(seed: bigint): () => number {
  let state = seed;
  return () => {
    state ^= (state << 13n) & MASK_64;
    state ^= state >> 7n;
    state ^= (state << 17n) & MASK_64;
    return Number(state & 0xffffffffn);
  };
}

function generated(): Array<readonly [number, number]> {
  const next = xorshift(SEED);
  const bits = new Float64Array(1);
  const words = new Uint32Array(bits.buffer);
  const anyDouble = (): number => {
    const kind = next() % 4;
    if (kind === 0) {
      words[0] = next();
      words[1] = next();
      const value = bits[0] ?? 0;
      return Number.isFinite(value) ? value : 1;
    }
    const exponent = (next() % 2098) - 1074;
    const mantissa = 1 + next() / 2 ** 32;
    return (next() & 1 ? -1 : 1) * mantissa * 2 ** exponent;
  };
  const pairs: Array<readonly [number, number]> = [];
  for (let i = 0; i < GENERATED_PAIRS; i++) {
    const a = anyDouble();
    const shape = i % 3;
    if (shape === 0) pairs.push([a, a * (1 + next() / 2 ** 40)]);
    else if (shape === 1) pairs.push([a, a * 2 ** -(next() % 1100)]);
    else pairs.push([a, anyDouble()]);
  }
  return pairs;
}

function mismatches(pairs: Iterable<readonly [number, number]>): string[] {
  const found: string[] = [];
  for (const [a, b] of pairs) {
    if (!Object.is(planeHypot(a, b), Math.hypot(a, b))) found.push(`${a}, ${b}`);
    if (!Object.is(planeHypot(b, a), Math.hypot(b, a))) found.push(`${b}, ${a}`);
  }
  return found;
}

describe("planeHypot", () => {
  it("gives Math.hypot's exact result for every pair of edge values: zeros of both signs, subnormals, the normal limits, infinities and NaN", () => {
    const pairs = EDGES.flatMap((a) => EDGES.map((b) => [a, b] as const));
    expect(mismatches(pairs)).toEqual([]);
  });

  it("gives Math.hypot's exact result for two million seeded pairs over every binary exponent, near-equal pairs and ratios down to 2^-1100", () => {
    expect(mismatches(generated())).toEqual([]);
  });
});

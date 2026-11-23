import { performance } from "node:perf_hooks";
import { planeHypot } from "../src/plane-hypot.ts";

const SEED = 0x9e3779b9n;
const MASK_64 = 0xffffffffffffffffn;
const GENERATED_PAIRS = 2_000_000;
const REPORTED_MISMATCHES = 10;

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

const began = performance.now();
const pairs = generated();
let compared = 0;
let mismatched = 0;
const reported: string[] = [];
const compare = (a: number, b: number): void => {
  compared++;
  if (Object.is(planeHypot(a, b), Math.hypot(a, b))) return;
  mismatched++;
  if (reported.length < REPORTED_MISMATCHES) reported.push(`planeHypot(${a}, ${b})`);
};
for (const [a, b] of pairs) {
  compare(a, b);
  compare(b, a);
}
const elapsed = performance.now() - began;

process.stdout.write(
  [
    `method: planeHypot against this runtime's Math.hypot, bit for bit (Object.is), for ${GENERATED_PAIRS.toLocaleString("en-US")} pairs from a 64-bit xorshift seeded 0x${SEED.toString(16)}, each in both argument orders. A third are near-equal (ratio within 2^-40 of 1), a third scale the second value by 2^-k for k below 1100, and a third are independent. Each value is a random bit pattern or a random mantissa at any binary exponent from -1074 to 1023.`,
    "",
    "| runtime | comparisons | mismatches | ms |",
    "|---|---|---|---|",
    `| node ${process.versions.node}, V8 ${process.versions.v8} | ${compared.toLocaleString("en-US")} | ${mismatched.toLocaleString("en-US")} | ${Math.round(elapsed).toLocaleString("en-US")} |`,
    ...reported,
    "",
  ].join("\n"),
);
if (mismatched > 0) process.exitCode = 1;

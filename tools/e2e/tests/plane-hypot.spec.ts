import { planeHypot } from "@brr/math";
import { expect, test } from "@playwright/test";

const GENERATED_PAIRS = 200_000;
const SEED = 0x9e3779b9;
const REPORTED_MISMATCHES = 10;
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

test("planeHypot gives Chrome's own Math.hypot, bit for bit, for seeded pairs and every pair of edge values", async ({
  page,
}) => {
  const cdp = await page.context().newCDPSession(page);
  const { product, jsVersion } = await cdp.send("Browser.getVersion");
  test.info().annotations.push({ type: "browser", description: `${product}, V8 ${jsVersion}` });
  await page.goto("about:blank");
  await page.addScriptTag({ content: `globalThis.shipped = ${planeHypot.toString()};` });

  const result = await page.evaluate(
    ({ pairs, seed, edges, reported }) => {
      const shipped: unknown = Reflect.get(globalThis, "shipped");
      if (typeof shipped !== "function") throw new Error("the shipped planeHypot did not load");
      const mismatches: Array<readonly [number, number]> = [];
      let compared = 0;
      const compare = (a: number, b: number): void => {
        compared++;
        if (!Object.is(shipped(a, b), Math.hypot(a, b)) && mismatches.length < reported) {
          mismatches.push([a, b]);
        }
      };
      let state = seed >>> 0;
      const next = (): number => {
        state ^= state << 13;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state;
      };
      const bits = new Float64Array(1);
      const words = new Uint32Array(bits.buffer);
      const anyDouble = (): number => {
        if (next() % 3 === 0) {
          words[0] = next();
          words[1] = next();
          const value = bits[0] ?? 0;
          return Number.isFinite(value) ? value : 1;
        }
        const exponent = (next() % 2098) - 1074;
        return (next() & 1 ? -1 : 1) * (1 + next() / 2 ** 32) * 2 ** exponent;
      };
      for (let i = 0; i < pairs; i++) {
        const a = anyDouble();
        const kind = next() % 3;
        const b =
          kind === 0
            ? a * (1 + next() / 2 ** 52)
            : kind === 1
              ? a * 2 ** -(next() % 1100)
              : anyDouble();
        compare(a, b);
        compare(b, a);
      }
      for (const a of edges) for (const b of edges) compare(a, b);
      return { compared, mismatches };
    },
    { pairs: GENERATED_PAIRS, seed: SEED, edges: EDGES, reported: REPORTED_MISMATCHES },
  );

  expect(result).toEqual({
    compared: 2 * GENERATED_PAIRS + EDGES.length ** 2,
    mismatches: [],
  });
});

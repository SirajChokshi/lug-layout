import { expect, it } from "vitest";
import { lcg, Pair, runSeed, withPlan } from "./plan-sync.test-support.ts";

const FIRST_SEED = 1;
const SEEDS = 6;
const SWEEP_TIMEOUT_MS = 120_000;

it(
  "matches today's full recompute after every edit for seeds 1–6, with every mandatory case hit",
  () => {
    const results = Array.from({ length: SEEDS }, (_, i) => runSeed(FIRST_SEED + i));
    expect(results.flatMap((r) => r.mismatches)).toEqual([]);
    expect(results.flatMap((r) => r.missed)).toEqual([]);
  },
  SWEEP_TIMEOUT_MS,
);

it("gives today's results for a NaN reach and an infinite reach", () => {
  const pair = new Pair(7, lcg(7));
  const planId = withPlan(pair);
  pair.both((s) =>
    s.addTable(planId, { name: "T", rect: { x: 0, z: 0, width: 600, depth: 600 }, heightMm: 750 }),
  );
  for (let k = 0; k < 12; k++) pair.place();
  for (const reach of [Number.NaN, 4e307, 0]) {
    pair.both((s) => s.updatePlan(planId, { maxOverhangMm: reach }));
    pair.compare();
  }
  expect(pair.mismatchList).toEqual([]);
});

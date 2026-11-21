import { expect, it } from "vitest";
import { runSeed } from "./plan-sync.test-support.ts";

const FIRST_SEED = 19;
const SEEDS = 6;
const SWEEP_TIMEOUT_MS = 120_000;

it(
  "matches today's full recompute after every edit for seeds 19–24, with every mandatory case hit",
  () => {
    const results = Array.from({ length: SEEDS }, (_, i) => runSeed(FIRST_SEED + i));
    expect(results.flatMap((r) => r.mismatches)).toEqual([]);
    expect(results.flatMap((r) => r.missed)).toEqual([]);
  },
  SWEEP_TIMEOUT_MS,
);

import { expect, it } from "vitest";
import { SolveSamples } from "./solve-samples.ts";

const EIGHTHS = 8;
const STRIDE = 37;
const WRAP = 1024;
const SPREAD = 7;

function solveMs(i: number): number {
  return ((i * STRIDE) % WRAP) + WRAP * Math.floor(i / WRAP) + (i % SPREAD) / EIGHTHS;
}

it("reports the median, p95 and max of every solve up to 1,024, then of the last 1,024", () => {
  const samples = new SolveSamples();
  expect(samples.stats()).toBeNull();
  const after = new Map<number, unknown>();
  for (let i = 0; i < 1500; i++) {
    samples.push(solveMs(i));
    if (i === 4 || i === 1023 || i === 1499) after.set(i + 1, samples.stats());
  }
  expect(after.get(5)).toEqual({ samples: 5, medianMs: 74.25, p95Ms: 148.5, maxMs: 148.5 });
  expect(after.get(1024)).toEqual({
    samples: 1024,
    medianMs: 512.125,
    p95Ms: 972.375,
    maxMs: 1023.75,
  });
  expect(after.get(1500)).toEqual({
    samples: 1024,
    medianMs: 954.5,
    p95Ms: 1936.625,
    maxMs: 2047.125,
  });
});

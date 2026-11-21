import { describe, expect, it } from "vitest";
import type { ExactRect } from "./exact-rect.ts";
import type { LduRect } from "./plan-region.ts";
import { ReachScratch, disksCover, reachContext, reachFails } from "./plan-reach.ts";
import { freeTableEdges } from "./plan-table-edges.ts";

const TRIALS = 400;
const SIXTEENTHS = 16;

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function squareRoot(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

function smallestRadius(nineSquared: bigint): bigint {
  let r = squareRoot(nineSquared / 9n);
  while (9n * r * r < nineSquared) r++;
  return r;
}

describe("disksCover", () => {
  it("decides a deepest point at a circumcentre that isn't dyadic exactly, to one unit at 2^58 scale", () => {
    const k = 2n ** 58n;
    const centres = [
      [0n, 0n],
      [5n * k, k],
      [2n * k, 4n * k],
    ] as const;
    const rect: ExactRect = { minX: 2n * k, minZ: k, maxX: 3n * k, maxZ: 2n * k };
    const radius = smallestRadius(65n * k * k);
    expect([disksCover(rect, centres, radius), disksCover(rect, centres, radius - 1n)]).toEqual([
      true,
      false,
    ]);
  });
});

function sixteenths(random: () => number, low: number, high: number): number {
  return Math.round((low + random() * (high - low)) * SIXTEENTHS) / SIXTEENTHS;
}

function randomTables(random: () => number): LduRect[] {
  const first: LduRect = {
    minX: 0,
    minZ: 0,
    maxX: sixteenths(random, 400, 3000),
    maxZ: sixteenths(random, 400, 3000),
  };
  const tables = [first];
  if (random() < 0.6) {
    const depth = sixteenths(random, 400, 3000);
    const shift = sixteenths(random, -400, 400);
    tables.push({ minX: first.maxX, minZ: shift, maxX: first.maxX + depth, maxZ: shift + depth });
  }
  return tables;
}

function randomObstacles(random: () => number, tables: ReadonlyArray<LduRect>): LduRect[] {
  const [first] = tables;
  if (!first || random() < 0.5) return [];
  const along = sixteenths(random, first.minX, first.maxX);
  return [{ minX: along, minZ: first.minZ - 200, maxX: along + 300, maxZ: first.minZ }];
}

function randomRects(random: () => number, tables: ReadonlyArray<LduRect>): Float64Array {
  const count = 1 + Math.floor(random() * 3);
  const rects: number[] = [];
  for (let r = 0; r < count; r++) {
    const on = tables[Math.floor(random() * tables.length)] ?? tables[0];
    if (!on) break;
    const minX = sixteenths(random, on.minX, on.maxX);
    const minZ = sixteenths(random, on.minZ, on.maxZ);
    rects.push(minX, minZ, minX + sixteenths(random, 1, 600), minZ + sixteenths(random, 1, 600));
  }
  return Float64Array.from(rects);
}

describe("reachFails", () => {
  it("decides every occupancy the same through certified float strips and through exact strips", () => {
    const random = seeded(581);
    const scratch = new ReachScratch();
    const outcomes = new Set<boolean>();
    for (let trial = 0; trial < TRIALS; trial++) {
      const tables = randomTables(random);
      const free = freeTableEdges(tables, randomObstacles(random, tables));
      const reach = reachContext(free, sixteenths(random, 0, 1500));
      const rects = randomRects(random, tables);
      const count = rects.length / 4;
      const surfaces = Float64Array.from(tables.flatMap((t) => [t.minX, t.minZ, t.maxX, t.maxZ]));
      const float = reachFails(reach, surfaces, tables, rects, count, scratch);
      const exact = reachFails(
        { ...reach, certified: false },
        surfaces,
        tables,
        rects,
        count,
        scratch,
      );
      expect({ trial, certified: reach.certified, float }).toEqual({
        trial,
        certified: true,
        float: exact,
      });
      outcomes.add(float);
    }
    expect([...outcomes].toSorted()).toEqual([false, true]);
  });
});

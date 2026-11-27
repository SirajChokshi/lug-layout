import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { opaqueSort, transparentSort, type RenderSortKey } from "../src/three/tie-order.ts";

const ITEMS = 15_000;
const ITEMS_PER_DEPTH = 24;
const DEPTH_STEP = 0.37;
const RENDER_ORDERS = 3;
const SORTS = 1_000;
const WARMUP_SORTS = 100;
const SHUFFLE_SEED = 0x2545f491;

interface Item extends RenderSortKey {
  readonly id: number;
  readonly groupOrder: number;
  readonly renderOrder: number;
  readonly z: number;
}

function threeOpaqueSort(a: Item, b: Item): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  if (a.z !== b.z) return a.z - b.z;
  return a.id - b.id;
}

function threeTransparentSort(a: Item, b: Item): number {
  if (a.groupOrder !== b.groupOrder) return a.groupOrder - b.groupOrder;
  if (a.renderOrder !== b.renderOrder) return a.renderOrder - b.renderOrder;
  if (a.z !== b.z) return b.z - a.z;
  return a.id - b.id;
}

const COMPARATORS: ReadonlyArray<readonly [string, (a: Item, b: Item) => number]> = [
  ["three's opaque (ties by id)", threeOpaqueSort],
  ["opaqueSort (ties equal)", opaqueSort],
  ["three's transparent (ties by id)", threeTransparentSort],
  ["transparentSort (ties equal)", transparentSort],
];

function shuffledRenderItems(): Item[] {
  const items: Item[] = [];
  for (let i = 0; i < ITEMS; i++) {
    items.push({
      id: i,
      groupOrder: 0,
      renderOrder: i % RENDER_ORDERS === 0 ? 1 : 0,
      z: Math.floor(i / ITEMS_PER_DEPTH) * DEPTH_STEP,
    });
  }
  let state = SHUFFLE_SEED;
  for (let i = items.length - 1; i > 0; i--) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const j = state % (i + 1);
    const swap = items[i];
    const other = items[j];
    if (swap === undefined || other === undefined) continue;
    items[i] = other;
    items[j] = swap;
  }
  return items;
}

function exactTieShare(source: ReadonlyArray<Item>): number {
  let comparisons = 0;
  let ties = 0;
  source.slice().sort((a, b) => {
    comparisons++;
    if (a.groupOrder === b.groupOrder && a.renderOrder === b.renderOrder && a.z === b.z) ties++;
    return threeOpaqueSort(a, b);
  });
  return ties / comparisons;
}

function sortRepeatedly(
  source: ReadonlyArray<Item>,
  target: Item[],
  compare: (a: Item, b: Item) => number,
  sorts: number,
): number {
  let elapsedMs = 0;
  for (let s = 0; s < sorts; s++) {
    for (let i = 0; i < source.length; i++) {
      const item = source[i];
      if (item !== undefined) target[i] = item;
    }
    const start = performance.now();
    target.sort(compare);
    elapsedMs += performance.now() - start;
  }
  return elapsedMs;
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

const source = shuffledRenderItems();
const target = source.slice();
const rows: string[] = [];
for (const [name, compare] of COMPARATORS) {
  sortRepeatedly(source, target, compare, WARMUP_SORTS);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gcBefore = collections;
  const heapBefore = process.memoryUsage().heapUsed;
  const elapsedMs = sortRepeatedly(source, target, compare, SORTS);
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
  await new Promise((resolve) => setTimeout(resolve, 50));
  rows.push(
    `| ${name} | ${((elapsedMs * 1000) / SORTS).toFixed(0)} | ${collections - gcBefore} | ${(heapGrowth / SORTS).toFixed(1)} |`,
  );
}
observer.disconnect();
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}, ${SORTS.toLocaleString("en-US")} sorts of ${ITEMS.toLocaleString("en-US")} preallocated render items, ${(exactTieShare(source) * 100).toFixed(1)}% of three's comparisons exact ties`,
    "| comparator | µs/sort | GCs during run | heap growth B/sort |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"),
);

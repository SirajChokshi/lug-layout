import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { getHeapSpaceStatistics } from "node:v8";
import type { PlanRegion, PlanTable } from "../src/plan/plan-region.ts";
import { MODEL_SEGMENT, PlanRows } from "../src/plan/plan-rows.ts";
import {
  BOX_STRIDE,
  CoverageScratch,
  coverageContext,
  placementIssueCount,
  regionContext,
  uncoveredPieces,
  UNDECIDED,
} from "../src/plan/plan-rules.ts";

const ROWS = 122_880;
const PER_LAYER = 64 * 128;
const BRICK_HALF_X = 40;
const BRICK_HALF_Z = 20;
const BRICK_HEIGHT = 24;
const ROOM_MM = 2100;
const COVERING_REACH_MM = 1100;
const TABLE_HEIGHT_MM = 750;
const WARMUP_PASSES = 8;
const PASSES = 32;
const FALLBACK_DECISIONS = 20;
const FALLBACK_WINDOWS = 21;
const EVERYWHERE = 1e300;
const SETTLE_MS = 50;
const TWO_53 = 2 ** 53;
const COUNTED_SPACES = new Set([
  "new_space",
  "new_large_object_space",
  "old_space",
  "large_object_space",
]);

function rowsOf(boxes: Float64Array, count: number): PlanRows {
  const rows = new PlanRows();
  for (let i = 0; i < count; i++) rows.add(MODEL_SEGMENT, i);
  rows.box.set(boxes.subarray(0, count * BOX_STRIDE));
  return rows;
}

function denseBoxes(count: number): Float64Array {
  const boxes = new Float64Array(count * BOX_STRIDE);
  for (let i = 0; i < count; i++) {
    const layer = Math.floor(i / PER_LAYER);
    const inLayer = i % PER_LAYER;
    const x = (layer % 2) * 40 + (inLayer % 64) * 80 + 40;
    const z = Math.floor(inLayer / 64) * 40 + 20;
    boxes.set(
      [
        x - BRICK_HALF_X,
        layer * BRICK_HEIGHT,
        z - BRICK_HALF_Z,
        x + BRICK_HALF_X,
        (layer + 1) * BRICK_HEIGHT,
        z + BRICK_HALF_Z,
      ],
      i * BOX_STRIDE,
    );
  }
  return boxes;
}

const table: PlanTable = {
  id: "t",
  name: "Table 1",
  rect: { x: 0, z: 0, width: ROOM_MM, depth: ROOM_MM },
  heightMm: TABLE_HEIGHT_MM,
};
const region: PlanRegion = {
  id: "p",
  name: "Plan 1",
  originChunkX: 0,
  originChunkZ: 0,
  footprint: { roomWidthMm: ROOM_MM, roomDepthMm: ROOM_MM, tables: [table], obstacles: [] },
  maxOverhangMm: 0,
  maxReachMm: COVERING_REACH_MM,
};
const ctx = regionContext(region);
const boxes = denseBoxes(ROWS);
const rows = rowsOf(boxes, ROWS);
const scratch = new CoverageScratch();

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });
const collectGarbage = (globalThis as { gc?: () => void }).gc;

function heapBytes(): number {
  let bytes = 0;
  for (const space of getHeapSpaceStatistics()) {
    if (COUNTED_SPACES.has(space.space_name)) bytes += space.space_used_size;
  }
  return bytes;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

function pass(): number {
  let issues = 0;
  for (let row = 0; row < ROWS; row++) {
    issues += placementIssueCount(ctx, rows, row, scratch);
  }
  return issues;
}

function skipped(): number {
  let issues = 0;
  for (let row = 0; row < ROWS; row++) issues += boxes[row * BOX_STRIDE] === -1 ? 1 : 0;
  return issues;
}

function fallbacks(): number {
  let count = 0;
  for (let row = 0; row < ROWS; row++) {
    if (uncoveredPieces(ctx.coverage, boxes, row * BOX_STRIDE, scratch) === UNDECIDED) count++;
  }
  return count;
}

interface Window {
  readonly bytes: number;
  readonly gcs: number;
  readonly times: number[];
  readonly result: number;
}

async function window(passes: number, run: () => number): Promise<Window> {
  collectGarbage?.();
  await settle();
  const gcBefore = collections;
  const before = heapBytes();
  const times: number[] = [];
  let result = 0;
  for (let k = 0; k < passes; k++) {
    const start = performance.now();
    result = run();
    times.push(performance.now() - start);
  }
  const bytes = heapBytes() - before;
  await settle();
  return { bytes, gcs: collections - gcBefore, times, result };
}

function percentile(values: ReadonlyArray<number>, p: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

function uncertifiedTables(
  count: number,
): ReadonlyArray<{ minX: number; minZ: number; maxX: number; maxZ: number }> {
  return Array.from({ length: count }, (_, i) => ({
    minX: TWO_53 - 3000 - 1000 * i,
    minZ: 0,
    maxX: TWO_53 - 1 - 1000 * i,
    maxZ: 100,
  }));
}

interface FallbackCost {
  readonly bytes: number;
  readonly ms: number;
  readonly gcFree: number;
  readonly issues: number;
}

async function fallbackCost(tables: number): Promise<FallbackCost> {
  const coverage = coverageContext(uncertifiedTables(tables), 2.5);
  const box = rowsOf(Float64Array.of(TWO_53 - 2000, 0, 10, TWO_53 + 2, 0, 20), 1);
  const room = { minX: -EVERYWHERE, minZ: -EVERYWHERE, maxX: EVERYWHERE, maxZ: EVERYWHERE };
  const fitCtx = { ...ctx, room, coverage, reach: null };
  const decide = (): number => {
    let issues = 0;
    for (let k = 0; k < FALLBACK_DECISIONS; k++)
      issues += placementIssueCount(fitCtx, box, 0, scratch);
    return issues;
  };
  decide();
  const bytes: number[] = [];
  const times: number[] = [];
  let issues = 0;
  for (let w = 0; w < FALLBACK_WINDOWS; w++) {
    const measured = await window(1, decide);
    times.push(measured.times[0] ?? 0);
    issues = measured.result;
    if (measured.gcs === 0) bytes.push(measured.bytes);
  }
  return {
    bytes: percentile(bytes, 0.5) / FALLBACK_DECISIONS,
    ms: percentile(times, 0.5) / FALLBACK_DECISIONS,
    gcFree: bytes.length,
    issues,
  };
}

for (let k = 0; k < WARMUP_PASSES; k++) {
  pass();
  skipped();
}
await window(PASSES, skipped);
await window(PASSES, pass);
const control = await window(PASSES, skipped);
const work = await window(PASSES, pass);
const fallbackCount = fallbacks();
const resolved: Array<FallbackCost & { readonly tables: number }> = [];
for (const tables of [1, 2, 4]) resolved.push({ tables, ...(await fallbackCost(tables)) });
observer.disconnect();

process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"} (${cpus().length} threads)`,
    `${ROWS.toLocaleString("en-US")} dense bricks inside one ${ROOM_MM} × ${ROOM_MM} mm plan with one table covering it, overhang 0; bytes are summed over ${[...COUNTED_SPACES].join(", ")}`,
    "",
    "| Work | Passes | p50 ms | p95 ms | worst ms | Issues | Fallbacks | GCs | Heap growth (bytes) | Growth beyond the skipped loop (bytes) |",
    "|---|---|---|---|---|---|---|---|---|---|",
    `| placementIssueCount over every row | ${PASSES} | ${percentile(work.times, 0.5).toFixed(2)} | ${percentile(work.times, 0.95).toFixed(2)} | ${Math.max(...work.times).toFixed(2)} | ${work.result} | ${fallbackCount} | ${work.gcs} | ${work.bytes} | ${work.bytes - control.bytes} |`,
    `| the same loop with the work skipped | ${PASSES} | ${percentile(control.times, 0.5).toFixed(2)} | ${percentile(control.times, 0.95).toFixed(2)} | ${Math.max(...control.times).toFixed(2)} | ${control.result} | | ${control.gcs} | ${control.bytes} | |`,
    "",
    `| Fallback decision, uncertified edges | Tables | µs each | Bytes each | GC-free windows of ${FALLBACK_WINDOWS} | Issues per ${FALLBACK_DECISIONS} |`,
    "|---|---|---|---|---|---|",
    ...resolved.map(
      (r) =>
        `| bigint exactCoveredWithin | ${r.tables} | ${(r.ms * 1000).toFixed(1)} | ${Math.round(r.bytes)} | ${r.gcFree} | ${r.issues} |`,
    ),
    "",
  ].join("\n"),
);

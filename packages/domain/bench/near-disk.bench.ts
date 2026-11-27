import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { GCProfiler, getHeapSpaceStatistics } from "node:v8";
import { NO_SWITCH } from "../src/track/track-graph.ts";
import {
  placeSegments,
  segmentsEnd,
  type PlanPose,
  type SimPathSegment,
} from "../src/rail/route-geometry.ts";
import { RAIL_SPOT_FLOATS, RailNetwork, SPOT_DISTANCE } from "../src/rail/rail-network.ts";
import { backwardEdge, buildSimTrack, forwardEdge, type SimRoute } from "../src/rail/sim-track.ts";

const QUERIES = 200_000;
const WARMUP_QUERIES = 20_000;
const GAP_LDU = 450;
const MAX_RADIUS_LDU = 300;
const SPREAD_LDU = 4000;
const YOUNG_GENERATION_SPACES: ReadonlyArray<string> = ["new_space", "new_large_object_space"];
const SCAN_BYTES_FACTOR = 2;

interface Layout {
  readonly name: string;
  readonly network: RailNetwork;
  readonly routes: number;
  readonly centreX: number;
  readonly centreZ: number;
}

function loop(name: string, segments: ReadonlyArray<SimPathSegment>, from: PlanPose): Layout {
  const routes: SimRoute[] = [];
  let at = from;
  let sumX = 0;
  let sumZ = 0;
  for (const segment of segments) {
    const to = segmentsEnd(at, placeSegments(at, [segment]));
    routes.push({ from: at, to, segments: [segment] });
    sumX += at.x;
    sumZ += at.z;
    at = to;
  }
  const count = routes.length;
  const successors = routes.flatMap((_, r) => [
    [forwardEdge((r + 1) % count)],
    [backwardEdge((r + count - 1) % count)],
  ]);
  const { track } = buildSimTrack({
    routes,
    successors,
    switchOfEdge: successors.map(() => NO_SWITCH),
    switchCount: 0,
  });
  return {
    name,
    network: new RailNetwork(track, new Uint8Array(0)),
    routes: count,
    centreX: sumX / count,
    centreZ: sumZ / count,
  };
}

function arcs(count: number, radiusLdu: number, sweepRadians: number): SimPathSegment[] {
  return Array.from({ length: count }, () => ({ kind: "arc", radiusLdu, sweepRadians }) as const);
}

function straights(count: number, lengthLdu: number): SimPathSegment[] {
  return Array.from({ length: count }, () => ({ kind: "straight", lengthLdu }) as const);
}

const layouts: ReadonlyArray<Layout> = [
  loop(
    "an oval of R40 arcs and straights",
    [
      ...arcs(8, 800, Math.PI / 8),
      ...straights(24, 320),
      ...arcs(8, 800, Math.PI / 8),
      ...straights(24, 320),
    ],
    { x: 0, z: -800, heading: 0 },
  ),
  loop("a circle of R200 arcs", arcs(32, 4000, Math.PI / 16), { x: 0, z: -4000, heading: 0 }),
];

const xs = new Float64Array(QUERIES);
const zs = new Float64Array(QUERIES);
const radii = new Float64Array(QUERIES);
const spot = new Float64Array(RAIL_SPOT_FLOATS);

function scatter(layout: Layout): void {
  let state = 0x9e3779b9;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  for (let q = 0; q < QUERIES; q++) {
    xs[q] = layout.centreX + (next() * 2 - 1) * SPREAD_LDU;
    zs[q] = layout.centreZ + (next() * 2 - 1) * SPREAD_LDU;
    radii[q] = next() * MAX_RADIUS_LDU;
  }
}

function nearCountByIndex(network: RailNetwork, count: number): number {
  let near = 0;
  for (let q = 0; q < count; q++) {
    if (network.nearDisk(xs[q] ?? 0, zs[q] ?? 0, radii[q] ?? 0, GAP_LDU)) near++;
  }
  return near;
}

function nearByScan(network: RailNetwork, q: number): boolean {
  if (!network.nearest(xs[q] ?? 0, zs[q] ?? 0, spot)) return false;
  return (spot[SPOT_DISTANCE] ?? 0) - (radii[q] ?? 0) < GAP_LDU;
}

function nearCountByScan(network: RailNetwork, count: number): number {
  let near = 0;
  for (let q = 0; q < count; q++) if (nearByScan(network, q)) near++;
  return near;
}

function firstDisagreement(network: RailNetwork): number {
  for (let q = 0; q < QUERIES; q++) {
    const byIndex = network.nearDisk(xs[q] ?? 0, zs[q] ?? 0, radii[q] ?? 0, GAP_LDU);
    if (byIndex !== nearByScan(network, q)) return q;
  }
  return -1;
}

function youngGenerationBytes(): number {
  let bytes = 0;
  for (const space of getHeapSpaceStatistics()) {
    if (YOUNG_GENERATION_SPACES.includes(space.space_name)) bytes += space.space_used_size;
  }
  return bytes;
}

function youngUsedIn(
  spaces: ReadonlyArray<{ readonly spaceName: string; readonly spaceUsedSize: number }>,
): number {
  let bytes = 0;
  for (const space of spaces) {
    if (YOUNG_GENERATION_SPACES.includes(space.spaceName)) bytes += space.spaceUsedSize;
  }
  return bytes;
}

function youngBytesAllocatedBy(run: () => void): number {
  const profiler = new GCProfiler();
  profiler.start();
  const before = youngGenerationBytes();
  run();
  const after = youngGenerationBytes();
  let collected = 0;
  for (const collection of profiler.stop().statistics) {
    collected +=
      youngUsedIn(collection.beforeGC.heapSpaceStatistics) -
      youngUsedIn(collection.afterGC.heapSpaceStatistics);
  }
  return after - before + collected;
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });
const collect: unknown = Reflect.get(globalThis, "gc");
if (typeof collect !== "function") throw new Error("run the near-disk bench with --expose-gc");
const idleBytes = youngBytesAllocatedBy(() => undefined);

const rows: string[] = [];
let failed = false;
for (const layout of layouts) {
  scatter(layout);
  nearCountByIndex(layout.network, WARMUP_QUERIES);
  nearCountByScan(layout.network, WARMUP_QUERIES);
  collect();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gcBefore = collections;
  let near = 0;
  let nearDiskMs = 0;
  const bytes =
    youngBytesAllocatedBy(() => {
      const start = performance.now();
      near = nearCountByIndex(layout.network, QUERIES);
      nearDiskMs = performance.now() - start;
    }) - idleBytes;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gcs = collections - gcBefore;
  let scanMs = 0;
  const scanBytes =
    youngBytesAllocatedBy(() => {
      const start = performance.now();
      nearCountByScan(layout.network, QUERIES);
      scanMs = performance.now() - start;
    }) - idleBytes;
  rows.push(
    `| ${layout.name} | ${layout.routes} | ${near.toLocaleString("en-US")} | ${((nearDiskMs * 1e6) / QUERIES).toFixed(0)} | ${((scanMs * 1e6) / QUERIES).toFixed(0)} | ${(bytes / QUERIES).toFixed(1)} | ${(scanBytes / QUERIES).toFixed(1)} | ${gcs} |`,
  );
  const disagreement = firstDisagreement(layout.network);
  if (disagreement >= 0 || bytes > SCAN_BYTES_FACTOR * scanBytes) {
    process.stderr.write(
      `${layout.name}: disk ${disagreement} judged differently by the index and the scan (-1: none); ${bytes} young bytes against the scan's ${scanBytes}\n`,
    );
    failed = true;
  }
}
observer.disconnect();

process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"} (${cpus().length} threads)`,
    `${QUERIES.toLocaleString("en-US")} disks scattered over a ${2 * SPREAD_LDU} LDU square round each layout, radii 0 to ${MAX_RADIUS_LDU} LDU, asked whether the track comes within ${GAP_LDU} LDU, after ${WARMUP_QUERIES.toLocaleString("en-US")} warm-up queries; the index is built by the warm-up. Young-generation bytes (less an empty probe's own) are counted over each run. The probe fails if nearDisk and the scan disagree on any disk, or nearDisk allocates more than twice the scan's bytes.`,
    "",
    "| Layout | Routes | Near | nearDisk ns each | nearest scan ns each | nearDisk young bytes each | scan young bytes each | GCs in the nearDisk run |",
    "|---|---:|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
  ].join("\n"),
);
if (failed) process.exitCode = 1;

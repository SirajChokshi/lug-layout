import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { InstancedBufferGeometry, InterleavedBufferAttribute, Mesh } from "three/webgpu";
import type { EdgeMarker, MarkerKind } from "../src/scene-backend.ts";
import { EdgeMarkers } from "../src/three/edge-markers.ts";

const MARKER_COUNTS: ReadonlyArray<number> = [1_000, 10_000];
const SPREAD_LDU = 20_000;
const MARKER_WIDTH_LDU = 6;
const MARKER_LIFT_LDU = 1;
const MARKER_HEIGHT_LDU = 2;
const CALLS = 1_000;
const WARMUP_CALLS = 6_000;
const CHUNK_LDU = 640;
const KINDS: ReadonlyArray<MarkerKind> = ["joined", "open", "mismatch"];
const SEED = 0x2545f491;

function markers(count: number): EdgeMarker[] {
  let state = SEED;
  const next = (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
  return Array.from({ length: count }, (_, index) => {
    const x = Math.round((next() - 0.5) * SPREAD_LDU);
    const z = Math.round((next() - 0.5) * SPREAD_LDU);
    const along = 20 + Math.round(next() * 31) * 20;
    const acrossX = next() < 0.5;
    return {
      kind: KINDS[index % KINDS.length] ?? "open",
      box: {
        minX: x,
        maxX: x + (acrossX ? along : MARKER_WIDTH_LDU),
        minY: MARKER_LIFT_LDU,
        maxY: MARKER_LIFT_LDU + MARKER_HEIGHT_LDU,
        minZ: z,
        maxZ: z + (acrossX ? MARKER_WIDTH_LDU : along),
      },
    };
  });
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

async function probe(name: string, call: (index: number) => void): Promise<string> {
  for (let i = 0; i < WARMUP_CALLS; i++) call(i);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gcBefore = collections;
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  for (let i = 0; i < CALLS; i++) call(i);
  const elapsedMs = performance.now() - start;
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return `| ${name} | ${((elapsedMs * 1000) / CALLS).toFixed(0)} | ${collections - gcBefore} | ${(heapGrowth / CALLS).toFixed(1)} |`;
}

const rows: string[] = [];
for (const count of MARKER_COUNTS) {
  const spread = markers(count);
  const respread = [...spread];
  const edgeMarkers = new EdgeMarkers();
  edgeMarkers.set(spread, 0, 0);
  const mesh = edgeMarkers.group.children[0];
  const color =
    mesh instanceof Mesh && mesh.geometry instanceof InstancedBufferGeometry
      ? mesh.geometry.getAttribute("slotColor")
      : undefined;
  if (!(color instanceof InterleavedBufferAttribute)) {
    throw new Error("the edge marker slots are one interleaved buffer");
  }
  const slots = color.data;
  const label = `${count.toLocaleString("en-US")} markers`;
  rows.push(
    await probe(`${label}: place after a rebase`, (index) => {
      edgeMarkers.place((index % 2) * CHUNK_LDU, 0);
      slots.clearUpdateRanges();
    }),
    await probe(`${label}: set a new array of the same markers`, (index) => {
      edgeMarkers.set(index % 2 === 0 ? spread : respread, 0, 0);
      slots.clearUpdateRanges();
    }),
  );
}
observer.disconnect();
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}, ${CALLS.toLocaleString("en-US")} calls after ${WARMUP_CALLS.toLocaleString("en-US")} warm-up calls`,
    "| step | µs/call | GCs during run | heap growth B/call |",
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"),
);

import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { type PlanExtent, SceneBounds } from "../src/three/scene-bounds.ts";
import { ShadowRange } from "../src/three/shadow-range.ts";

const FRAME_CALLS = 1_000_000;
const REFRESH_CALLS = 20_000;
const WARMUP_SHARE = 5;
const CHUNKS = 10_000;
const CHUNK_LDU = 640;
const CHUNKS_PER_ROW = 100;
const EYE_HEIGHT_LDU = 20_000;
const EYE_STEP_LDU = 7;
const EYE_PATH_STEPS = 4_000;

const extents: PlanExtent[] = [];
for (let i = 0; i < CHUNKS; i++) {
  const x = (i % CHUNKS_PER_ROW) * CHUNK_LDU;
  const z = Math.floor(i / CHUNKS_PER_ROW) * CHUNK_LDU;
  extents.push({ minX: x, maxX: x + CHUNK_LDU, minZ: z, maxZ: z + CHUNK_LDU });
}
const bounds = new SceneBounds();
const range = new ShadowRange();
const reaches = new Float64Array(1);
bounds.invalidate();
bounds.refresh(extents);

function eyeHeight(call: number): number {
  return EYE_HEIGHT_LDU + (call % EYE_PATH_STEPS) * EYE_STEP_LDU;
}

const scenarios: ReadonlyArray<{ name: string; calls: number; frame: (call: number) => void }> = [
  {
    name: "a moving frame's range fit (`ShadowRange.fit`)",
    calls: FRAME_CALLS,
    frame: (call) => {
      range.fit(eyeHeight(call));
    },
  },
  {
    name: "a frame's bounds refresh after a chunk removal (`SceneBounds.refresh`)",
    calls: REFRESH_CALLS,
    frame: () => {
      bounds.invalidate();
      bounds.refresh(extents);
    },
  },
  {
    name: "a frame's reach from the eye (`SceneBounds.reachFrom`, the `Math.hypot` call `main` makes)",
    calls: FRAME_CALLS,
    frame: (call) => {
      reaches[0] = bounds.reachFrom(0, eyeHeight(call), 0);
    },
  },
];

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

const rows: string[] = [];
for (const { name, calls, frame } of scenarios) {
  for (let call = 0; call < calls / WARMUP_SHARE; call++) frame(call);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gcBefore = collections;
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  for (let call = 0; call < calls; call++) frame(call);
  const elapsedMs = performance.now() - start;
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
  await new Promise((resolve) => setTimeout(resolve, 50));
  rows.push(
    `| ${name} | ${calls.toLocaleString("en-US")} | ${((elapsedMs * 1000) / calls).toFixed(3)} | ${collections - gcBefore} | ${(heapGrowth / calls).toFixed(3)} |`,
  );
}
observer.disconnect();
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}, shadow range per frame over ${CHUNKS.toLocaleString("en-US")} chunks`,
    "| scenario | calls | µs/call | GCs during run | heap growth B/call |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"),
);

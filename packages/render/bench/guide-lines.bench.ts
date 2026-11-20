import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import type { GuideSegment } from "../src/scene-backend.ts";
import { GuideLines } from "../src/three/guide-lines.ts";

const CALLS = 1_000_000;
const WARMUP_CALLS = 200_000;
const STUD_LDU = 20;
const CHUNK_LDU = 640;
const TABLE_TOP_Y = -4;
const RULERS = 4;
const REBASE_ORIGINS = 9;

const guides = new GuideLines();
const segments: GuideSegment[] = [];
for (let r = 0; r < RULERS; r++) {
  const z = r * 4 * STUD_LDU;
  const y = TABLE_TOP_Y;
  segments.push(
    { kind: "ruler", ax: 0, ay: y, az: z, bx: CHUNK_LDU, by: y, bz: z },
    { kind: "ruler", ax: 0, ay: y, az: z - 10, bx: 0, by: y, bz: z + 10 },
    { kind: "ruler", ax: CHUNK_LDU, ay: y, az: z - 10, bx: CHUNK_LDU, by: y, bz: z + 10 },
  );
}

function redrawRulers(calls: number): void {
  for (let call = 0; call < calls; call++) {
    guides.set(segments);
    guides.place((call % REBASE_ORIGINS) * CHUNK_LDU, 0);
  }
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

redrawRulers(WARMUP_CALLS);
await new Promise((resolve) => setTimeout(resolve, 50));
const gcBefore = collections;
const heapBefore = process.memoryUsage().heapUsed;
const start = performance.now();
redrawRulers(CALLS);
const elapsedMs = performance.now() - start;
const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
await new Promise((resolve) => setTimeout(resolve, 50));
observer.disconnect();
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}, ruler guide updates`,
    "| scenario | calls | µs/call | GCs during run | heap growth B/call |",
    "|---|---|---|---|---|",
    `| rulers redrawn as a draft end moves | ${CALLS.toLocaleString("en-US")} | ${((elapsedMs * 1000) / CALLS).toFixed(3)} | ${collections - gcBefore} | ${(heapGrowth / CALLS).toFixed(3)} |`,
    "",
  ].join("\n"),
);

import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import type { GuideSegment } from "../src/scene-backend.ts";
import { GroundGridLayer } from "../src/three/ground-grid.ts";
import { GuideLines } from "../src/three/guide-lines.ts";

const CALLS = 1_000_000;
const WARMUP_CALLS = 200_000;
const STUD_LDU = 20;
const CHUNK_LDU = 640;
const SKY_COLOR = 0xd9e6f2;
const TABLE_TOP_Y = -4;
const STEPS_LDU = [STUD_LDU, 8 * STUD_LDU, CHUNK_LDU];
const VIEWS = 4_096;
const VIEW_FLOATS = 5;
const REBASE_EVERY_VIEWS = 97;
const GROUND_REACH = 8;
const RULERS = 4;

const views = new Float64Array(VIEWS * VIEW_FLOATS);
for (let v = 0; v < VIEWS; v++) {
  const origin = -Math.floor(v / REBASE_EVERY_VIEWS) * CHUNK_LDU;
  const o = v * VIEW_FLOATS;
  views[o] = origin + v * 0.37;
  views[o + 1] = -origin - v * 0.21;
  views[o + 2] = origin;
  views[o + 3] = -origin;
  views[o + 4] = (1_500 + v * 1.37) * GROUND_REACH;
}

const ground = new GroundGridLayer(SKY_COLOR);
ground.set({ y: TABLE_TOP_Y, stepsLdu: STEPS_LDU });

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

function followViews(calls: number): void {
  for (let call = 0; call < calls; call++) {
    const o = (call % VIEWS) * VIEW_FLOATS;
    ground.follow(
      views[o] ?? 0,
      views[o + 1] ?? 0,
      views[o + 2] ?? 0,
      views[o + 3] ?? 0,
      views[o + 4] ?? 0,
    );
  }
}

function redrawRulers(calls: number): void {
  for (let call = 0; call < calls; call++) {
    guides.set(segments);
    guides.place(views[(call % VIEWS) * VIEW_FLOATS + 2] ?? 0, 0);
  }
}

const SCENARIOS: ReadonlyArray<readonly [string, (calls: number) => void]> = [
  ["ground follows a panning, zooming, rebasing view", followViews],
  ["rulers redrawn as a draft end moves", redrawRulers],
];

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

const rows: string[] = [];
for (const [name, run] of SCENARIOS) {
  run(WARMUP_CALLS);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gcBefore = collections;
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  run(CALLS);
  const elapsedMs = performance.now() - start;
  const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
  await new Promise((resolve) => setTimeout(resolve, 50));
  rows.push(
    `| ${name} | ${CALLS.toLocaleString("en-US")} | ${((elapsedMs * 1000) / CALLS).toFixed(3)} | ${collections - gcBefore} | ${(heapGrowth / CALLS).toFixed(3)} |`,
  );
}
observer.disconnect();
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}, ground grid and ruler guide updates`,
    "| scenario | calls | µs/call | GCs during run | heap growth B/call |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"),
);

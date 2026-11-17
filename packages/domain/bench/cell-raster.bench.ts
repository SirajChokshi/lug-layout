import { PerformanceObserver, performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { HALF_PLANE_FLOATS, PLAN_TRIANGLE_FLOATS, placedPlanCells } from "../src/cell-raster.ts";

const PIECE_LENGTH_LDU = 338;
const PIECE_WIDTH_LDU = 160;
const STRIPS = 40;
const ROWS = 25;
const POSES = 2_000;
const WARMUP_POSES = 200;
const HEADING_STEPS = 16;

function stripTriangles(): Float64Array {
  const out = new Float64Array(STRIPS * ROWS * 2 * PLAN_TRIANGLE_FLOATS);
  const dx = PIECE_LENGTH_LDU / STRIPS;
  const dz = PIECE_WIDTH_LDU / ROWS;
  let o = 0;
  for (let i = 0; i < STRIPS; i++) {
    for (let j = 0; j < ROWS; j++) {
      const x0 = -PIECE_LENGTH_LDU / 2 + i * dx;
      const z0 = -PIECE_WIDTH_LDU / 2 + j * dz;
      out.set([x0, z0, x0 + dx, z0, x0 + dx, z0 + dz], o);
      out.set([x0, z0, x0 + dx, z0 + dz, x0, z0 + dz], o + PLAN_TRIANGLE_FLOATS);
      o += 2 * PLAN_TRIANGLE_FLOATS;
    }
  }
  return out;
}

function span(angle: number, x: number, z: number): Float64Array {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const half = (PIECE_LENGTH_LDU - 18) / 2;
  const clip = new Float64Array(2 * HALF_PLANE_FLOATS);
  clip.set([c, s, c * x + s * z + half], 0);
  clip.set([-c, -s, -(c * x + s * z) + half], HALF_PLANE_FLOATS);
  return clip;
}

const local = stripTriangles();
const poses = Array.from({ length: POSES + WARMUP_POSES }, (_, k) => {
  const angle = ((k % HEADING_STEPS) * 2 * Math.PI) / HEADING_STEPS;
  const x = 1000 + 37 * k;
  const z = -500 + 23 * k;
  return {
    placement: { cos: Math.cos(angle), sin: Math.sin(angle), x, z },
    clip: span(angle, x, z),
  };
});

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

let cells = 0;
for (let k = 0; k < WARMUP_POSES; k++) {
  const pose = poses[k];
  if (pose) cells += placedPlanCells(local, pose.placement, pose.clip).count;
}
await new Promise((resolve) => setTimeout(resolve, 50));
const gcBefore = collections;
const start = performance.now();
for (let k = WARMUP_POSES; k < poses.length; k++) {
  const pose = poses[k];
  if (pose) cells += placedPlanCells(local, pose.placement, pose.clip).count;
}
const elapsedMs = performance.now() - start;
await new Promise((resolve) => setTimeout(resolve, 50));
observer.disconnect();
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}`,
    "| triangles | poses | elapsed ms | µs per pose | cells per pose | GCs during run |",
    "|---|---|---|---|---|---|",
    `| ${local.length / PLAN_TRIANGLE_FLOATS} | ${POSES} | ${elapsedMs.toFixed(1)} | ${((elapsedMs * 1000) / POSES).toFixed(1)} | ${(cells / (POSES + WARMUP_POSES)).toFixed(1)} | ${collections - gcBefore} |`,
    "",
  ].join("\n"),
);

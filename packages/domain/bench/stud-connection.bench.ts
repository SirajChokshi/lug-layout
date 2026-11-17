import { PerformanceObserver, performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { pickSurface, type SurfaceHit } from "../src/stud-connection.ts";
import { VolumeIndex } from "../src/volume-index.ts";

const WORLD_CELLS = 256;
const TABLE_LDU = -4;
const BLOCK_CELLS = 8;
const BLOCK_STEP_LDU = 24;
const BLOCK_HEIGHTS = 12;
const CEILING_LDU = BLOCK_STEP_LDU * BLOCK_HEIGHTS;
const CAMERA_HEIGHT_LDU = 3000;
const CAMERA_BACK_LDU = -2000;
const RAYS_PER_SIDE = 64;
const WARMUP_ROUNDS = 5;
const ROUNDS = 50;
const TRACK_OWNER = 0;

const volumes = new VolumeIndex();
for (let z = 0; z < WORLD_CELLS; z++) {
  for (let x = 0; x < WORLD_CELLS; x++) {
    volumes.add(1, x, z, TABLE_LDU, 0);
    const block =
      (Math.floor(x / BLOCK_CELLS) * 7 + Math.floor(z / BLOCK_CELLS) * 3) % BLOCK_HEIGHTS;
    if (block >= BLOCK_HEIGHTS / 2) volumes.add(2, x, z, 0, block * BLOCK_STEP_LDU);
  }
}

const rays = new Float64Array(RAYS_PER_SIDE * RAYS_PER_SIDE * 6);
const span = WORLD_CELLS * 20;
for (let j = 0; j < RAYS_PER_SIDE; j++) {
  for (let i = 0; i < RAYS_PER_SIDE; i++) {
    const o = (j * RAYS_PER_SIDE + i) * 6;
    const targetX = ((i + 0.5) / RAYS_PER_SIDE) * span;
    const targetZ = ((j + 0.5) / RAYS_PER_SIDE) * span;
    rays.set(
      [
        span / 2,
        CAMERA_HEIGHT_LDU,
        CAMERA_BACK_LDU,
        targetX - span / 2,
        -CAMERA_HEIGHT_LDU,
        targetZ - CAMERA_BACK_LDU,
      ],
      o,
    );
  }
}
const ignoreTrack = (owner: number): boolean => owner === TRACK_OWNER;
const hit: SurfaceHit = { cellX: 0, cellZ: 0, topLdu: 0, x: 0, z: 0 };
const ray = new Float64Array(6);

function round(): number {
  let raised = 0;
  for (let r = 0; r < rays.length; r += 6) {
    for (let k = 0; k < 6; k++) ray[k] = rays[r + k] ?? 0;
    if (pickSurface(ray, volumes, ignoreTrack, 0, CEILING_LDU, hit) && hit.topLdu > 0) raised++;
  }
  return raised;
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

let raised = 0;
for (let k = 0; k < WARMUP_ROUNDS; k++) raised += round();
await new Promise((resolve) => setTimeout(resolve, 50));
const gcBefore = collections;
const start = performance.now();
for (let k = 0; k < ROUNDS; k++) raised += round();
const elapsedMs = performance.now() - start;
await new Promise((resolve) => setTimeout(resolve, 50));
observer.disconnect();
const picks = ROUNDS * RAYS_PER_SIDE * RAYS_PER_SIDE;
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}`,
    "| world cells | picks | elapsed ms | µs per pick | picks on a raised top | GCs during run |",
    "|---|---|---|---|---|---|",
    `| ${WORLD_CELLS}×${WORLD_CELLS} | ${picks} | ${elapsedMs.toFixed(1)} | ${((elapsedMs * 1000) / picks).toFixed(2)} | ${((100 * raised) / ((ROUNDS + WARMUP_ROUNDS) * RAYS_PER_SIDE * RAYS_PER_SIDE)).toFixed(0)}% | ${collections - gcBefore} |`,
    "",
  ].join("\n"),
);

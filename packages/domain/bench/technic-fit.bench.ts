import { PerformanceObserver, performance } from "node:perf_hooks";
import { cpus } from "node:os";
import {
  SignedPermutation,
  TECHNIC_HOLE,
  TECHNIC_SHAFT,
  TechnicSetBuilder,
  placeTechnic,
  placeTechnicInto,
  technicItemsOverlap,
  technicScratch,
} from "../src/technic-fit.ts";

const Z = 2;
const BRICKS = 16;
const PINS = 8;
const CALLS = 200_000;
const WARMUP_CALLS = 20_000;
const POSES = 20_000;
const BRICK_PITCH_LDU = 40;
const HOLE_RADII = [128, 128, ...Array.from({ length: 16 }, () => 96), 128, 128];
const FRICTION_HALF = [
  128, 128, 100, 100, 100, 100, 101, 96, 97, 96, 97, 96, 96, 101, 100, 100, 100, 100, 104, 104,
];

function bricks() {
  const builder = new TechnicSetBuilder();
  for (let b = 0; b < BRICKS; b++) {
    const x = b * BRICK_PITCH_LDU;
    builder.addItem(
      TECHNIC_HOLE,
      [x - 20, -24, -10, x + 20, 0, 10],
      [{ axis: Z, at: [x, -10], from: -10, radii: HOLE_RADII, pin: null }],
    );
  }
  return builder.build();
}

function pins() {
  const builder = new TechnicSetBuilder();
  for (let p = 0; p < PINS; p++) {
    const x = 2 * p * BRICK_PITCH_LDU;
    builder.addItem(
      TECHNIC_SHAFT,
      [x - 8, -18, -30, x + 8, -2, 10],
      [
        {
          axis: Z,
          at: [x, -10],
          from: -10,
          radii: FRICTION_HALF,
          pin: { origin: -10, direction: 1 },
        },
        {
          axis: Z,
          at: [x, -10],
          from: -30,
          radii: FRICTION_HALF.toReversed(),
          pin: { origin: -10, direction: -1 },
        },
      ],
    );
  }
  return builder.build();
}

const holes = placeTechnic(bricks(), SignedPermutation.quarterTurn(0, 1, 640, 0, -320));
const localPins = pins();
const placedPins = technicScratch(localPins);
const pose = new SignedPermutation();

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

function run(calls: number): number {
  let clear = 0;
  for (let k = 0; k < calls; k++) {
    const pin = k % PINS;
    const brick = (2 * pin) % BRICKS;
    if (!technicItemsOverlap(placedPins, pin, holes, brick)) clear++;
  }
  return clear;
}

function place(poses: number): void {
  for (let k = 0; k < poses; k++) {
    pose.set(0, 1, 640, 8 * (k & 1), -320);
    placeTechnicInto(localPins, pose, placedPins);
  }
}

place(1);
run(WARMUP_CALLS);
place(POSES);
await new Promise((resolve) => setTimeout(resolve, 50));
const gcBefore = collections;
const placeStart = performance.now();
place(POSES);
const placeMs = performance.now() - placeStart;
pose.set(0, 1, 640, 0, -320);
placeTechnicInto(localPins, pose, placedPins);
const start = performance.now();
const clear = run(CALLS);
const elapsedMs = performance.now() - start;
await new Promise((resolve) => setTimeout(resolve, 50));
observer.disconnect();
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}`,
    "| work | count | elapsed ms | ns each | seated pins | GCs during run |",
    "|---|---|---|---|---|---|",
    `| place ${PINS} pins in a pose | ${POSES} | ${placeMs.toFixed(1)} | ${((placeMs * 1e6) / POSES).toFixed(0)} | | |`,
    `| pin against brick | ${CALLS} | ${elapsedMs.toFixed(1)} | ${((elapsedMs * 1e6) / CALLS).toFixed(0)} | ${clear} of ${CALLS} | ${collections - gcBefore} |`,
    "",
  ].join("\n"),
);

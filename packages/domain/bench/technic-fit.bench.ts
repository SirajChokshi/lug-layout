import { PerformanceObserver, performance } from "node:perf_hooks";
import { cpus } from "node:os";
import type { PartTechnic } from "@brr/schema/bundle";
import type { LatticePose } from "../src/connect/candidate-poses.ts";
import {
  modelTechnic,
  placeTechnicInto,
  technicItemsOverlap,
  technicScratch,
} from "../src/technic-fit.ts";

const Z = 2;
const STEPS = 16;
const BLOCKS = 16;
const PINS = 8;
const CALLS = 2_000_000;
const WARMUP_CALLS = 200_000;
const POSES = 200_000;
const BLOCK_PITCH_LDU = 40;
const LINE_Y = 14;
const WIDE = 8 * STEPS;
const BORE = 6 * STEPS;
const BORE_RADII = [WIDE, WIDE, ...Array.from({ length: 16 }, () => BORE), WIDE, WIDE];
const RIDGED_END = [WIDE, WIDE, ...Array.from({ length: 18 }, (_, k) => BORE + 4 + (k % 2))];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const NO_WAIVERS = new Int32Array(0);
const ONE_WAIVER = 1;

const bored: PartTechnic = {
  stepsPerLdu: STEPS,
  holes: [{ axis: Z, at: [0, LINE_Y], from: -10, radii: BORE_RADII }],
  shaft: null,
};
const pin: PartTechnic = {
  stepsPerLdu: STEPS,
  holes: [],
  shaft: {
    axis: Z,
    at: [0, LINE_Y],
    components: [
      { from: -10, radii: RIDGED_END, pin: null },
      { from: -30, radii: RIDGED_END.toReversed(), pin: null },
    ],
  },
};

function row(count: number, pitch: number, box: (x: number) => number[]) {
  return {
    instances: {
      count,
      partIndex: Array.from({ length: count }, () => 0),
      matrices: Float64Array.from(
        Array.from({ length: count }, (_, i) => {
          const matrix = [...IDENTITY];
          matrix[3] = i * pitch;
          return matrix;
        }).flat(),
      ),
    },
    boxes: Array.from({ length: count }, (_, i) => box(i * pitch)).flat(),
  };
}

const blocks = row(BLOCKS, BLOCK_PITCH_LDU, (x) => [x - 20, 0, -10, x + 20, 24, 10]);
const pins = row(PINS, 2 * BLOCK_PITCH_LDU, (x) => [x - 8, LINE_Y - 8, -30, x + 8, LINE_Y + 8, 10]);
const turnedPose: LatticePose = { x: 640, z: -320, yPlates: 0, rot: 1 };
const localBlocks = modelTechnic([bored], blocks.instances, blocks.boxes);
const placedBlocks = technicScratch(localBlocks);
placeTechnicInto(localBlocks, turnedPose, placedBlocks);
const localPins = modelTechnic([pin], pins.instances, pins.boxes);
const placedPins = technicScratch(localPins);
const pose = { x: 640, z: -320, yPlates: 0, rot: 1 };
placeTechnicInto(localPins, turnedPose, placedPins);
const pairWaiver = Array.from({ length: PINS }, (_, p) => {
  const from = placedPins.from[2 * p] ?? 0;
  return Int32Array.of(
    placedPins.axis[2 * p] ?? 0,
    placedPins.atU[2 * p] ?? 0,
    placedPins.atV[2 * p] ?? 0,
    from,
    from + RIDGED_END.length,
  );
});

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });
const collectGarbage = (globalThis as { gc?: () => void }).gc;

function settle(): Promise<void> {
  collectGarbage?.();
  return new Promise((resolve) => setTimeout(resolve, 50));
}

function check(calls: number, waiverCount: number): number {
  let clear = 0;
  for (let k = 0; k < calls; k++) {
    const p = k % PINS;
    const block = (2 * p) % BLOCKS;
    const waivers = pairWaiver[p] ?? NO_WAIVERS;
    if (!technicItemsOverlap(placedPins, p, placedBlocks, block, waivers, waiverCount)) clear++;
  }
  return clear;
}

function place(poses: number): void {
  for (let k = 0; k < poses; k++) {
    pose.yPlates = k & 1;
    placeTechnicInto(localPins, pose, placedPins);
  }
}

interface Measured {
  readonly ms: number;
  readonly gcs: number;
  readonly heapGrowthBytes: number;
  readonly result: number;
}

async function measured(run: () => number): Promise<Measured> {
  run();
  await settle();
  const gcBefore = collections;
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  const result = run();
  const ms = performance.now() - start;
  const heapAfter = process.memoryUsage().heapUsed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { ms, gcs: collections - gcBefore, heapGrowthBytes: heapAfter - heapBefore, result };
}

check(WARMUP_CALLS, ONE_WAIVER);
const placing = await measured(() => {
  place(POSES);
  return POSES;
});
pose.yPlates = 0;
placeTechnicInto(localPins, pose, placedPins);
const seated = await measured(() => check(CALLS, ONE_WAIVER));
const unwaived = await measured(() => check(CALLS, 0));
observer.disconnect();

const ns = (m: Measured, count: number): string => ((m.ms * 1e6) / count).toFixed(1);
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"} (${cpus().length} threads)`,
    `${BLOCKS} bored blocks and ${PINS} two-ended ridged pins, turned a quarter and moved off the origin; each check gets its pin end's one waiver, over the mated interval`,
    "",
    "| Work | Count | ms | ns each | Clear | GCs | Heap growth (bytes) |",
    "|---|---|---|---|---|---|---|",
    `| place ${PINS} pins at a pose | ${POSES.toLocaleString("en-US")} | ${placing.ms.toFixed(1)} | ${ns(placing, POSES)} | | ${placing.gcs} | ${placing.heapGrowthBytes} |`,
    `| pin end against its bore, waived | ${CALLS.toLocaleString("en-US")} | ${seated.ms.toFixed(1)} | ${ns(seated, CALLS)} | ${seated.result.toLocaleString("en-US")} | ${seated.gcs} | ${seated.heapGrowthBytes} |`,
    `| pin end against its bore, no waiver | ${CALLS.toLocaleString("en-US")} | ${unwaived.ms.toFixed(1)} | ${ns(unwaived, CALLS)} | ${unwaived.result.toLocaleString("en-US")} | ${unwaived.gcs} | ${unwaived.heapGrowthBytes} |`,
    "",
  ].join("\n"),
);

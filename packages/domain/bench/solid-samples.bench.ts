import { PerformanceObserver, performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { solidsMeetInCell, type Contact, type PlacedSolid } from "../src/solid-samples.ts";

const SAMPLES_PER_STUD = 10;
const STEPS_PER_LDU = 16;
const CELLS_PER_SIDE = 32;
const SPANS_PER_SAMPLE = 6;
const SPAN_PITCH_STEPS = 48 * STEPS_PER_LDU;
const SPAN_STEPS = 24 * STEPS_PER_LDU;
const ROUNDS = 20;
const WARMUP_ROUNDS = 2;

function interleavedFloors(): PlacedSolid {
  const list = [SPANS_PER_SAMPLE];
  for (let k = 0; k < SPANS_PER_SAMPLE; k++) {
    list.push(k * SPAN_PITCH_STEPS, k * SPAN_PITCH_STEPS + SPAN_STEPS);
  }
  return {
    samples: {
      samplesPerStud: SAMPLES_PER_STUD,
      stepsPerLdu: STEPS_PER_LDU,
      lists: Int32Array.from([0, ...list]),
      patterns: new Int32Array(SAMPLES_PER_STUD * SAMPLES_PER_STUD).fill(1),
      cells: new Int32Array(CELLS_PER_SIDE * CELLS_PER_SIDE),
    },
    cellX0: 0,
    cellZ0: 0,
    width: CELLS_PER_SIDE,
    depth: CELLS_PER_SIDE,
    x: 0,
    z: 0,
    cos: 1,
    sin: 0,
    ySteps: 0,
  };
}

const lower = interleavedFloors();
const upper: PlacedSolid = { ...interleavedFloors(), ySteps: SPAN_STEPS };
const contact: Contact = {
  xLdu: 0,
  zLdu: 0,
  bottomLdu: 0,
  topLdu: 0,
  candidateBottomLdu: 0,
  candidateTopLdu: 0,
};

function sweep(): number {
  let met = 0;
  for (let cz = 0; cz < CELLS_PER_SIDE; cz++) {
    for (let cx = 0; cx < CELLS_PER_SIDE; cx++) {
      if (solidsMeetInCell(upper, lower, cx, cz, contact)) met++;
    }
  }
  return met;
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

let met = 0;
for (let r = 0; r < WARMUP_ROUNDS; r++) met += sweep();
await new Promise((resolve) => setTimeout(resolve, 50));
const gcBefore = collections;
const start = performance.now();
for (let r = 0; r < ROUNDS; r++) met += sweep();
const elapsedMs = performance.now() - start;
await new Promise((resolve) => setTimeout(resolve, 50));
observer.disconnect();
const cells = ROUNDS * CELLS_PER_SIDE * CELLS_PER_SIDE;
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}`,
    "| cells compared | spans per sample | elapsed ms | µs per cell | ms per 32 × 32 model | cells met | GCs during run |",
    "|---|---|---|---|---|---|---|",
    `| ${cells} | ${SPANS_PER_SAMPLE} | ${elapsedMs.toFixed(1)} | ${((elapsedMs * 1000) / cells).toFixed(2)} | ${(elapsedMs / ROUNDS).toFixed(2)} | ${met} | ${collections - gcBefore} |`,
    "",
  ].join("\n"),
);

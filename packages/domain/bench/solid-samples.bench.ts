import { PerformanceObserver, performance } from "node:perf_hooks";
import { cpus } from "node:os";
import {
  PlanShell,
  solidMeetsShellInCell,
  solidsMeetInCell,
  type Contact,
  type PlacedShell,
  type PlacedSolid,
} from "../src/solid-samples.ts";

const SAMPLES_PER_STUD = 10;
const STUD_STEP_LDU = 20;
const STEPS_PER_LDU = 16;
const CELLS_PER_SIDE = 32;
const SPANS_PER_SAMPLE = 6;
const SPAN_PITCH_STEPS = 48 * STEPS_PER_LDU;
const SPAN_STEPS = 24 * STEPS_PER_LDU;
const ROUNDS = 20;
const PIECE_CELLS_LONG = 16;
const PIECE_CELLS_WIDE = 8;
const PIECE_TRIANGLES_PER_CELL = 18;
const PIECE_TOP_LDU = 10;
const PLATE_SLAB_LDU = 4;
const STUD_HEIGHT_LDU = 4;
const STUD_SAMPLES_FROM = 3;
const STUD_SAMPLES_TO = 7;
const PIECE_ROUNDS = 200;
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
    studLayerLdu: null,
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

function studdedBaseplate(studLayerLdu: number | null): PlacedSolid {
  const slab = [1, -PLATE_SLAB_LDU * STEPS_PER_LDU, 0];
  const stud = [1, -PLATE_SLAB_LDU * STEPS_PER_LDU, STUD_HEIGHT_LDU * STEPS_PER_LDU];
  const pattern: number[] = [];
  for (let j = 0; j < SAMPLES_PER_STUD; j++) {
    for (let i = 0; i < SAMPLES_PER_STUD; i++) {
      const inStud = [i, j].every((n) => n >= STUD_SAMPLES_FROM && n < STUD_SAMPLES_TO);
      pattern.push(inStud ? slab.length : 0);
    }
  }
  return {
    ...interleavedFloors(),
    samples: {
      samplesPerStud: SAMPLES_PER_STUD,
      stepsPerLdu: STEPS_PER_LDU,
      lists: Int32Array.from([...slab, ...stud]),
      patterns: Int32Array.from(pattern),
      cells: new Int32Array(CELLS_PER_SIDE * CELLS_PER_SIDE),
    },
    studLayerLdu,
  };
}

function laidPieceShell(): PlacedShell {
  const triangles: number[] = [];
  const step = STUD_STEP_LDU / PIECE_TRIANGLES_PER_CELL;
  for (let cz = 0; cz < PIECE_CELLS_WIDE; cz++) {
    for (let cx = 0; cx < PIECE_CELLS_LONG; cx++) {
      for (let k = 0; k < PIECE_TRIANGLES_PER_CELL; k++) {
        const x0 = cx * STUD_STEP_LDU + k * step;
        const z0 = cz * STUD_STEP_LDU;
        for (const y of [0, PIECE_TOP_LDU]) {
          triangles.push(x0, y, z0, x0 + step, y, z0, x0, y, z0 + STUD_STEP_LDU);
        }
      }
    }
  }
  return {
    shell: new PlanShell(Float64Array.from(triangles)),
    pose: { cos: 1, sin: 0, x: 0, z: 0 },
  };
}

const piece = laidPieceShell();

function pieceCheck(owner: PlacedSolid): number {
  let met = 0;
  for (let cz = 0; cz < PIECE_CELLS_WIDE; cz++) {
    for (let cx = 0; cx < PIECE_CELLS_LONG; cx++) {
      if (solidMeetsShellInCell(owner, piece, false, cx, cz, contact)) met++;
    }
  }
  return met;
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

async function timed(
  run: () => number,
  rounds: number,
): Promise<{ ms: number; met: number; gcs: number }> {
  let met = 0;
  for (let r = 0; r < WARMUP_ROUNDS; r++) met += run();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gcBefore = collections;
  const start = performance.now();
  for (let r = 0; r < rounds; r++) met += run();
  const ms = performance.now() - start;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { ms, met, gcs: collections - gcBefore };
}

const models = await timed(sweep, ROUNDS);
const onStuds = studdedBaseplate(0);
const asModel = studdedBaseplate(null);
const resting = await timed(() => pieceCheck(onStuds), PIECE_ROUNDS);
const sampled = await timed(() => pieceCheck(asModel), PIECE_ROUNDS);
observer.disconnect();
const cells = ROUNDS * CELLS_PER_SIDE * CELLS_PER_SIDE;
const pieceCells = PIECE_CELLS_LONG * PIECE_CELLS_WIDE;
const perPiece = (ms: number): string => ((ms * 1000) / PIECE_ROUNDS).toFixed(1);
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}`,
    "",
    "Model against model:",
    "| cells compared | spans per sample | elapsed ms | µs per cell | ms per 32 × 32 model | cells met | GCs during run |",
    "|---|---|---|---|---|---|---|",
    `| ${cells} | ${SPANS_PER_SAMPLE} | ${models.ms.toFixed(1)} | ${((models.ms * 1000) / cells).toFixed(2)} | ${(models.ms / ROUNDS).toFixed(2)} | ${models.met} | ${models.gcs} |`,
    "",
    `Laid track piece (${pieceCells} cells, ${PIECE_TRIANGLES_PER_CELL} triangles per cell) against studs under every cell:`,
    "| owner | µs per piece check | cells met | GCs during run |",
    "|---|---|---|---|",
    `| standalone baseplate, track resting on its stud layer | ${perPiece(resting.ms)} | ${resting.met} | ${resting.gcs} |`,
    `| the same studs in a model, every line sampled | ${perPiece(sampled.ms)} | ${sampled.met} | ${sampled.gcs} |`,
    "",
  ].join("\n"),
);

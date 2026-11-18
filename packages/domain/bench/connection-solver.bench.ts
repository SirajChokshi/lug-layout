import { PerformanceObserver, performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import {
  CandidatePoses,
  type LatticePose,
  type SnapWindow,
} from "../src/connect/candidate-poses.ts";
import { ConnectionSolver } from "../src/connect/connection-solver.ts";
import { pose16, zeta16 } from "@brr/math";
import type { TrackEnd } from "../src/track/end-gaps.ts";
import {
  AXIS_NEG_X,
  AXIS_NEG_Y,
  AXIS_POS_X,
  AXIS_POS_Y,
  ConnectorTable,
  GENDER_FEMALE,
  GENDER_MALE,
  SOURCE_SHADOW,
  STATUS_VERIFIED,
} from "../src/connect/connector-table.ts";
import { LatticeStudFinder } from "../src/connect/lattice-stud-finder.ts";
import { SparseConnectorFinder } from "../src/connect/sparse-connector-finder.ts";
import { TrackEndFinder } from "../src/connect/track-end-finder.ts";
import { MateReport } from "../src/connect/mate-report.ts";
import { SnapMating } from "../src/connect/mating.ts";
import { ModelConnectors } from "../src/connect/model-connectors.ts";
import { CAP_FAR, CAP_ROOT, SECTION_ROUND, SnapShapes } from "../src/connect/snap-shapes.ts";

const BASEPLATE_STUDS = 32;
const BASEPLATES_PER_SIDE = 44;
const WORLD_CELLS = BASEPLATE_STUDS * BASEPLATES_PER_SIDE;
const BRICKS = 96_400;
const BRICK_PLATES = 3;
const STUD_RADIUS = 6;
const STUD_REACH = 4;
const BRICK_CAVITY = BRICK_PLATES * PLATE_LDU - STUD_REACH;
const PLATE_CAVITY = PLATE_LDU - STUD_REACH;
const shapes = new SnapShapes();
const mating = new SnapMating(shapes);
const STUD = shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [STUD_RADIUS], [STUD_REACH]);
const PIN = shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [STUD_RADIUS], [8]);
const PIN_HOLE = shapes.intern(0, false, [SECTION_ROUND], [STUD_RADIUS], [STUD_LDU]);
const EDGE_HOLES_PER_SIDE = 4;
const EDGE_HOLE_HEIGHT = 14;
const TRACK_MODELS = 400;
function receptor(depth: number): number {
  return shapes.intern(CAP_FAR, false, [SECTION_ROUND], [STUD_RADIUS], [depth]);
}
const HALF = STUD_LDU / 2;
const HOVER_POSITIONS = 256;
const HOVER_CALLS = 2_000;
const WARMUP_CALLS = 200;
const PROBE_CALLS = 20_000;
const EDIT_CYCLES = 2_000;
const LOAD_RUNS = 20;
const TOWER_COLUMNS = 100;
const TOWER_HEIGHT = 30;
const MATRIX_FLOATS = 12;
const SEED = 0x5eed;

let state = SEED;
function random(): number {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 2 ** 32;
}

function slab(
  width: number,
  depth: number,
  height: number,
  cavity: number,
  studs: boolean,
): ConnectorTable {
  const count = width * depth * (studs ? 2 : 1);
  const shape = new Uint16Array(count);
  const gender = new Uint8Array(count);
  const origin = new Float32Array(count * 3);
  const axis = new Int8Array(count);
  const cavityShape = receptor(cavity);
  let n = 0;
  for (let layer = 0; layer < (studs ? 2 : 1); layer++) {
    const male = studs && layer === 0;
    for (let j = 0; j < depth; j++) {
      for (let i = 0; i < width; i++) {
        shape[n] = male ? STUD : cavityShape;
        gender[n] = male ? GENDER_MALE : GENDER_FEMALE;
        origin.set([i * STUD_LDU + HALF, male ? height : 0, j * STUD_LDU + HALF], n * 3);
        axis[n] = male ? AXIS_POS_Y : AXIS_NEG_Y;
        n++;
      }
    }
  }
  return new ConnectorTable(
    shape,
    gender,
    new Uint8Array(count).fill(SOURCE_SHADOW),
    new Uint8Array(count).fill(STATUS_VERIFIED),
    origin,
    axis,
    new Float32Array(count * 3),
  );
}

function baseplate(): ConnectorTable {
  const studs = BASEPLATE_STUDS * BASEPLATE_STUDS;
  const count = studs + 2 * EDGE_HOLES_PER_SIDE;
  const shape = new Uint16Array(count).fill(STUD);
  const gender = new Uint8Array(count);
  const origin = new Float32Array(count * 3);
  const axis = new Int8Array(count).fill(AXIS_POS_Y);
  for (let j = 0; j < BASEPLATE_STUDS; j++) {
    for (let i = 0; i < BASEPLATE_STUDS; i++) {
      origin.set([i * STUD_LDU + HALF, 0, j * STUD_LDU + HALF], (j * BASEPLATE_STUDS + i) * 3);
    }
  }
  for (let k = 0; k < EDGE_HOLES_PER_SIDE; k++) {
    const z = (k * 8 + 2) * STUD_LDU + HALF;
    const hole = studs + k;
    shape[hole] = PIN_HOLE;
    gender[hole] = GENDER_FEMALE;
    origin.set([0, -EDGE_HOLE_HEIGHT, z], hole * 3);
    axis[hole] = AXIS_NEG_X;
    const pin = studs + EDGE_HOLES_PER_SIDE + k;
    shape[pin] = PIN;
    gender[pin] = GENDER_MALE;
    origin.set([BASEPLATE_STUDS * STUD_LDU - STUD_LDU, -EDGE_HOLE_HEIGHT, z], pin * 3);
    axis[pin] = AXIS_POS_X;
  }
  return new ConnectorTable(
    shape,
    gender,
    new Uint8Array(count).fill(SOURCE_SHADOW),
    new Uint8Array(count).fill(STATUS_VERIFIED),
    origin,
    axis,
    new Float32Array(count * 3),
  );
}

function trackPiece(): ModelConnectors {
  const ends: TrackEnd[] = [
    { pose: pose16(zeta16([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 8), yPlates: 0 },
    { pose: pose16(zeta16([16n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0), yPlates: 0 },
  ];
  return ModelConnectors.fromParts([], { count: 0, partIndex: [], matrices: [] }, mating, ends);
}

function one(part: ConnectorTable): ModelConnectors {
  return ModelConnectors.fromParts(
    [part],
    { count: 1, partIndex: [0], matrices: Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0) },
    mating,
  );
}

function tower(brick: ConnectorTable): {
  parts: ConnectorTable[];
  matrices: Float32Array;
  count: number;
} {
  const count = TOWER_COLUMNS * TOWER_HEIGHT;
  const matrices = new Float32Array(count * MATRIX_FLOATS);
  let n = 0;
  for (let c = 0; c < TOWER_COLUMNS; c++) {
    for (let h = 0; h < TOWER_HEIGHT; h++) {
      const x = (c % 10) * 2 * STUD_LDU;
      const z = Math.floor(c / 10) * 4 * STUD_LDU;
      matrices.set(
        [1, 0, 0, x, 0, 1, 0, h * BRICK_PLATES * PLATE_LDU, 0, 0, 1, z],
        n * MATRIX_FLOATS,
      );
      n++;
    }
  }
  return { parts: [brick], matrices, count };
}

function percentile(samples: Float64Array, count: number, p: number): number {
  const sorted = samples.subarray(0, count).toSorted();
  return sorted[Math.min(count - 1, Math.floor(p * count))] ?? 0;
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

interface Timing {
  readonly p50: number;
  readonly p95: number;
  readonly gcs: number;
  readonly heapGrowthBytes: number;
}

const samples = new Float64Array(Math.max(HOVER_CALLS, EDIT_CYCLES));
const collectGarbage = (globalThis as { gc?: () => void }).gc;

function settle(): Promise<void> {
  collectGarbage?.();
  return new Promise((resolve) => setTimeout(resolve, 50));
}

async function timed(calls: number, warmup: number, run: (k: number) => void): Promise<Timing> {
  for (let k = 0; k < warmup; k++) run(k);
  await settle();
  for (let k = 0; k < calls; k++) {
    const start = performance.now();
    run(k);
    samples[k] = performance.now() - start;
  }
  for (let k = 0; k < PROBE_CALLS; k++) run(k);
  await settle();
  const gcBefore = collections;
  const heapBefore = process.memoryUsage().heapUsed;
  for (let k = 0; k < PROBE_CALLS; k++) run(k);
  const heapAfter = process.memoryUsage().heapUsed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gcs = collections - gcBefore;
  await settle();
  return {
    p50: percentile(samples, calls, 0.5),
    p95: percentile(samples, calls, 0.95),
    gcs,
    heapGrowthBytes: heapAfter - heapBefore,
  };
}

const solver = new ConnectionSolver([
  new LatticeStudFinder(mating),
  new SparseConnectorFinder(mating),
  new TrackEndFinder(),
]);
const plate = one(baseplate());
const brickPart = slab(2, 4, BRICK_PLATES * PLATE_LDU, BRICK_CAVITY, true);
const brick = one(brickPart);
const heights = new Uint16Array(WORLD_CELLS * WORLD_CELLS);

const buildStart = performance.now();
for (let bz = 0; bz < BASEPLATES_PER_SIDE; bz++) {
  for (let bx = 0; bx < BASEPLATES_PER_SIDE; bx++) {
    solver.insert(plate, {
      x: bx * BASEPLATE_STUDS * STUD_LDU,
      z: bz * BASEPLATE_STUDS * STUD_LDU,
      yPlates: 0,
      rot: 0,
    });
  }
}
for (let b = 0; b < BRICKS; b++) {
  const cx = Math.floor(random() * (WORLD_CELLS - 4));
  const cz = Math.floor(random() * (WORLD_CELLS - 4));
  let top = 0;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 2; i++) top = Math.max(top, heights[(cz + j) * WORLD_CELLS + cx + i] ?? 0);
  }
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 2; i++) heights[(cz + j) * WORLD_CELLS + cx + i] = top + BRICK_PLATES;
  }
  solver.insert(brick, { x: cx * STUD_LDU, z: cz * STUD_LDU, yPlates: top, rot: 0 });
}
const track = trackPiece();
for (let t = 0; t < TRACK_MODELS; t++) {
  solver.insert(track, {
    x: Math.floor(random() * WORLD_CELLS) * STUD_LDU,
    z: Math.floor(random() * WORLD_CELLS) * STUD_LDU,
    yPlates: 0,
    rot: Math.floor(random() * 4),
  });
}
const buildMs = performance.now() - buildStart;
const worldStuds = BASEPLATES_PER_SIDE ** 2 * BASEPLATE_STUDS ** 2 + BRICKS * 8;

const cursorX = new Int32Array(HOVER_POSITIONS);
const cursorZ = new Int32Array(HOVER_POSITIONS);
const cursorY = new Int32Array(HOVER_POSITIONS);
for (let k = 0; k < HOVER_POSITIONS; k++) {
  const cx = 64 + Math.floor(random() * (WORLD_CELLS - 192));
  const cz = 64 + Math.floor(random() * (WORLD_CELLS - 192));
  cursorX[k] = cx * STUD_LDU;
  cursorZ[k] = cz * STUD_LDU;
  cursorY[k] = heights[cz * WORLD_CELLS + cx] ?? 0;
}

class Window implements SnapWindow {
  x = 0;
  z = 0;
  yPlates = 0;
  rot = 0;
  readonly cells = 1;
  readonly plates = 1;
  readonly turns = 4;
}

class Pose implements LatticePose {
  x = 0;
  z = 0;
  yPlates = 0;
  rot = 0;
}

const window = new Window();
const best = new Pose();
const candidates = new CandidatePoses();
const report = new MateReport();
const rows: string[] = [];

function aimAt(k: number): void {
  const at = k % HOVER_POSITIONS;
  window.x = cursorX[at] ?? 0;
  window.z = cursorZ[at] ?? 0;
  window.yPlates = cursorY[at] ?? 0;
}

const hovered = [
  ["2×4 brick", brick],
  ["32×32 baseplate with 8 Technic edge connectors", plate],
  ["16-stud track piece (2 ends)", track],
  ["32×32 plate", one(slab(32, 32, PLATE_LDU, PLATE_CAVITY, true))],
  ["64×64 plate", one(slab(64, 64, PLATE_LDU, PLATE_CAVITY, true))],
] as const;

let checksum = 0;
for (const [label, piece] of hovered) {
  const rank = await timed(HOVER_CALLS, WARMUP_CALLS, (k) => {
    aimAt(k);
    solver.rank(piece, window, candidates);
    checksum += candidates.votes[0] ?? 0;
  });
  const poses = candidates.count;
  const evaluate = await timed(HOVER_CALLS, WARMUP_CALLS, (k) => {
    aimAt(k);
    best.x = window.x;
    best.z = window.z;
    best.yPlates = window.yPlates;
    solver.evaluate(piece, best, report);
    checksum += report.count;
  });
  rows.push(
    `| rank: ${label} (${piece.count.toLocaleString("en-US")} exposed connectors, ${poses} poses) | ${rank.p50.toFixed(4)} | ${rank.p95.toFixed(4)} | ${rank.gcs} | ${rank.heapGrowthBytes} |`,
    `| evaluate: ${label} at the cursor pose | ${evaluate.p50.toFixed(4)} | ${evaluate.p95.toFixed(4)} | ${evaluate.gcs} | ${evaluate.heapGrowthBytes} |`,
  );
}

const edit = new Pose();
const editCycle = await timed(EDIT_CYCLES, WARMUP_CALLS, (k) => {
  aimAt(k);
  edit.x = window.x;
  edit.z = window.z;
  edit.yPlates = window.yPlates;
  solver.insert(brick, edit);
  solver.remove(brick, edit);
});
rows.push(
  `| place + undo: insert and remove one 2×4 brick | ${editCycle.p50.toFixed(4)} | ${editCycle.p95.toFixed(4)} | ${editCycle.gcs} | ${editCycle.heapGrowthBytes} |`,
);

const big = tower(brickPart);
const loadSamples = new Float64Array(LOAD_RUNS);
let loaded: ModelConnectors | null = null;
for (let r = 0; r < LOAD_RUNS; r++) {
  const start = performance.now();
  loaded = ModelConnectors.fromParts(
    big.parts,
    { count: big.count, partIndex: new Uint16Array(big.count), matrices: big.matrices },
    mating,
  );
  loadSamples[r] = performance.now() - start;
}
observer.disconnect();

process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"} (${cpus().length} threads)`,
    `world: ${BASEPLATES_PER_SIDE ** 2} baseplates of ${BASEPLATE_STUDS}×${BASEPLATE_STUDS} (each with ${2 * EDGE_HOLES_PER_SIDE} Technic edge connectors), ${BRICKS.toLocaleString("en-US")} 2×4 bricks and ${TRACK_MODELS} track pieces = ${(BASEPLATES_PER_SIDE ** 2 + BRICKS + TRACK_MODELS).toLocaleString("en-US")} parts, ${worldStuds.toLocaleString("en-US")} studs; finders: lattice studs, sparse, track ends; index built in ${buildMs.toFixed(0)} ms`,
    `window: 3×3 cells × 3 heights × 4 turns; ${HOVER_CALLS} calls after ${WARMUP_CALLS} warm-up over ${HOVER_POSITIONS} seeded cursor positions; checksum ${checksum}`,
    "",
    `| Operation | p50 ms | p95 ms | GCs in ${PROBE_CALLS.toLocaleString("en-US")} steady-state probe calls | heap growth over those calls (bytes) |`,
    "|---|---|---|---|---|",
    ...rows,
    "",
    `load: ${big.count.toLocaleString("en-US")}-part model, ${(big.count * 16).toLocaleString("en-US")} connectors, ${loaded?.internalMates.toLocaleString("en-US") ?? 0} internal mates consumed: p50 ${percentile(loadSamples, LOAD_RUNS, 0.5).toFixed(2)} ms, p95 ${percentile(loadSamples, LOAD_RUNS, 0.95).toFixed(2)} ms`,
    "",
  ].join("\n"),
);

import { SIXTEENTHS_PER_LDU } from "@brr/math";
import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import {
  AXIS_NEG_Z,
  AXIS_POS_Z,
  CAP_ROOT,
  ConnectionSolver,
  ConnectorTable,
  GENDER_FEMALE,
  GENDER_MALE,
  LatticeStudFinder,
  MateReport,
  ModelConnectors,
  SECTION_ROUND,
  SOURCE_SHADOW,
  STATUS_VERIFIED,
  SnapMating,
  SnapShapes,
  SparseConnectorFinder,
  TrackEndFinder,
  modelTechnic,
  placeTechnicInto,
  technicScratch,
  type LatticePose,
  type OverlapHit,
} from "@brr/domain";
import type { PartTechnic } from "@brr/schema/bundle";
import { MateZones, type PlacedParts } from "../src/connect/mate-zones.ts";
import { partBoxes } from "../src/connect/part-boxes.ts";

const STUD = 20;
const BRICK = 24;
const STEPS = 16;
const WIDE = 8 * STEPS;
const BORE = 6 * STEPS;
const LINE_Y = 14;
const PINS = 16;
const PITCH = 2 * STUD;
const FILLERS = 400;
const CALLS = 20_000;
const WARMUP_CALLS = 2_000;
const PROBE_CALLS = 20_000;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

const shapes = new SnapShapes();
const mating = new SnapMating(shapes);
const solver = new ConnectionSolver([
  new LatticeStudFinder(mating),
  new SparseConnectorFinder(mating),
  new TrackEndFinder(),
]);
const boreEnd = shapes.intern(
  0,
  false,
  [SECTION_ROUND, SECTION_ROUND, SECTION_ROUND],
  [8, 6, 8],
  [2, 16, 2],
);
const pinEnd = shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [6], [STUD]);

function table(
  rows: ReadonlyArray<readonly [number, number, number, number, number, number]>,
): ConnectorTable {
  return new ConnectorTable(
    Uint16Array.from(rows, ([shape]) => shape),
    Uint8Array.from(rows, ([, gender]) => gender),
    new Uint8Array(rows.length).fill(SOURCE_SHADOW),
    new Uint8Array(rows.length).fill(STATUS_VERIFIED),
    Int32Array.from(
      rows.flatMap(([, , x, y, z]) => [x, y, z]),
      (ldu) => ldu * SIXTEENTHS_PER_LDU,
    ),
    Int8Array.from(rows, ([, , , , , axis]) => axis),
    new Float64Array(rows.length * 3),
    new Uint16Array(rows.length),
    new Float64Array(rows.length * 3),
    [],
  );
}

const bored: PartTechnic = {
  stepsPerLdu: STEPS,
  holes: [
    {
      axis: 2,
      at: [STUD, LINE_Y],
      from: 0,
      radii: [WIDE, WIDE, ...Array.from({ length: 16 }, () => BORE), WIDE, WIDE],
    },
  ],
  shaft: null,
};
const pin: PartTechnic = {
  stepsPerLdu: STEPS,
  holes: [],
  shaft: {
    axis: 2,
    at: [STUD, LINE_Y],
    components: [
      { from: 0, radii: [WIDE, WIDE, ...Array.from({ length: 18 }, () => BORE + 4)], pin: null },
    ],
  },
};
const blockTable = table([
  [boreEnd, GENDER_FEMALE, STUD, LINE_Y, 0, AXIS_NEG_Z],
  [boreEnd, GENDER_FEMALE, STUD, LINE_Y, STUD, AXIS_POS_Z],
]);
const pinTable = table([[pinEnd, GENDER_MALE, STUD, LINE_Y, 0, AXIS_POS_Z]]);

function translated(x: number, z: number): number[] {
  const matrix = [...IDENTITY];
  matrix[3] = x;
  matrix[11] = z;
  return matrix;
}

const placed = new Map<number, PlacedParts>();
const origin: LatticePose = { x: 0, z: 0, yPlates: 0, rot: 0 };
for (let p = 0; p < PINS; p++) {
  const instances = {
    count: 1,
    partIndex: [0],
    matrices: Float64Array.from(translated(p * PITCH, 0)),
  };
  const boxes = partBoxes([p * PITCH, 0, 0, p * PITCH + 2 * STUD, BRICK, STUD]);
  const local = modelTechnic([bored], instances, boxes.boxes);
  const technic = technicScratch(local);
  placeTechnicInto(local, origin, technic);
  solver.insert(ModelConnectors.fromParts([blockTable], instances, mating), origin, p);
  placed.set(p, { boxes, technic, pose: origin });
}

const parts = PINS + FILLERS;
const partIndex = Array.from({ length: parts }, (_, i) => (i < PINS ? 0 : 1));
const matrices = Float64Array.from(
  Array.from({ length: parts }, (_, i) =>
    i < PINS ? translated(i * PITCH, 0) : translated((i % PINS) * PITCH, -STUD * (2 + (i % 7))),
  ).flat(),
);
const measured = Array.from({ length: parts }, (_, i) =>
  i < PINS
    ? [i * PITCH + STUD - 8, LINE_Y - 8, 0, i * PITCH + STUD + 8, LINE_Y + 8, STUD]
    : [
        (i % PINS) * PITCH,
        0,
        -STUD * (3 + (i % 7)),
        (i % PINS) * PITCH + 2 * STUD,
        BRICK,
        -STUD * (2 + (i % 7)),
      ],
).flat();
const instances = { count: parts, partIndex, matrices };
const candidateBoxes = partBoxes(measured);
const candidateTechnic = modelTechnic([pin, null], instances, candidateBoxes.boxes);
const candidate = ModelConnectors.fromParts([pinTable, null], instances, mating);
const report = new MateReport();
const zones = new MateZones();
const hit: OverlapHit = {
  owner: 0,
  bottomLdu: 0,
  topLdu: 0,
  cellX: 0,
  cellZ: 0,
  candidateBottomLdu: 0,
  candidateTopLdu: 0,
};

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });
const collectGarbage = (globalThis as { gc?: () => void }).gc;
const samples = new Float64Array(CALLS);
let clear = 0;

function hover(): void {
  solver.evaluate(candidate, origin, report);
  zones.collect(report, candidateBoxes, candidateTechnic, origin, placed);
  for (let p = 0; p < PINS; p++) {
    zones.exempts(p, (p * PITCH) / STUD, 0);
    zones.exempts(p, (p * PITCH) / STUD + 1, 0);
  }
  if (!zones.firstOverlap(hit)) clear++;
}

function settle(): Promise<void> {
  collectGarbage?.();
  return new Promise((resolve) => setTimeout(resolve, 50));
}

for (let k = 0; k < WARMUP_CALLS; k++) hover();
await settle();
for (let k = 0; k < CALLS; k++) {
  const start = performance.now();
  hover();
  samples[k] = performance.now() - start;
}
for (let k = 0; k < PROBE_CALLS; k++) hover();
await settle();
const gcBefore = collections;
const heapBefore = process.memoryUsage().heapUsed;
for (let k = 0; k < PROBE_CALLS; k++) hover();
const heapAfter = process.memoryUsage().heapUsed;
await new Promise((resolve) => setTimeout(resolve, 50));
const gcs = collections - gcBefore;
observer.disconnect();

const sorted = samples.toSorted();
const percentile = (p: number): number => sorted[Math.min(CALLS - 1, Math.floor(p * CALLS))] ?? 0;
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"} (${cpus().length} threads)`,
    `${PINS} placed bored blocks, each its own placement; a ${parts}-part candidate whose ${PINS} ridged pins mate those bores (${report.count} mates) plus ${FILLERS} other parts`,
    "",
    `| Work per blocked candidate pose | p50 ms | p95 ms | clear | GCs in ${PROBE_CALLS.toLocaleString("en-US")} probe calls | heap growth (bytes) |`,
    "|---|---|---|---|---|---|",
    `| evaluate, collect ${PINS} zones, exempt ${2 * PINS} cells, check them part by part | ${percentile(0.5).toFixed(4)} | ${percentile(0.95).toFixed(4)} | ${clear > 0 ? "yes" : "no"} | ${gcs} | ${heapAfter - heapBefore} |`,
    "",
  ].join("\n"),
);

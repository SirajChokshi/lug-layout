import { SIXTEENTHS_PER_LDU, exactRationalFromFloat64 } from "@brr/math";
import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import type { PartRolling } from "@brr/schema/bundle";
import {
  AXIS_NEG_Y,
  AXIS_POS_X,
  AXIS_POS_Y,
  AXIS_POS_Z,
  ConnectorTable,
  GENDER_FEMALE,
  GENDER_MALE,
  SOURCE_SHADOW,
  STATUS_VERIFIED,
} from "../src/connect/connector-table.ts";
import { SnapMating } from "../src/connect/mating.ts";
import { CAP_FAR, CAP_ROOT, SECTION_ROUND, SnapShapes } from "../src/connect/snap-shapes.ts";
import { MODEL_ROOT, type PartInstances } from "../src/connect/submodel-frames.ts";
import { MATE_PASS_MODEL, MATE_PASS_SUBMODEL, MatePairs } from "../src/connect/mate-pairs.ts";
import { BogieDetector } from "../src/running-gear/bogie-detector.ts";
import { measuredRail } from "../src/running-gear/measured-rail.ts";
import type { PartExtents } from "../src/running-gear/part-extents.ts";
import { PartRollingTable } from "../src/running-gear/part-rolling.ts";
import { RunningGearDetector } from "../src/running-gear/running-gear-detector.ts";
import { WheelsetDetector } from "../src/running-gear/wheelset-detector.ts";

const BODY_PARTS = 2_500;
const CONNECTORS_PER_PART = 20;
const CARS = 125;
const BOGIES_PER_CAR = 2;
const AXLES_PER_BOGIE = 2;
const RUNS = 9;
const SIXTEENTHS = 16;

const shapes = new SnapShapes();
const mating = new SnapMating(shapes);
const PIN = shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [4], [8]);
const HOLE = shapes.intern(CAP_FAR, false, [SECTION_ROUND], [4], [8]);
const EXTRA_HUBS_PER_AXLE = 3;
const HANGING_GROUPS = 1_500;
const CLEARANCE_BRICKS = 3_000;
const CLEARANCE_CAR_ORIGIN = [0.11, 0.6667, 0.07] as const;
const HANGER_SPACING_LDU = 4;
const OUTSIDE_WHEELBASE_LDU = 40;
const rails = [
  measuredRail([
    { from: "-53.625", to: "-47.375" },
    { from: "47.375", to: "53.625" },
  ]),
  measuredRail([
    { from: "-53.1", to: "-46.9" },
    { from: "46.9", to: "53.1" },
  ]),
];

function table(
  specs: ReadonlyArray<readonly [number, number, number, number, number]>,
): ConnectorTable {
  return new ConnectorTable(
    Uint16Array.from(specs, (s) => (s[4] === GENDER_MALE ? PIN : HOLE)),
    Uint8Array.from(specs, (s) => s[4]),
    Uint8Array.from(specs, () => SOURCE_SHADOW),
    Uint8Array.from(specs, () => STATUS_VERIFIED),
    Int32Array.from(
      specs.flatMap((s) => [s[0], s[1], s[2]]),
      (ldu) => ldu * SIXTEENTHS_PER_LDU,
    ),
    Int8Array.from(specs, (s) => s[3]),
    new Float64Array(specs.length * 3),
    new Uint16Array(specs.length),
    new Float64Array(specs.length * 3),
    [],
  );
}

function band(from: number, to: number, radius: number) {
  return {
    source: "measured" as const,
    axis: 2 as const,
    at: [0, 0] as [number, number],
    from: from * SIXTEENTHS,
    to: to * SIXTEENTHS,
    radii: [radius * SIXTEENTHS, radius * SIXTEENTHS] as [number, number],
  };
}

function wheelPair(shift: number): PartRolling {
  return {
    stepsPerLdu: 16,
    surfaces: [
      band(44 + shift, 54 + shift, 7),
      band(-54 + shift, -44 + shift, 7),
      band(42 + shift, 44 + shift, 8.75),
      band(-44 + shift, -42 + shift, 8.75),
    ],
    unread: [],
  };
}

const HUB: PartRolling = { stepsPerLdu: 16, surfaces: [band(-8, 8, 3)], unread: [] };
const HUBS: PartRolling = {
  stepsPerLdu: 16,
  surfaces: [
    band(-8, 8, 3),
    ...Array.from({ length: EXTRA_HUBS_PER_AXLE }, (_, k) => band(-30 + k * 8, -24 + k * 8, 2)),
  ],
  unread: [],
};
const BRICK = table(
  Array.from({ length: CONNECTORS_PER_PART }, (_, k) => [
    (k % 10) * 20 - 90,
    k < 10 ? 12 : -12,
    0,
    k < 10 ? AXIS_POS_Y : AXIS_NEG_Y,
    k < 10 ? GENDER_MALE : GENDER_FEMALE,
  ]),
);
const FRAME = table([
  [0, 10, 0, AXIS_POS_Y, GENDER_FEMALE],
  [-20, -13, 0, AXIS_POS_Z, GENDER_FEMALE],
  [20, -13, 0, AXIS_POS_Z, GENDER_FEMALE],
]);
const AXLE = table([[0, 0, 0, AXIS_POS_Z, GENDER_MALE]]);
const HANGER_FRAME = table([
  [0, 10, 0, AXIS_POS_Y, GENDER_FEMALE],
  [-20, -13, 0, AXIS_POS_Z, GENDER_FEMALE],
  [20, -13, 0, AXIS_POS_Z, GENDER_FEMALE],
  ...Array.from(
    { length: HANGING_GROUPS },
    (_, k): readonly [number, number, number, number, number] => [
      OUTSIDE_WHEELBASE_LDU + k * HANGER_SPACING_LDU,
      10,
      0,
      AXIS_POS_Y,
      GENDER_FEMALE,
    ],
  ),
]);
const HANGER = table([[0, -4, 0, AXIS_NEG_Y, GENDER_MALE]]);
const FIRST_HANGER_HOLE = 3;
const PIN_BODY = table([
  [60, 0, 0, AXIS_NEG_Y, GENDER_MALE],
  [-60, 0, 0, AXIS_NEG_Y, GENDER_MALE],
  [100, 0, 0, AXIS_POS_X, GENDER_MALE],
]);

interface Synthetic {
  readonly instances: PartInstances;
  readonly mates: Array<readonly [number, number, number, number, number]>;
}

function build(hanging: boolean): Synthetic {
  const parts: number[] = [];
  const matrices: number[] = [];
  const ofPart: number[] = [];
  const parent: number[] = [];
  const submodelMatrices: number[] = [];
  const mates: Array<readonly [number, number, number, number, number]> = [];
  const place = (
    part: number,
    x: number,
    y: number,
    z: number,
    submodel: number,
    world: readonly [number, number, number],
  ): number => {
    parts.push(part);
    matrices.push(1, 0, 0, world[0] + x, 0, 1, 0, world[1] + y, 0, 0, 1, world[2] + z);
    ofPart.push(submodel);
    return parts.length - 1;
  };
  const submodel = (
    parentIndex: number,
    x: number,
    y: number,
    z: number,
    base: readonly [number, number, number],
  ): number => {
    parent.push(parentIndex);
    submodelMatrices.push(1, 0, 0, base[0] + x, 0, 1, 0, base[1] + y, 0, 0, 1, base[2] + z);
    return parent.length - 1;
  };
  for (let b = 0; b < BODY_PARTS; b++) {
    const at = place(0, (b % 50) * 200, 100 + Math.floor(b / 50) * 24, 400, MODEL_ROOT, [0, 0, 0]);
    if (b > 0) {
      mates.push([at, 0, at - 1, 10, MATE_PASS_MODEL]);
      mates.push([at, 1, at - 1, 11, MATE_PASS_MODEL]);
    }
  }
  for (let c = 0; c < CARS; c++) {
    const carOrigin: readonly [number, number, number] = [c * 300 + 0.11, 0.6667, 0.07];
    const car = submodel(MODEL_ROOT, carOrigin[0], carOrigin[1], carOrigin[2], [0, 0, 0]);
    const body = place(1, 0, 30, 0, car, carOrigin);
    for (let g = 0; g < BOGIES_PER_CAR; g++) {
      const x = g === 0 ? 60 : -60;
      const bogieOrigin: readonly [number, number, number] = [
        carOrigin[0] + x,
        carOrigin[1],
        carOrigin[2],
      ];
      const bogieFrame = submodel(car, x, 0, 0, carOrigin);
      const frame = place(hanging ? 5 : 2, 0, 20, 0, bogieFrame, bogieOrigin);
      mates.push([body, g, frame, 0, MATE_PASS_SUBMODEL]);
      const hangers = !hanging ? 0 : c === 0 && g === 0 ? HANGING_GROUPS : 1;
      for (let k = 0; k < hangers; k++) {
        const hanger = place(
          6,
          OUTSIDE_WHEELBASE_LDU + k * HANGER_SPACING_LDU,
          34,
          0,
          bogieFrame,
          bogieOrigin,
        );
        mates.push([hanger, 0, frame, FIRST_HANGER_HOLE + k, MATE_PASS_SUBMODEL]);
      }
      for (let a = 0; a < AXLES_PER_BOGIE; a++) {
        const ax = a === 0 ? -20 : 20;
        const wheels = place(3, ax, 7, 0, bogieFrame, bogieOrigin);
        const hub = place(4, ax, 7, 0, bogieFrame, bogieOrigin);
        mates.push([wheels, 0, frame, 1 + a, MATE_PASS_SUBMODEL]);
        mates.push([hub, 0, frame, 1 + a, MATE_PASS_SUBMODEL]);
      }
    }
  }
  return {
    instances: {
      count: parts.length,
      partIndex: Uint32Array.from(parts),
      matrices: Float64Array.from(matrices),
      submodels: {
        count: parent.length,
        parent: Int32Array.from(parent),
        matrices: Float64Array.from(submodelMatrices),
        ofPart: Int32Array.from(ofPart),
      },
    },
    mates,
  };
}

function clearanceCar(): Synthetic {
  const parts: number[] = [];
  const matrices: number[] = [];
  const ofPart: number[] = [];
  const mates: Array<readonly [number, number, number, number, number]> = [];
  const car = 0;
  const bogieFrames = [1, 2];
  const [ox, oy, oz] = CLEARANCE_CAR_ORIGIN;
  const frameAt = (x: number) => [1, 0, 0, ox + x, 0, 1, 0, oy, 0, 0, 1, oz];
  const place = (part: number, x: number, y: number, z: number, submodel: number): number => {
    parts.push(part);
    matrices.push(1, 0, 0, ox + x, 0, 1, 0, oy + y, 0, 0, 1, oz + z);
    ofPart.push(submodel);
    return parts.length - 1;
  };
  const body = place(1, 0, 30, 0, car);
  for (let b = 0; b < CLEARANCE_BRICKS; b++) {
    const at = place(0, (b % 50) * 200, 100 + Math.floor(b / 50) * 24, 0, car);
    if (b === 0) mates.push([body, 2, at, 10, MATE_PASS_MODEL]);
    else {
      mates.push([at, 0, at - 1, 10, MATE_PASS_MODEL]);
      mates.push([at, 1, at - 1, 11, MATE_PASS_MODEL]);
    }
  }
  bogieFrames.forEach((bogieFrame, g) => {
    const x = g === 0 ? 60 : -60;
    const frame = place(2, x, 20, 0, bogieFrame);
    mates.push([body, g, frame, 0, MATE_PASS_SUBMODEL]);
    for (let a = 0; a < AXLES_PER_BOGIE; a++) {
      const ax = x + (a === 0 ? -20 : 20);
      mates.push([place(3, ax, 7, 0, bogieFrame), 0, frame, 1 + a, MATE_PASS_SUBMODEL]);
      mates.push([place(4, ax, 7, 0, bogieFrame), 0, frame, 1 + a, MATE_PASS_SUBMODEL]);
    }
  });
  return {
    instances: {
      count: parts.length,
      partIndex: Uint32Array.from(parts),
      matrices: Float64Array.from(matrices),
      submodels: {
        count: 3,
        parent: Int32Array.of(MODEL_ROOT, car, car),
        matrices: Float64Array.of(...frameAt(0), ...frameAt(60), ...frameAt(-60)),
        ofPart: Int32Array.from(ofPart),
      },
    },
    mates,
  };
}

function exactTriple(v: readonly number[]) {
  return [
    exactRationalFromFloat64(v[0] ?? 0),
    exactRationalFromFloat64(v[1] ?? 0),
    exactRationalFromFloat64(v[2] ?? 0),
  ] as const;
}

function boxExtents(min: readonly number[], max: readonly number[]): PartExtents {
  return { min: exactTriple(min), max: exactTriple(max) };
}

function percentile(samples: ReadonlyArray<number>, p: number): number {
  const sorted = samples.toSorted((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

let collections = 0;
new PerformanceObserver((list) => {
  collections += list.getEntries().length;
}).observe({ entryTypes: ["gc"] });
const collectGarbage = (globalThis as { gc?: () => void }).gc;

interface Timing {
  readonly p50: number;
  readonly p95: number;
  readonly gcs: number;
  readonly heapGrowthBytes: number;
}

function settle(): Promise<void> {
  collectGarbage?.();
  return new Promise((resolve) => setTimeout(resolve, 50));
}

async function time(run: () => unknown): Promise<Timing> {
  run();
  await settle();
  const samples: number[] = [];
  const gcBefore = collections;
  const heapBefore = process.memoryUsage().heapUsed;
  for (let r = 0; r < RUNS; r++) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  const heapAfter = process.memoryUsage().heapUsed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gcs = collections - gcBefore;
  await settle();
  return {
    p50: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
    gcs,
    heapGrowthBytes: heapAfter - heapBefore,
  };
}

const connectorTables = [BRICK, PIN_BODY, FRAME, AXLE, AXLE, HANGER_FRAME, HANGER];

function matePairs(synthetic: Synthetic): MatePairs {
  const { instances: placed, mates: rows } = synthetic;
  return new MatePairs(
    Uint32Array.from(rows, (m) => m[0]),
    Uint32Array.from(rows, (m) => m[2]),
    Uint32Array.from(rows, (m) => m[1]),
    Uint32Array.from(rows, (m) => m[3]),
    Uint8Array.from(rows, (m) => m[4]),
    Int8Array.from(rows, (m) => connectorTables[placed.partIndex[m[0]] ?? 0]?.axis[m[1]] ?? 0),
    Int32Array.from(rows, () => mating.offsets(PIN, HOLE)[0] ?? 0),
  );
}

const noExtents = connectorTables.map(() => null);
const { instances, mates } = build(false);
const graph = matePairs({ instances, mates });
const hangingModel = build(true);
const hangingGraph = matePairs(hangingModel);
const onRails = [null, null, null, wheelPair(0), HUB, null, null].map((r) =>
  r ? PartRollingTable.fromRolling(r) : null,
);
const moreHubs = [null, null, null, wheelPair(0), HUBS, null, null].map((r) =>
  r ? PartRollingTable.fromRolling(r) : null,
);
const surfaces = CARS * BOGIES_PER_CAR * AXLES_PER_BOGIE * 4;
const hubs = CARS * BOGIES_PER_CAR * AXLES_PER_BOGIE;
const connectorCount = BODY_PARTS * CONNECTORS_PER_PART;
const exposed = {
  count: connectorCount,
  instance: Uint32Array.from({ length: connectorCount }, (_, k) =>
    Math.floor(k / CONNECTORS_PER_PART),
  ),
  connector: Uint32Array.from({ length: connectorCount }, (_, k) => k % CONNECTORS_PER_PART),

  axis: Int8Array.from({ length: connectorCount }, (_, k) =>
    k % CONNECTORS_PER_PART < 10 ? AXIS_POS_Y : AXIS_NEG_Y,
  ),
  origin: new Int32Array(connectorCount * 3),
  reach: new Float32Array(connectorCount).fill(shapes.length(PIN)),
};
const wheelsets = new WheelsetDetector(rails);
const gear = new RunningGearDetector(wheelsets, new BogieDetector(mating));
const found = wheelsets.detect(instances, onRails);
const resolved = gear.detect({
  instances,
  rolling: onRails,
  extents: noExtents,
  connectors: connectorTables,
  mates: graph,
  exposed,
});
const baseline = await time(() => wheelsets.detect(instances, onRails));
const largerGroups = await time(() => wheelsets.detect(instances, moreHubs));
const whole = await time(() =>
  gear.detect({
    instances,
    rolling: onRails,
    extents: noExtents,
    connectors: connectorTables,
    mates: graph,
    exposed,
  }),
);
const hangingInput = {
  instances: hangingModel.instances,
  rolling: onRails,
  extents: noExtents,
  connectors: connectorTables,
  mates: hangingGraph,
  exposed,
};
const hangingResolved = gear.detect(hangingInput);
const hangingBogies = hangingResolved.vehicles.flatMap((vehicle) => vehicle.bogies);
const credited =
  hangingBogies.reduce((n, bogie) => n + bogie.instances.length, 0) -
  hangingBogies.length * (1 + 2 * AXLES_PER_BOGIE);
const partition = await time(() => gear.detect(hangingInput));
const clearanceModel = clearanceCar();
const clearanceInput = {
  instances: clearanceModel.instances,
  rolling: onRails,
  extents: [
    boxExtents([-100, -12, -10], [100, 12, 10]),
    boxExtents([-100, -10, -60], [100, 10, 60]),
    boxExtents([-30, -10, -40], [30, 10, 40]),
    null,
    null,
    null,
    null,
  ],
  connectors: connectorTables,
  mates: matePairs(clearanceModel),
  exposed: { ...exposed, count: 0 },
};
const clearanceResolved = gear.detect(clearanceInput);
const clearanceSeated = clearanceResolved.vehicles.flatMap((vehicle) =>
  vehicle.wheelsets.filter((wheelset) => wheelset.seated),
).length;
const checked = await time(() => gear.detect(clearanceInput));
const unchecked = await time(() => gear.detect({ ...clearanceInput, extents: noExtents }));
const row = (label: string, t: Timing): string =>
  `| ${label} | ${t.p50.toFixed(2)} | ${t.p95.toFixed(2)} | ${t.gcs} | ${t.heapGrowthBytes} |`;
process.stdout.write(
  [
    `running gear, cold path (${cpus()[0]?.model ?? "unknown cpu"}, Node ${process.version}, ${RUNS} runs after one warm-up; GCs and heap growth over those runs)`,
    `model: ${instances.count.toLocaleString("en-US")} instances, ${connectorCount.toLocaleString("en-US")} exposed connectors, ${mates.length.toLocaleString("en-US")} internal mates, ${instances.submodels?.count ?? 0} sub-model instances (car and bogie frames, placed off the grid like the official trains), ${surfaces.toLocaleString("en-US")} wheel surfaces plus ${hubs} co-linear non-member hubs`,
    `found: ${found.wheelsets.length} wheelsets, ${resolved.vehicles.length} vehicles, ${resolved.unresolvedRunningGear.length} unresolved`,
    `partition model: ${hangingModel.instances.count.toLocaleString("en-US")} instances, ${HANGING_GROUPS.toLocaleString("en-US")} wheel-free groups hanging from one bogie outside its wheelbase and one outboard pendant on every other bogie; found ${hangingResolved.vehicles.length} vehicles, ${hangingBogies.length} bogies, ${credited.toLocaleString("en-US")} pendants credited`,
    `clearance model: ${clearanceModel.instances.count.toLocaleString("en-US")} instances in one car on ${clearanceSeated} seated wheelsets; found ${clearanceResolved.vehicles.length} vehicles, ${clearanceResolved.unresolvedRunningGear.length} unresolved`,
    "| step | p50 ms | p95 ms | GCs | heap growth bytes |",
    "|---|---|---|---|---|",
    row("WheelsetDetector.detect: pairing and membership, 5 surfaces per axle line", baseline),
    row(
      `WheelsetDetector.detect: ${EXTRA_HUBS_PER_AXLE} more co-linear non-member surfaces per axle line`,
      largerGroups,
    ),
    row("RunningGearDetector.detect, whole model", whole),
    row("RunningGearDetector.detect, partition model with the block-cut pass", partition),
    row("RunningGearDetector.detect, clearance model, every instance's extents checked", checked),
    row("RunningGearDetector.detect, clearance model, no extents (no clearance work)", unchecked),
    "",
  ].join("\n"),
);

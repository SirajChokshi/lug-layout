import {
  NO_SWITCH,
  TrackGraph,
  TrackLayout,
  backwardEdge,
  buildSimTrack,
  forwardEdge,
  simTrackFromGraph,
  type SimPathSegment,
  type SimRoute,
  type SimTrack,
  type VehicleGeometry,
} from "@brr/domain";
import { HALF_TURN_16, pose16, POSE16_IDENTITY, STUD_LDU, ZETA16_ORDER, zeta16 } from "@brr/math";
import { spawnSync } from "node:child_process";
import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { getHeapSpaceStatistics } from "node:v8";
import { createSimSession } from "../src/create-sim-session.ts";
import type { SimTrainLoad } from "../src/sim-session.ts";
import { SIM_TICK_HZ, type Simulation, type TrainSpec } from "../src/simulation.ts";

const RING_PIECES = 64;
const RADIUS_LDU = 4000;
const TICKS = 600_000;
const WARMUP_TRAIN_TICKS = 600_000;
const TRAIN_COUNTS = [1, 3, 10, 100] as const;
const SWEEP = (2 * Math.PI) / RING_PIECES;
const BLOCK_TICKS = 300_000;
const BLOCK_WARMUP_TRAIN_TICKS = 300_000;
const PROBE_TICKS = 1;
const PROBE_WARMUP_WINDOWS = 3;
const PROBE_WARMUP_TICKS = 10_000;
const BLOCK_TRAIN_COUNTS = [1, 3, 10] as const;
const LOOP_CURVE_RADIUS_STUDS = 100n;
const LOOP_STRAIGHT_STUDS = 20n;
const LOOP_STRAIGHTS_PER_CURVE = 3;
const STRAIGHT_PIECE = 0;
const CURVE_PIECE = 1;
const AUTOPILOT_SEED = 1;
const YOUNG_GENERATION_SPACES: ReadonlyArray<string> = ["new_space", "new_large_object_space"];
const MICROSECONDS_PER_MS = 1000;
const TRAIN: TrainSpec = {
  vehicles: [{ lengthLdu: 690, frontBogieLdu: 175, rearBogieLdu: 515 }],
  maxSpeedLduPerS: 400,
  accelerationLduPerS2: 150,
  brakingLduPerS2: 300,
};
const BOGIE_CAR: VehicleGeometry = {
  front: {
    pivotXLdu: 180.5,
    pivotZLdu: 0,
    leadAxleXLdu: 240.25,
    trailAxleXLdu: 120.75,
    axleZLdu: 0,
    pivots: true,
  },
  rear: {
    pivotXLdu: -180.5,
    pivotZLdu: 0,
    leadAxleXLdu: -120.75,
    trailAxleXLdu: -240.25,
    axleZLdu: 0,
    pivots: true,
  },
  frontCoupler: { xLdu: 353.125, zLdu: 0, mount: "frontBogie" },
  rearCoupler: { xLdu: -353.125, zLdu: 0, mount: "rearBogie" },
};
const BOGIE_CAR_SPEC = {
  lengthLdu: BOGIE_CAR.frontCoupler.xLdu - BOGIE_CAR.rearCoupler.xLdu,
  frontBogieLdu: BOGIE_CAR.frontCoupler.xLdu - BOGIE_CAR.front.pivotXLdu,
  rearBogieLdu: BOGIE_CAR.frontCoupler.xLdu - BOGIE_CAR.rear.pivotXLdu,
  geometry: BOGIE_CAR,
};
const COUPLED_TRAIN: TrainSpec = {
  vehicles: [BOGIE_CAR_SPEC, BOGIE_CAR_SPEC],
  maxSpeedLduPerS: 397.5,
  accelerationLduPerS2: 150.5,
  brakingLduPerS2: 300.25,
};
const CONSISTS: ReadonlyArray<readonly [string, TrainSpec]> = [
  ["one car", TRAIN],
  ["two coupled bogie cars", COUPLED_TRAIN],
];

interface RowSpec {
  readonly blocks: boolean;
  readonly trains: number;
  readonly consist: number;
}

interface Measured {
  readonly elapsedMs: number;
  readonly collections: number;
  readonly allocatedBytes: number;
}

function ring(): SimTrack {
  const routes: SimRoute[] = [];
  for (let i = 0; i < RING_PIECES; i++) {
    const a = i * SWEEP;
    const b = a + SWEEP;
    routes.push({
      from: { x: RADIUS_LDU * Math.sin(a), z: -RADIUS_LDU * Math.cos(a), heading: a },
      to: { x: RADIUS_LDU * Math.sin(b), z: -RADIUS_LDU * Math.cos(b), heading: b },
      segments: [{ kind: "arc", radiusLdu: RADIUS_LDU, sweepRadians: SWEEP }],
    });
  }
  const successors: number[][] = [];
  for (let r = 0; r < RING_PIECES; r++) {
    successors.push(
      [forwardEdge((r + 1) % RING_PIECES)],
      [backwardEdge((r + RING_PIECES - 1) % RING_PIECES)],
    );
  }
  return buildSimTrack({
    routes,
    successors,
    switchOfEdge: successors.map(() => NO_SWITCH),
    switchCount: 0,
  }).track;
}

function blockLoop(): { readonly graph: TrackGraph; readonly track: SimTrack } {
  const r = LOOP_CURVE_RADIUS_STUDS;
  const entry = pose16(POSE16_IDENTITY.position, HALF_TURN_16);
  const layout = new TrackLayout([
    {
      connectors: [entry, pose16(zeta16([LOOP_STRAIGHT_STUDS, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 0)],
      routes: [{ from: 0, to: 1 }],
    },
    {
      connectors: [entry, pose16(zeta16([0n, 0n, 0n, 0n, r, -r, 0n, 0n]), 1)],
      routes: [{ from: 0, to: 1 }],
    },
  ]);
  const straight: SimPathSegment = {
    kind: "straight",
    lengthLdu: Number(LOOP_STRAIGHT_STUDS) * STUD_LDU,
  };
  const curve: SimPathSegment = {
    kind: "arc",
    radiusLdu: Number(r) * STUD_LDU,
    sweepRadians: (2 * Math.PI) / ZETA16_ORDER,
  };
  const segments: SimPathSegment[][] = [];
  let last = -1;
  for (let turn = 0; turn < ZETA16_ORDER; turn++) {
    last =
      last < 0
        ? layout.place(CURVE_PIECE, POSE16_IDENTITY, 0)
        : layout.attach(CURVE_PIECE, 0, { placement: last, connector: 1 });
    segments.push([curve]);
    for (let s = 0; s < LOOP_STRAIGHTS_PER_CURVE; s++) {
      last = layout.attach(STRAIGHT_PIECE, 0, { placement: last, connector: 1 });
      segments.push([straight]);
    }
  }
  const graph = TrackGraph.of(layout);
  for (let edge = 0; edge < graph.edgeCount; edge++) {
    if (graph.successorStart[edge] === graph.successorStart[edge + 1]) {
      throw new Error(`the bench loop leaves directed edge ${edge} open`);
    }
  }
  return { graph, track: simTrackFromGraph(graph, segments).track };
}

function youngGenerationBytes(): number {
  let bytes = 0;
  for (const space of getHeapSpaceStatistics()) {
    if (YOUNG_GENERATION_SPACES.includes(space.space_name)) bytes += space.space_used_size;
  }
  return bytes;
}

function run(sim: Simulation, ticks: number): void {
  for (let i = 0; i < ticks; i++) sim.step();
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

function spacedTrains(spec: TrainSpec, trains: number, pieces: number): SimTrainLoad[] {
  return Array.from({ length: trains }, (_, t) => ({
    spec,
    placement: { edge: forwardEdge(Math.floor((t * pieces) / trains)), offsetLdu: 0 },
  }));
}

function freeSimulation(trains: number): Simulation {
  const sim = createSimSession({
    track: ring(),
    capacity: { trains, vehicles: trains },
    trains: spacedTrains(TRAIN, trains, RING_PIECES),
  }).simulation;
  for (let t = 0; t < trains; t++) sim.setThrottle(t, TRAIN.maxSpeedLduPerS);
  return sim;
}

function blockSimulation(trains: number, spec: TrainSpec): Simulation {
  const loop = blockLoop();
  const sim = createSimSession({
    track: loop.track,
    capacity: { trains, vehicles: trains * spec.vehicles.length },
    trains: spacedTrains(spec, trains, loop.graph.placementCount),
    railway: { topology: loop.graph, autopilotSeed: AUTOPILOT_SEED },
  }).simulation;
  for (let t = 0; t < trains; t++) sim.setThrottle(t, spec.maxSpeedLduPerS);
  return sim;
}

interface TimedWindow {
  readonly startMs: number;
  readonly endMs: number;
  readonly youngBytes: number;
}

function timedWindow(sim: Simulation, ticks: number): TimedWindow {
  const bytesBefore = youngGenerationBytes();
  const startMs = performance.now();
  run(sim, ticks);
  const endMs = performance.now();
  return { startMs, endMs, youngBytes: youngGenerationBytes() - bytesBefore };
}

async function measureRow(row: RowSpec): Promise<Measured> {
  const collectGarbage = gc;
  if (!collectGarbage) throw new Error("bench rows run with --expose-gc");
  const spec = CONSISTS[row.consist]?.[1] ?? TRAIN;
  const sim = row.blocks ? blockSimulation(row.trains, spec) : freeSimulation(row.trains);
  const warmup = Math.ceil(
    (row.blocks ? BLOCK_WARMUP_TRAIN_TICKS : WARMUP_TRAIN_TICKS) / row.trains,
  );
  run(sim, warmup);
  const collectionStarts: number[] = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) collectionStarts.push(entry.startTime);
  });
  observer.observe({ entryTypes: ["gc"] });
  await settle();
  collectGarbage();
  for (let window = 0; window < PROBE_WARMUP_WINDOWS; window++) {
    timedWindow(sim, PROBE_WARMUP_TICKS);
  }
  await settle();
  const probe = timedWindow(sim, PROBE_TICKS);
  const timed = timedWindow(sim, row.blocks ? BLOCK_TICKS : TICKS);
  await settle();
  observer.disconnect();
  return {
    elapsedMs: timed.endMs - timed.startMs,
    collections: collectionStarts.filter((at) => at >= timed.startMs && at <= timed.endMs).length,
    allocatedBytes: timed.youngBytes - probe.youngBytes,
  };
}

function measureInChildProcess(row: RowSpec): Measured {
  const child = spawnSync(
    process.execPath,
    [...process.execArgv, "--expose-gc", fileURLToPath(import.meta.url), JSON.stringify(row)],
    { encoding: "utf8" },
  );
  if (child.status !== 0)
    throw new Error(`bench row ${JSON.stringify(row)} failed: ${child.stderr}`);
  return JSON.parse(child.stdout) as Measured;
}

function tableRow(label: string, ticks: number, measured: Measured, failures: string[]): string {
  const { elapsedMs, collections, allocatedBytes } = measured;
  if (collections !== 0 || allocatedBytes !== 0) {
    failures.push(`${label}: ${collections} collections, ${allocatedBytes} bytes`);
  }
  const microsPerTick = (elapsedMs * MICROSECONDS_PER_MS) / ticks;
  return `| ${label} | ${ticks.toLocaleString("en-US")} | ${elapsedMs.toFixed(1)} | ${microsPerTick.toFixed(3)} | ${((microsPerTick / (1e6 / SIM_TICK_HZ)) * 100).toFixed(4)}% | ${collections} | ${allocatedBytes} |`;
}

const childRow = process.argv[2];
if (childRow !== undefined) {
  process.stdout.write(JSON.stringify(await measureRow(JSON.parse(childRow) as RowSpec)));
} else {
  const failures: string[] = [];
  const freeRows = TRAIN_COUNTS.map((trains) =>
    tableRow(
      String(trains),
      TICKS,
      measureInChildProcess({ blocks: false, trains, consist: 0 }),
      failures,
    ),
  );
  const blockRows = CONSISTS.flatMap(([consist], index) =>
    BLOCK_TRAIN_COUNTS.map((trains) =>
      tableRow(
        `${trains} | ${consist}`,
        BLOCK_TICKS,
        measureInChildProcess({ blocks: true, trains, consist: index }),
        failures,
      ),
    ),
  );
  process.stdout.write(
    [
      `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}, each row in its own process`,
      "",
      `Free running: ${RING_PIECES}-arc ring, no block system`,
      "| trains | ticks | elapsed ms | µs/tick | share of a 16.7 ms tick | GCs during run | bytes allocated during run |",
      "|---|---|---|---|---|---|---|",
      ...freeRows,
      "",
      `Block system: ${blockLoop().graph.placementCount}-piece loop of ζ16 curves and straights, autopilot seed ${AUTOPILOT_SEED}`,
      "| trains | consist | ticks | elapsed ms | µs/tick | share of a 16.7 ms tick | GCs during run | bytes allocated during run |",
      "|---|---|---|---|---|---|---|---|",
      ...blockRows,
      "",
    ].join("\n"),
  );
  if (failures.length > 0) {
    process.stderr.write(`ticks allocated:\n${failures.join("\n")}\n`);
    process.exitCode = 1;
  }
}

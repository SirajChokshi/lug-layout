import {
  NO_SWITCH,
  backwardEdge,
  buildSimTrack,
  forwardEdge,
  type SimRoute,
  type SimTrack,
} from "@brr/domain";
import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { createSimSession } from "../src/create-sim-session.ts";
import { SIM_TICK_HZ, type Simulation, type TrainSpec } from "../src/simulation.ts";
import { VEHICLE_POSE_FLOATS } from "@brr/domain";
import { TrainClearance, type SimObstacles } from "../src/train-clearance.ts";

const RING_PIECES = 64;
const RADIUS_LDU = 4000;
const SWEEP = (2 * Math.PI) / RING_PIECES;
const WALL_BRICKS_PER_PIECE = 3;
const WALL_SIDE_LDU = 140;
const TICKS = 60 * SIM_TICK_HZ;
const WARMUP_TICKS = 10 * SIM_TICK_HZ;
const HELD_TICKS = 60 * SIM_TICK_HZ;
const CHECKS = 100_000;
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const BRICK_LO = [-60, 0, -20];
const BRICK_HI = [60, 24, 20];
const BODY_LO = [-690, 0, -80];
const BODY_HI = [0, 240, 80];
const TRAIN: TrainSpec = {
  vehicles: [{ lengthLdu: 690, frontBogieLdu: 175, rearBogieLdu: 515 }],
  maxSpeedLduPerS: 400,
  accelerationLduPerS2: 150,
  brakingLduPerS2: 300,
};

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

function boxTriangles(lo: ReadonlyArray<number>, hi: ReadonlyArray<number>): number[] {
  const corner = (i: number): number[] => [
    i & 1 ? (hi[0] ?? 0) : (lo[0] ?? 0),
    i & 2 ? (hi[1] ?? 0) : (lo[1] ?? 0),
    i & 4 ? (hi[2] ?? 0) : (lo[2] ?? 0),
  ];
  return [
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
    [0, 2, 3, 1],
    [4, 5, 7, 6],
  ].flatMap(([a = 0, b = 0, c = 0, d = 0]) => [a, b, c, a, c, d].flatMap(corner));
}

function walls(blockAt: number | null): SimObstacles {
  const brick = boxTriangles(BRICK_LO, BRICK_HI);
  const body = boxTriangles(BODY_LO, BODY_HI);
  const matrices: number[] = [];
  const boxes: number[] = [];
  const place = (angle: number, radius: number, lift: number): void => {
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const x = radius * sin;
    const z = -radius * cos;
    matrices.push(cos, 0, -sin, x, 0, 1, 0, lift, sin, 0, cos, z);
    const reach = Math.abs(60 * cos) + Math.abs(20 * sin);
    const depth = Math.abs(60 * sin) + Math.abs(20 * cos);
    boxes.push(x - reach, lift, z - depth, x + reach, lift + 24, z + depth);
  };
  for (let piece = 0; piece < RING_PIECES; piece++) {
    for (let k = 0; k < WALL_BRICKS_PER_PIECE; k++) {
      const angle = (piece + (k + 0.5) / WALL_BRICKS_PER_PIECE) * SWEEP;
      place(angle, RADIUS_LDU - WALL_SIDE_LDU, 0);
      place(angle, RADIUS_LDU + WALL_SIDE_LDU, 0);
    }
  }
  if (blockAt !== null) place(blockAt, RADIUS_LDU, 0);
  const parts = boxes.length / 6;
  return {
    solids: {
      boxes: Float64Array.of(...BRICK_LO, ...BRICK_HI, ...BODY_LO, ...BODY_HI),
      triangleStart: Int32Array.of(0, brick.length / 9, (brick.length + body.length) / 9),
      bodyTriangles: Int32Array.of(brick.length / 9, body.length / 9),
      triangles: Float64Array.from([...brick, ...body]),
      studStart: Int32Array.of(0, 0, 0),
      studFrames: new Float64Array(0),
      studPrimitive: new Uint8Array(0),
      primitiveStart: Int32Array.of(0),
      primitiveBoxes: new Float64Array(0),
      primitiveTriangles: new Float64Array(0),
    },
    modelMatrices: Float64Array.from(matrices),
    modelBoxes: Float64Array.from(boxes),
    modelSolid: new Int32Array(parts),
    modelOwner: Int32Array.from({ length: parts }, (_, m) => m),
    vehiclePartStart: Int32Array.of(0, 1),
    vehicleLocal: Float64Array.from(IDENTITY),
    vehicleSolid: Int32Array.of(1),
    vehicleRigid: Uint8Array.of(0),
    vehicleLift: Float64Array.of(0),
  };
}

function simulation(obstacles: SimObstacles | null): Simulation {
  const sim = createSimSession({
    track: ring(),
    capacity: { trains: 1, vehicles: 1 },
    trains: [{ spec: TRAIN, placement: { edge: forwardEdge(0), offsetLdu: 0 } }],
    obstacles,
  }).simulation;
  sim.setThrottle(0, TRAIN.maxSpeedLduPerS);
  return sim;
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });
const collectGarbage = (globalThis as { gc?: () => void }).gc;

interface Measured {
  readonly ms: number;
  readonly gcs: number;
  readonly heapGrowthBytes: number;
}

async function measured(sim: Simulation, ticks: number, held: boolean): Promise<Measured> {
  for (let i = 0; i < WARMUP_TICKS; i++) {
    if (held) sim.setThrottle(0, TRAIN.maxSpeedLduPerS);
    sim.step();
  }
  collectGarbage?.();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gcBefore = collections;
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  for (let i = 0; i < ticks; i++) {
    if (held) sim.setThrottle(0, TRAIN.maxSpeedLduPerS);
    sim.step();
  }
  const ms = performance.now() - start;
  const heapAfter = process.memoryUsage().heapUsed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { ms, gcs: collections - gcBefore, heapGrowthBytes: heapAfter - heapBefore };
}

async function measuredChecks(): Promise<Measured> {
  const sim = simulation(null);
  for (let i = 0; i < WARMUP_TICKS; i++) sim.step();
  const poses = new Float64Array(VEHICLE_POSE_FLOATS);
  sim.writePoses(null, 0, poses, 0);
  const clearance = new TrainClearance(walls(null));
  let met = 0;
  for (let i = 0; i < WARMUP_TICKS; i++) met += clearance.firstOwnerMet(poses, 0, 1);
  collectGarbage?.();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gcBefore = collections;
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  for (let i = 0; i < CHECKS; i++) met += clearance.firstOwnerMet(poses, 0, 1);
  const ms = performance.now() - start;
  const heapAfter = process.memoryUsage().heapUsed;
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (met !== -(CHECKS + WARMUP_TICKS)) throw new Error("the train met a wall it stands clear of");
  return { ms, gcs: collections - gcBefore, heapGrowthBytes: heapAfter - heapBefore };
}

const checks = await measuredChecks();
const bare = await measured(simulation(null), TICKS, false);
const lined = await measured(simulation(walls(null)), TICKS, false);
const held = await measured(simulation(walls(SWEEP / 2)), HELD_TICKS, true);
observer.disconnect();

const parts = walls(null).modelOwner.length;
const row = (work: string, m: Measured, ticks: number): string =>
  `| ${work} | ${ticks.toLocaleString("en-US")} | ${m.ms.toFixed(1)} | ${((m.ms * 1000) / ticks).toFixed(2)} | ${m.gcs} | ${m.heapGrowthBytes} |`;
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"} (${cpus().length} threads)`,
    `one train at full throttle on a ${RING_PIECES}-piece ring lined with ${parts} brick parts ${WALL_SIDE_LDU} LDU either side of the track`,
    "",
    "| Work | Ticks or checks | ms | µs each | GCs | Heap growth (bytes) |",
    "|---|---|---|---|---|---|",
    row("ring, no obstacles", bare, TICKS),
    row("ring lined with walls, the train clear of them", lined, TICKS),
    row("held against a block across the track, retrying each tick", held, HELD_TICKS),
    row("the clearance check alone, at a pose beside the walls", checks, CHECKS),
    "",
  ].join("\n"),
);

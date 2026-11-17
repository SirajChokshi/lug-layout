import { PerformanceObserver, performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { buildSimTrack, forwardEdge, backwardEdge, NO_SWITCH, type SimRoute } from "@brr/domain";
import { Simulation, SIM_TICK_HZ, type TrainSpec } from "../src/simulation.ts";

const RING_PIECES = 64;
const RADIUS_LDU = 4000;
const TICKS = 600_000;
const WARMUP_TICKS = 60_000;
const TRAIN_COUNTS = [1, 3, 10, 100] as const;
const SWEEP = (2 * Math.PI) / RING_PIECES;
const TRAIN: TrainSpec = {
  vehicles: [{ lengthLdu: 690, frontBogieLdu: 175, rearBogieLdu: 515 }],
  maxSpeedLduPerS: 400,
  accelerationLduPerS2: 150,
  brakingLduPerS2: 300,
};

function ring(): Simulation["track"] {
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

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

const track = ring();
const rows: string[] = [];
for (const trains of TRAIN_COUNTS) {
  const sim = new Simulation(track, { trains, vehicles: trains });
  for (let t = 0; t < trains; t++) {
    sim.addTrain(TRAIN, {
      edge: forwardEdge(Math.floor((t * RING_PIECES) / trains)),
      offsetLdu: 0,
    });
    sim.setThrottle(t, TRAIN.maxSpeedLduPerS);
  }
  for (let i = 0; i < WARMUP_TICKS; i++) sim.step();
  await new Promise((resolve) => setTimeout(resolve, 50));
  const gcBefore = collections;
  const start = performance.now();
  for (let i = 0; i < TICKS; i++) sim.step();
  const elapsedMs = performance.now() - start;
  await new Promise((resolve) => setTimeout(resolve, 50));
  const microsPerTick = (elapsedMs * 1000) / TICKS;
  rows.push(
    `| ${trains} | ${TICKS.toLocaleString("en-US")} | ${elapsedMs.toFixed(1)} | ${microsPerTick.toFixed(3)} | ${((microsPerTick / (1e6 / SIM_TICK_HZ)) * 100).toFixed(4)}% | ${collections - gcBefore} |`,
  );
}
observer.disconnect();
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}, ${RING_PIECES}-arc ring`,
    "| trains | ticks | elapsed ms | µs/tick | share of a 16.7 ms tick | GCs during run |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"),
);

import { describe, expect, it } from "vitest";
import {
  placeSegments,
  segmentsEnd,
  type PlanPose,
  type SimPathSegment,
} from "./route-geometry.ts";
import { replay, SimSession, type SimScenario } from "./sim-session.ts";
import { backwardEdge, buildSimTrack, forwardEdge, NO_SWITCH, type SimRoute } from "./sim-track.ts";
import {
  POSE_FLOATS_PER_VEHICLE,
  SIM_TICK_HZ,
  type Simulation,
  type TrainSpec,
} from "./simulation.ts";

const RADIUS = 800;
const ARC_STEPS = 16;
const ARC: SimPathSegment = {
  kind: "arc",
  radiusLdu: RADIUS,
  sweepRadians: (2 * Math.PI) / ARC_STEPS,
};
const STRAIGHT: SimPathSegment = { kind: "straight", lengthLdu: 320 };

const TRAIN: TrainSpec = {
  vehicles: [
    { lengthLdu: 690, frontBogieLdu: 175, rearBogieLdu: 515 },
    { lengthLdu: 400, frontBogieLdu: 80, rearBogieLdu: 320 },
  ],
  maxSpeedLduPerS: 600,
  accelerationLduPerS2: 300,
  brakingLduPerS2: 400,
};

function chain(start: PlanPose, segments: ReadonlyArray<SimPathSegment>): SimRoute[] {
  const routes: SimRoute[] = [];
  let at = start;
  for (const segment of segments) {
    const to = segmentsEnd(at, placeSegments(at, [segment]));
    routes.push({ from: at, to, segments: [segment] });
    at = to;
  }
  return routes;
}

function ring(count: number): { successors: number[][]; switchOfEdge: number[] } {
  const successors: number[][] = [];
  for (let r = 0; r < count; r++) {
    successors.push([forwardEdge((r + 1) % count)], [backwardEdge((r + count - 1) % count)]);
  }
  return { successors, switchOfEdge: successors.map(() => NO_SWITCH) };
}

function circle(): SimScenario {
  const routes = chain(
    { x: 0, z: -RADIUS, heading: 0 },
    Array.from({ length: ARC_STEPS }, () => ARC),
  );
  const { track } = buildSimTrack({ routes, ...ring(ARC_STEPS), switchCount: 0 });
  return {
    track,
    capacity: { trains: 1, vehicles: 2 },
    trains: [{ spec: TRAIN, placement: { edge: forwardEdge(4), offsetLdu: 10 } }],
  };
}

function run(sim: Simulation, seconds: number): void {
  for (let i = 0; i < seconds * SIM_TICK_HZ; i++) sim.step();
}

describe("Simulation on a closed circle of arcs", () => {
  it("keeps every bogie on the circle while the train laps it", () => {
    const session = new SimSession(circle());
    session.apply({ kind: "throttle", train: 0, speedLduPerS: 600 });
    const poses = new Float64Array(2 * POSE_FLOATS_PER_VEHICLE);
    let worst = 0;
    for (let tick = 0; tick < 30 * SIM_TICK_HZ; tick++) {
      session.simulation.step();
      session.simulation.writeVehiclePoses(poses);
      for (let p = 0; p < poses.length; p += 2) {
        worst = Math.max(worst, Math.abs(Math.hypot(poses[p] ?? 0, poses[p + 1] ?? 0) - RADIUS));
      }
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it("covers distance at its top speed once accelerated", () => {
    const sim = new SimSession(circle()).simulation;
    sim.setThrottle(0, 600);
    run(sim, 3);
    expect(sim.trainSpeed[0]).toBe(600);
    const circumference = 2 * Math.PI * RADIUS;
    const arcLength = circumference / ARC_STEPS;
    const along = (): number =>
      (((sim.trainEdge[0] ?? 0) / 2) * arcLength + (sim.trainOffset[0] ?? 0)) % circumference;
    const before = along();
    const ticks = 1_000;
    for (let i = 0; i < ticks; i++) sim.step();
    const travelled = (((along() - before) % circumference) + circumference) % circumference;
    expect(travelled).toBeCloseTo(((ticks * 600) / SIM_TICK_HZ) % circumference, 6);
  });

  it("keeps bogies at their spacing along the track", () => {
    const sim = new SimSession(circle()).simulation;
    sim.setThrottle(0, 450);
    run(sim, 7);
    const poses = new Float64Array(2 * POSE_FLOATS_PER_VEHICLE);
    sim.writeVehiclePoses(poses);
    const chord = Math.hypot((poses[0] ?? 0) - (poses[2] ?? 0), (poses[1] ?? 0) - (poses[3] ?? 0));
    const arc = 515 - 175;
    expect(chord).toBeCloseTo(2 * RADIUS * Math.sin(arc / (2 * RADIUS)), 9);
  });
});

describe("Simulation determinism", () => {
  it("replays a command log to the same state hash", () => {
    const live = new SimSession(circle());
    const sim = live.simulation;
    live.apply({ kind: "throttle", train: 0, speedLduPerS: 500 });
    run(sim, 4);
    live.apply({ kind: "throttle", train: 0, speedLduPerS: 0 });
    run(sim, 4);
    expect(live.apply({ kind: "reverse", train: 0 })).toBe(true);
    live.apply({ kind: "throttle", train: 0, speedLduPerS: 300 });
    run(sim, 5);
    const replayed = replay(circle(), live.log, sim.tick);
    expect(replayed.tick).toBe(sim.tick);
    expect(replayed.stateHash()).toBe(sim.stateHash());
    expect(Array.from(replayed.trainOffset)).toEqual(Array.from(sim.trainOffset));
  });

  it("hashes a different state when one command lands a tick later", () => {
    const a = new SimSession(circle());
    a.apply({ kind: "throttle", train: 0, speedLduPerS: 500 });
    run(a.simulation, 2);
    const b = new SimSession(circle());
    b.simulation.step();
    b.apply({ kind: "throttle", train: 0, speedLduPerS: 500 });
    for (let i = 1; i < 2 * SIM_TICK_HZ; i++) b.simulation.step();
    expect(b.simulation.tick).toBe(a.simulation.tick);
    expect(b.simulation.stateHash()).not.toBe(a.simulation.stateHash());
  });
});

describe("Reversing a stopped train", () => {
  it("keeps every bogie where it stood and runs the other way", () => {
    const sim = new SimSession(circle()).simulation;
    sim.setThrottle(0, 400);
    run(sim, 3);
    expect(sim.reverse(0)).toBe(false);
    sim.setThrottle(0, 0);
    run(sim, 3);
    const before = new Float64Array(2 * POSE_FLOATS_PER_VEHICLE);
    const after = new Float64Array(2 * POSE_FLOATS_PER_VEHICLE);
    sim.writeVehiclePoses(before);
    expect(sim.reverse(0)).toBe(true);
    sim.writeVehiclePoses(after);
    for (let i = 0; i < before.length; i++) expect(after[i]).toBeCloseTo(before[i] ?? 0, 9);
    expect((sim.trainEdge[0] ?? 0) % 2).toBe(1);
  });
});

function stemWithLoop(): SimScenario {
  const stem = chain(
    { x: 0, z: 0, heading: 0 },
    Array.from({ length: 5 }, () => STRAIGHT),
  );
  const junction = stem.at(-1)?.to ?? { x: 0, z: 0, heading: 0 };
  const loop = chain(
    junction,
    Array.from({ length: ARC_STEPS }, () => ARC),
  );
  const routes = [...stem, ...loop];
  const loopFirst = stem.length;
  const loopLast = routes.length - 1;
  const successors: number[][] = [];
  for (let r = 0; r < routes.length; r++) {
    const forward: number[] = [];
    const backward: number[] = [];
    if (r < loopFirst - 1) forward.push(forwardEdge(r + 1));
    if (r === loopFirst - 1) forward.push(forwardEdge(loopFirst), backwardEdge(loopLast));
    if (r >= loopFirst && r < loopLast) forward.push(forwardEdge(r + 1));
    if (r === loopLast) forward.push(backwardEdge(loopFirst - 1));
    if (r > 0 && r < loopFirst) backward.push(backwardEdge(r - 1));
    if (r === loopFirst) backward.push(backwardEdge(loopFirst - 1));
    if (r > loopFirst) backward.push(backwardEdge(r - 1));
    successors.push(forward, backward);
  }
  const switchOfEdge = successors.map((next) => (next.length > 1 ? 0 : NO_SWITCH));
  const { track } = buildSimTrack({ routes, successors, switchOfEdge, switchCount: 1 });
  return {
    track,
    capacity: { trains: 1, vehicles: 2 },
    trains: [{ spec: TRAIN, placement: { edge: forwardEdge(4), offsetLdu: 200 } }],
  };
}

describe("Switches and dead ends", () => {
  it("returns down the stem in the opposite direction after a reversing loop", () => {
    const sim = new SimSession(stemWithLoop()).simulation;
    sim.setThrottle(0, 500);
    const visited = new Set<number>();
    for (let tick = 0; tick < 40 * SIM_TICK_HZ; tick++) {
      sim.step();
      visited.add(sim.trainEdge[0] ?? 0);
    }
    expect(visited.has(forwardEdge(5))).toBe(true);
    expect(visited.has(backwardEdge(5))).toBe(false);
    expect(sim.trainEdge[0]).toBe(backwardEdge(0));
    expect(sim.trainSpeed[0]).toBe(0);
  });

  it("takes the other loop direction when the switch is thrown", () => {
    const sim = new SimSession(stemWithLoop()).simulation;
    sim.setSwitch(0, 1);
    sim.setThrottle(0, 500);
    const visited = new Set<number>();
    for (let tick = 0; tick < 12 * SIM_TICK_HZ; tick++) {
      sim.step();
      visited.add(sim.trainEdge[0] ?? 0);
    }
    expect(visited.has(backwardEdge(ARC_STEPS + 4))).toBe(true);
    expect(visited.has(forwardEdge(5))).toBe(false);
  });

  it("brakes to a stop at a buffer without running past the track end", () => {
    const sim = new SimSession(stemWithLoop()).simulation;
    sim.setThrottle(0, 500);
    run(sim, 40);
    expect(sim.trainEdge[0]).toBe(backwardEdge(0));
    expect(sim.trainOffset[0] ?? 0).toBeLessThanOrEqual(sim.track.edgeLength[backwardEdge(0)] ?? 0);
    expect(sim.trainOffset[0] ?? 0).toBeGreaterThan(
      (sim.track.edgeLength[backwardEdge(0)] ?? 0) - 5,
    );
  });
});

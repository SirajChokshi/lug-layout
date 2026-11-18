import { NO_SWITCH } from "@brr/domain";
import { describe, expect, it } from "vitest";
import {
  placeSegments,
  segmentsEnd,
  type PlanPose,
  type SimPathSegment,
} from "./route-geometry.ts";
import { createSimSession } from "./create-sim-session.ts";
import type { SimCommand, SimScenario, SimSession } from "./sim-session.ts";
import type { VehicleGeometry } from "./running-gear.ts";
import { backwardEdge, buildSimTrack, forwardEdge, type SimRoute } from "./sim-track.ts";
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

type ScriptStep = SimCommand | { readonly seconds: number };

function play(session: SimSession, script: ReadonlyArray<ScriptStep>): boolean[] {
  const accepted: boolean[] = [];
  for (const step of script) {
    if ("kind" in step) accepted.push(session.apply(step));
    else run(session.simulation, step.seconds);
  }
  return accepted;
}

describe("Simulation on a closed circle of arcs", () => {
  it("keeps every bogie on the circle while the train laps it", () => {
    const session = createSimSession(circle());
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
    const sim = createSimSession(circle()).simulation;
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
    const sim = createSimSession(circle()).simulation;
    sim.setThrottle(0, 450);
    run(sim, 7);
    const poses = new Float64Array(2 * POSE_FLOATS_PER_VEHICLE);
    sim.writeVehiclePoses(poses);
    const chord = Math.hypot((poses[0] ?? 0) - (poses[2] ?? 0), (poses[1] ?? 0) - (poses[3] ?? 0));
    const arc = 515 - 175;
    expect(chord).toBeCloseTo(2 * RADIUS * Math.sin(arc / (2 * RADIUS)), 9);
  });
});

describe("Placing a train", () => {
  it("puts every bogie at its distance behind the head at tick 0, wherever on the edge the head starts", () => {
    const arcLength = (2 * Math.PI * RADIUS) / ARC_STEPS;
    const behindHead = [175, 515, 690 + 80, 690 + 320];
    for (const offsetLdu of [0, arcLength / 3, arcLength]) {
      const scenario = circle();
      const sim = createSimSession({
        ...scenario,
        trains: [{ spec: TRAIN, placement: { edge: forwardEdge(4), offsetLdu } }],
      }).simulation;
      const poses = new Float64Array(2 * POSE_FLOATS_PER_VEHICLE);
      sim.writeVehiclePoses(poses);
      const headAngle = (4 * arcLength + offsetLdu) / RADIUS;
      behindHead.forEach((distance, i) => {
        const angle = headAngle - distance / RADIUS;
        expect(poses[2 * i] ?? 0).toBeCloseTo(RADIUS * Math.sin(angle), 6);
        expect(poses[2 * i + 1] ?? 0).toBeCloseTo(-RADIUS * Math.cos(angle), 6);
      });
      expect(sim.reverse(0)).toBe(true);
      const reversed = new Float64Array(poses.length);
      sim.writeVehiclePoses(reversed);
      for (let i = 0; i < poses.length; i++) expect(reversed[i]).toBeCloseTo(poses[i] ?? 0, 6);
    }
  });
});

const BOGIE_CAR: VehicleGeometry = {
  front: {
    pivotXLdu: 180,
    pivotZLdu: 0,
    leadAxleXLdu: 240,
    trailAxleXLdu: 120,
    axleZLdu: 0,
    pivots: true,
  },
  rear: {
    pivotXLdu: -180,
    pivotZLdu: 0,
    leadAxleXLdu: -120,
    trailAxleXLdu: -240,
    axleZLdu: 0,
    pivots: true,
  },
  frontCoupler: { xLdu: 353, zLdu: 0, mount: "frontBogie" },
  rearCoupler: { xLdu: -353, zLdu: 0, mount: "rearBogie" },
};

const FIXED_AXLE_CAR: VehicleGeometry = {
  front: {
    pivotXLdu: 90,
    pivotZLdu: 0,
    leadAxleXLdu: 90,
    trailAxleXLdu: 90,
    axleZLdu: 0,
    pivots: false,
  },
  rear: {
    pivotXLdu: -90,
    pivotZLdu: 0,
    leadAxleXLdu: -90,
    trailAxleXLdu: -90,
    axleZLdu: 0,
    pivots: false,
  },
  frontCoupler: { xLdu: 195, zLdu: 0, mount: "body" },
  rearCoupler: { xLdu: -195, zLdu: 0, mount: "body" },
};

function specOf(geometry: VehicleGeometry): TrainSpec["vehicles"][number] {
  const front = geometry.frontCoupler.xLdu;
  return {
    lengthLdu: front - geometry.rearCoupler.xLdu,
    frontBogieLdu: front - geometry.front.pivotXLdu,
    rearBogieLdu: front - geometry.rear.pivotXLdu,
    geometry,
  };
}

function coupledCircle(): SimScenario {
  return {
    ...circle(),
    capacity: { trains: 1, vehicles: 3 },
    trains: [
      {
        spec: {
          ...TRAIN,
          vehicles: [specOf(BOGIE_CAR), specOf(FIXED_AXLE_CAR), specOf(BOGIE_CAR)],
        },
        placement: { edge: forwardEdge(8), offsetLdu: 100 },
      },
    ],
  };
}

function placeLocal(
  pose: Float64Array,
  o: number,
  x: number,
  z: number,
): readonly [number, number] {
  const yaw = pose[o + 2] ?? 0;
  return [
    (pose[o] ?? 0) + x * Math.cos(yaw) - z * Math.sin(yaw),
    (pose[o + 1] ?? 0) + x * Math.sin(yaw) + z * Math.cos(yaw),
  ];
}

function runningGearErrors(session: SimSession): { axle: number; coupling: number } {
  const { layout } = session;
  const frame = new Float64Array(layout.floats);
  session.writeFrame(frame);
  const cars = [BOGIE_CAR, FIXED_AXLE_CAR, BOGIE_CAR];
  let axle = 0;
  let coupling = 0;
  let ahead: { x: number; z: number; normal: number } | null = null;
  for (let v = 0; v < cars.length; v++) {
    const car = cars[v] ?? BOGIE_CAR;
    const o = layout.vehiclePoseStart + v * layout.vehiclePoseFloats;
    for (const [guide, at] of [
      [car.front, o + 3],
      [car.rear, o + 6],
    ] as const) {
      const axles = guide.pivots ? [guide.leadAxleXLdu, guide.trailAxleXLdu] : [guide.pivotXLdu];
      for (const x of axles) {
        const [ax, az] = guide.pivots
          ? placeLocal(frame, at, x - guide.pivotXLdu, 0)
          : placeLocal(frame, o, x, 0);
        axle = Math.max(axle, Math.abs(Math.hypot(ax, az) - RADIUS));
      }
    }
    const face = (end: "front" | "rear"): { x: number; z: number; normal: number } => {
      const coupler = end === "front" ? car.frontCoupler : car.rearCoupler;
      const facing = end === "front" ? 0 : Math.PI;
      if (coupler.mount === "body") {
        const [x, z] = placeLocal(frame, o, coupler.xLdu, coupler.zLdu);
        return { x, z, normal: (frame[o + 2] ?? 0) + facing };
      }
      const guide = coupler.mount === "frontBogie" ? car.front : car.rear;
      const at = coupler.mount === "frontBogie" ? o + 3 : o + 6;
      const [x, z] = placeLocal(
        frame,
        at,
        coupler.xLdu - guide.pivotXLdu,
        coupler.zLdu - guide.pivotZLdu,
      );
      return { x, z, normal: (frame[at + 2] ?? 0) + facing };
    };
    if (ahead) {
      const front = face("front");
      const nx = Math.cos(front.normal) - Math.cos(ahead.normal);
      const nz = Math.sin(front.normal) - Math.sin(ahead.normal);
      const gap = ((ahead.x - front.x) * nx + (ahead.z - front.z) * nz) / Math.hypot(nx, nz);
      coupling = Math.max(coupling, Math.abs(gap));
    }
    ahead = face("rear");
  }
  return { axle, coupling };
}

function vehiclePoses(session: SimSession): Float64Array {
  const frame = new Float64Array(session.layout.floats);
  session.writeFrame(frame);
  const { vehiclePoseStart, vehiclePoseFloats, vehicles } = session.layout;
  return frame.slice(vehiclePoseStart, vehiclePoseStart + vehicles * vehiclePoseFloats);
}

describe("Coupled running gear on a circle", () => {
  it("keeps every axle on the circle and the coupling faces in contact, both ways", () => {
    const session = createSimSession(coupledCircle());
    const sim = session.simulation;
    sim.setThrottle(0, 500);
    run(sim, 6);
    const forward = runningGearErrors(session);
    expect(forward.axle).toBeLessThan(0.01);
    expect(forward.coupling).toBeLessThan(1e-6);
    sim.setThrottle(0, 0);
    run(sim, 4);
    expect(sim.reverse(0)).toBe(true);
    sim.setThrottle(0, 500);
    run(sim, 6);
    const backward = runningGearErrors(session);
    expect(backward.axle).toBeLessThan(0.01);
    expect(backward.coupling).toBeLessThan(1e-6);
  });

  it("leaves every body and bogie where it stood when a stopped train reverses", () => {
    const session = createSimSession(coupledCircle());
    const sim = session.simulation;
    sim.setThrottle(0, 500);
    run(sim, 6);
    sim.setThrottle(0, 0);
    run(sim, 4);
    const before = vehiclePoses(session);
    expect(sim.reverse(0)).toBe(true);
    const after = vehiclePoses(session);
    let worst = 0;
    for (let v = 0; v < session.layout.vehicles; v++) {
      for (const at of [0, 3, 6]) {
        const o = v * session.layout.vehiclePoseFloats + at;
        const moved = Math.hypot(
          (after[o] ?? 0) - (before[o] ?? 0),
          (after[o + 1] ?? 0) - (before[o + 1] ?? 0),
        );
        worst = Math.max(worst, moved);
      }
    }
    expect(worst).toBeLessThan(1e-6);
  });

  it("gives the body length as head to solved tail, the distance a stopped reverse moves the head", () => {
    const session = createSimSession(coupledCircle());
    const sim = session.simulation;
    sim.setThrottle(0, 500);
    run(sim, 6);
    sim.setThrottle(0, 0);
    run(sim, 4);
    const circumference = 2 * Math.PI * RADIUS;
    const arcLength = circumference / ARC_STEPS;
    const headAlong = (): number => {
      const edge = sim.trainEdge[0] ?? 0;
      const offset = sim.trainOffset[0] ?? 0;
      const route = Math.floor(edge / 2);
      return edge % 2 === 0 ? route * arcLength + offset : (route + 1) * arcLength - offset;
    };
    const head = headAlong();
    sim.solveBody(0);
    const length = sim.trainBodyLength[0] ?? 0;
    expect(sim.reverse(0)).toBe(true);
    const moved = (((head - headAlong()) % circumference) + circumference) % circumference;
    expect(moved).toBeCloseTo(length, 6);
    sim.solveBody(0);
    expect(sim.trainBodyLength[0]).toBeCloseTo(length, 6);
  });
});

describe("Simulation determinism", () => {
  it("reaches the same state hash on a fresh session given the same commands at the same ticks", () => {
    const script: ScriptStep[] = [
      { kind: "throttle", train: 0, speedLduPerS: 500 },
      { seconds: 4 },
      { kind: "throttle", train: 0, speedLduPerS: 0 },
      { seconds: 4 },
      { kind: "reverse", train: 0 },
      { kind: "throttle", train: 0, speedLduPerS: 300 },
      { seconds: 5 },
    ];
    const first = createSimSession(circle());
    const second = createSimSession(circle());
    expect(play(first, script)).toEqual([true, true, true, true]);
    expect(play(second, script)).toEqual([true, true, true, true]);
    expect(second.simulation.tick).toBe(first.simulation.tick);
    expect(second.simulation.stateHash()).toBe(first.simulation.stateHash());
    expect(Array.from(second.simulation.trainOffset)).toEqual(
      Array.from(first.simulation.trainOffset),
    );
  });

  it("reaches the same state hash through a signed-speed reversal on a fresh session", () => {
    const script: ScriptStep[] = [
      { kind: "drive", train: 0, signedSpeedLduPerS: 500 },
      { seconds: 4 },
      { kind: "drive", train: 0, signedSpeedLduPerS: -300 },
      { seconds: 8 },
    ];
    const first = createSimSession(circle());
    const second = createSimSession(circle());
    expect(play(first, script)).toEqual([true, true]);
    expect(play(second, script)).toEqual([true, true]);
    expect(first.simulation.direction(0)).toBe(-1);
    expect(second.simulation.stateHash()).toBe(first.simulation.stateHash());
  });

  it("reaches the same state hash through a derailment and a rerail whether or not the commands it refused were sent", () => {
    const driveForward: SimCommand = { kind: "drive", train: 0, signedSpeedLduPerS: 500 };
    const driveBack: SimCommand = { kind: "drive", train: 0, signedSpeedLduPerS: -500 };
    const rerail: SimCommand = { kind: "rerail", train: 0 };
    const withRefused = createSimSession(lineEndingInCurve("derail"));
    const withoutRefused = createSimSession(lineEndingInCurve("derail"));
    expect(
      play(withRefused, [
        driveForward,
        { seconds: 25 },
        { kind: "reverse", train: 0 },
        driveBack,
        { seconds: 2 },
      ]),
    ).toEqual([true, false, false]);
    expect(play(withoutRefused, [driveForward, { seconds: 27 }])).toEqual([true]);
    expect(withoutRefused.simulation.stateHash()).toBe(withRefused.simulation.stateHash());
    expect(play(withRefused, [rerail, rerail, driveBack, { seconds: 3 }])).toEqual([
      true,
      false,
      true,
    ]);
    expect(play(withoutRefused, [rerail, driveBack, { seconds: 3 }])).toEqual([true, true]);
    expect(withoutRefused.simulation.stateHash()).toBe(withRefused.simulation.stateHash());
  });

  it("hashes a different state when one command lands a tick later", () => {
    const a = createSimSession(circle());
    a.apply({ kind: "throttle", train: 0, speedLduPerS: 500 });
    run(a.simulation, 2);
    const b = createSimSession(circle());
    b.simulation.step();
    b.apply({ kind: "throttle", train: 0, speedLduPerS: 500 });
    for (let i = 1; i < 2 * SIM_TICK_HZ; i++) b.simulation.step();
    expect(b.simulation.tick).toBe(a.simulation.tick);
    expect(b.simulation.stateHash()).not.toBe(a.simulation.stateHash());
  });
});

describe("Reversing a stopped train", () => {
  it("keeps every bogie where it stood and runs the other way", () => {
    const sim = createSimSession(circle()).simulation;
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
    const sim = createSimSession(stemWithLoop()).simulation;
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
    const sim = createSimSession(stemWithLoop()).simulation;
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

  it("brakes to a stop at a buffer without running past the track end, under the default open-end rule", () => {
    const sim = createSimSession(stemWithLoop()).simulation;
    sim.setThrottle(0, 500);
    run(sim, 40);
    expect(sim.trainEdge[0]).toBe(backwardEdge(0));
    expect(sim.trainOffset[0] ?? 0).toBeLessThanOrEqual(sim.track.edgeLength[backwardEdge(0)] ?? 0);
    expect(sim.trainOffset[0] ?? 0).toBeGreaterThan(
      (sim.track.edgeLength[backwardEdge(0)] ?? 0) - 5,
    );
  });
});

const LINE_STRAIGHTS = 6;
const LINE_ARCS = 4;

function lineEndingInCurve(openEnds: "brake" | "derail"): SimScenario {
  const routes = chain({ x: 0, z: 0, heading: 0 }, [
    ...Array.from({ length: LINE_STRAIGHTS }, () => STRAIGHT),
    ...Array.from({ length: LINE_ARCS }, () => ARC),
  ]);
  const successors: number[][] = [];
  for (let r = 0; r < routes.length; r++) {
    successors.push(
      r + 1 < routes.length ? [forwardEdge(r + 1)] : [],
      r > 0 ? [backwardEdge(r - 1)] : [],
    );
  }
  const { track } = buildSimTrack({
    routes,
    successors,
    switchOfEdge: successors.map(() => NO_SWITCH),
    switchCount: 0,
  });
  return {
    track,
    capacity: { trains: 1, vehicles: 2 },
    trains: [{ spec: TRAIN, placement: { edge: forwardEdge(4), offsetLdu: 100 } }],
    openEnds,
  };
}

const LAST_EDGE = forwardEdge(LINE_STRAIGHTS + LINE_ARCS - 1);
const LEAD_CAR = TRAIN.vehicles[0] ?? { lengthLdu: 0, frontBogieLdu: 0, rearBogieLdu: 0 };

function lineEnd(): PlanPose {
  const routes = chain({ x: 0, z: 0, heading: 0 }, [
    ...Array.from({ length: LINE_STRAIGHTS }, () => STRAIGHT),
    ...Array.from({ length: LINE_ARCS }, () => ARC),
  ]);
  return routes.at(-1)?.to ?? { x: 0, z: 0, heading: 0 };
}

function frameOf(session: SimSession): Float64Array {
  const frame = new Float64Array(session.layout.floats);
  session.writeFrame(frame);
  return frame;
}

function leadBogie(sim: Simulation): readonly [number, number] {
  const poses = new Float64Array(sim.vehicles * POSE_FLOATS_PER_VEHICLE);
  sim.writeVehiclePoses(poses);
  return [poses[0] ?? 0, poses[1] ?? 0];
}

function distanceFrom(sim: Simulation, point: PlanPose): number {
  const [x, z] = leadBogie(sim);
  return Math.hypot(x - point.x, z - point.z);
}

function driveIntoEnd(session: SimSession, speed: number): number {
  const sim = session.simulation;
  session.apply({ kind: "drive", train: 0, signedSpeedLduPerS: speed });
  let hitSpeed = 0;
  for (let tick = 0; tick < 20 * SIM_TICK_HZ && !sim.derailed(0); tick++) {
    hitSpeed = sim.trainSpeed[0] ?? 0;
    sim.step();
  }
  return hitSpeed;
}

describe("Open ends under the derail rule", () => {
  it("derails once its leading axle runs off the open end, then skids to rest along the end's tangent", () => {
    const session = createSimSession(lineEndingInCurve("derail"));
    const sim = session.simulation;
    const end = lineEnd();
    const hitSpeed = driveIntoEnd(session, 600);
    expect(sim.derailed(0)).toBe(true);
    expect(sim.trainEdge[0]).toBe(LAST_EDGE);
    expect(hitSpeed).toBe(600);
    expect(sim.trainDerailSpeed[0]).toBe(600);
    const atDerail = sim.overrunLdu(0);
    expect(atDerail).toBeGreaterThanOrEqual(LEAD_CAR.frontBogieLdu);
    expect(atDerail).toBeLessThan(LEAD_CAR.frontBogieLdu + 600 / SIM_TICK_HZ);
    run(sim, 5);
    expect(sim.trainSpeed[0]).toBe(0);
    const overrun = sim.overrunLdu(0);
    const skid = (600 * 600) / (2 * TRAIN.brakingLduPerS2);
    expect(overrun - atDerail).toBeGreaterThan(skid * 0.95);
    expect(overrun - atDerail).toBeLessThan(skid * 1.05);
    const [leadX, leadZ] = leadBogie(sim);
    const along = (leadX - end.x) * Math.cos(end.heading) + (leadZ - end.z) * Math.sin(end.heading);
    const across =
      -(leadX - end.x) * Math.sin(end.heading) + (leadZ - end.z) * Math.cos(end.heading);
    expect(along).toBeCloseTo(overrun - LEAD_CAR.frontBogieLdu, 6);
    expect(Math.abs(across)).toBeLessThan(1e-9);
    const frame = frameOf(session);
    expect(frame[session.layout.trainDerailSpeedStart]).toBe(600);
    expect(frame[session.layout.bogiesOffTrackStart]).toBe(
      overrun >= LEAD_CAR.rearBogieLdu ? 2 : 1,
    );
    expect(frame[session.layout.bogiesOffTrackStart + 1]).toBe(0);
  });

  it("stays on the rails when it stops with only its front overhanging the end, and backs away", () => {
    const session = createSimSession(lineEndingInCurve("derail"));
    const sim = session.simulation;
    const end = lineEnd();
    const speed = 300;
    const stopping = (speed * speed) / (2 * TRAIN.brakingLduPerS2);
    const endLength = sim.track.edgeLength[LAST_EDGE] ?? 0;
    const overhang = LEAD_CAR.frontBogieLdu / 3;
    session.apply({ kind: "drive", train: 0, signedSpeedLduPerS: speed });
    while (sim.trainEdge[0] !== LAST_EDGE || (sim.trainOffset[0] ?? 0) < endLength - stopping) {
      sim.step();
    }
    while ((sim.trainOffset[0] ?? 0) < endLength - stopping + overhang) sim.step();
    session.apply({ kind: "drive", train: 0, signedSpeedLduPerS: 0 });
    run(sim, 3);
    expect(sim.trainSpeed[0]).toBe(0);
    expect(sim.derailed(0)).toBe(false);
    expect(sim.overrunLdu(0)).toBeGreaterThan(overhang / 2);
    expect(sim.overrunLdu(0)).toBeLessThan(LEAD_CAR.frontBogieLdu);
    expect(frameOf(session)[session.layout.bogiesOffTrackStart]).toBe(0);
    const stoppedAt = distanceFrom(sim, end);
    session.apply({ kind: "drive", train: 0, signedSpeedLduPerS: -speed });
    run(sim, 2);
    expect(sim.derailed(0)).toBe(false);
    expect(sim.trainSpeed[0]).toBe(speed);
    expect(distanceFrom(sim, end)).toBeGreaterThan(stoppedAt + speed / 2);
  });

  it("ignores throttle and refuses to reverse until rerailed, then drives back the other way", () => {
    const session = createSimSession(lineEndingInCurve("derail"));
    const sim = session.simulation;
    const end = lineEnd();
    driveIntoEnd(session, 500);
    run(sim, 5);
    const resting = sim.trainOffset[0] ?? 0;
    expect(session.apply({ kind: "reverse", train: 0 })).toBe(false);
    expect(session.apply({ kind: "drive", train: 0, signedSpeedLduPerS: -500 })).toBe(false);
    run(sim, 2);
    expect(sim.trainOffset[0]).toBe(resting);
    const derailedFrame = frameOf(session);
    expect(derailedFrame[session.layout.trainDirectionStart]).toBe(1);
    expect(derailedFrame[session.layout.trainFacingStart]).toBe(1);
    expect(session.apply({ kind: "rerail", train: 0 })).toBe(true);
    expect(sim.derailed(0)).toBe(false);
    expect(sim.trainOffset[0]).toBe(sim.track.edgeLength[LAST_EDGE]);
    expect(sim.trainSpeed[0]).toBe(0);
    expect(session.apply({ kind: "rerail", train: 0 })).toBe(false);
    const rerailedAt = distanceFrom(sim, end);
    session.apply({ kind: "drive", train: 0, signedSpeedLduPerS: -500 });
    run(sim, 3);
    expect(sim.trainSpeed[0]).toBe(500);
    expect(sim.derailed(0)).toBe(false);
    expect(distanceFrom(sim, end)).toBeGreaterThan(rerailedAt + 500);
  });
});

function angleOnCircle(sim: Simulation): number {
  const [x, z] = leadBogie(sim);
  return Math.atan2(z, x);
}

function angularStep(sim: Simulation): number {
  const before = angleOnCircle(sim);
  sim.step();
  return Math.atan2(Math.sin(angleOnCircle(sim) - before), Math.cos(angleOnCircle(sim) - before));
}

describe("Driving with a signed speed", () => {
  it("brakes to a stop, reverses where it stood and runs the other way when asked to go backward while moving forward", () => {
    const session = createSimSession(circle());
    const sim = session.simulation;
    session.apply({ kind: "drive", train: 0, signedSpeedLduPerS: 500 });
    run(sim, 4);
    expect(sim.direction(0)).toBe(1);
    const forwardSense = Math.sign(angularStep(sim));
    session.apply({ kind: "drive", train: 0, signedSpeedLduPerS: -300 });
    expect(sim.direction(0)).toBe(-1);
    const turning = frameOf(session);
    expect(turning[session.layout.trainDirectionStart]).toBe(-1);
    expect(turning[session.layout.trainFacingStart]).toBe(1);
    let previousSpeed = sim.trainSpeed[0] ?? 0;
    while ((sim.trainSpeed[0] ?? 0) > 0) {
      sim.step();
      const speed = sim.trainSpeed[0] ?? 0;
      expect(speed).toBeLessThanOrEqual(previousSpeed);
      previousSpeed = speed;
    }
    const stoppedAt = leadBogie(sim);
    sim.step();
    const [x, z] = leadBogie(sim);
    expect(Math.hypot(x - stoppedAt[0], z - stoppedAt[1])).toBeLessThan(1);
    run(sim, 4);
    expect(sim.trainSpeed[0]).toBe(300);
    expect(Math.sign(angularStep(sim))).toBe(-forwardSense);
    const turned = frameOf(session);
    expect(turned[session.layout.trainDirectionStart]).toBe(-1);
    expect(turned[session.layout.trainFacingStart]).toBe(-1);
  });
});

import type { SimTrack } from "./sim-track.ts";
import {
  POSE_FLOATS_PER_VEHICLE,
  Simulation,
  type SimCapacity,
  type SimRailway,
  type TrainPlacement,
  type TrainSpec,
} from "./simulation.ts";

export type SimCommand =
  | { readonly kind: "throttle"; readonly train: number; readonly speedLduPerS: number }
  | { readonly kind: "switch"; readonly switchIndex: number; readonly state: number }
  | { readonly kind: "reverse"; readonly train: number }
  | { readonly kind: "goTo"; readonly train: number; readonly placement: number };

export interface SimLogEntry {
  readonly tick: number;
  readonly command: SimCommand;
}

export interface SimTrainLoad {
  readonly spec: TrainSpec;
  readonly placement: TrainPlacement;
}

export interface SimScenario {
  readonly track: SimTrack;
  readonly capacity: SimCapacity;
  readonly trains: ReadonlyArray<SimTrainLoad>;
  readonly railway?: SimRailway;
}

const ROUTE_STATE_CODES = { manual: 0, waiting: 1, routed: 2, arrived: 3, reversing: 4 } as const;

export interface SimFrameLayout {
  readonly poseFloatsPerVehicle: number;
  readonly vehicles: number;
  readonly trains: number;
  readonly switches: number;
  readonly poseStart: number;
  readonly trainEdgeStart: number;
  readonly trainOffsetStart: number;
  readonly trainSpeedStart: number;
  readonly switchStart: number;
  readonly arrivalsStart: number;
  readonly routeStateStart: number;
  readonly sharedPieceTicksIndex: number;
  readonly minBogieSeparationIndex: number;
  readonly checkedTicksIndex: number;
  readonly floats: number;
}

export function simFrameLayout(vehicles: number, trains: number, switches: number): SimFrameLayout {
  const poseStart = 0;
  const trainEdgeStart = poseStart + vehicles * POSE_FLOATS_PER_VEHICLE;
  const trainOffsetStart = trainEdgeStart + trains;
  const trainSpeedStart = trainOffsetStart + trains;
  const switchStart = trainSpeedStart + trains;
  const arrivalsStart = switchStart + switches;
  const routeStateStart = arrivalsStart + trains;
  const sharedPieceTicksIndex = routeStateStart + trains;
  const minBogieSeparationIndex = sharedPieceTicksIndex + 1;
  const checkedTicksIndex = minBogieSeparationIndex + 1;
  return {
    poseFloatsPerVehicle: POSE_FLOATS_PER_VEHICLE,
    vehicles,
    trains,
    switches,
    poseStart,
    trainEdgeStart,
    trainOffsetStart,
    trainSpeedStart,
    switchStart,
    arrivalsStart,
    routeStateStart,
    sharedPieceTicksIndex,
    minBogieSeparationIndex,
    checkedTicksIndex,
    floats: checkedTicksIndex + 1,
  };
}

export class SimSession {
  readonly simulation: Simulation;
  readonly layout: SimFrameLayout;
  private readonly entries: SimLogEntry[] = [];

  readonly scenario: SimScenario;

  constructor(scenario: SimScenario) {
    this.scenario = scenario;
    this.simulation = new Simulation(scenario.track, scenario.capacity, scenario.railway ?? null);
    for (const train of scenario.trains) this.simulation.addTrain(train.spec, train.placement);
    this.layout = simFrameLayout(
      this.simulation.vehicles,
      this.simulation.trains,
      scenario.track.switchCount,
    );
  }

  get log(): ReadonlyArray<SimLogEntry> {
    return this.entries;
  }

  apply(command: SimCommand): boolean {
    const accepted = applyCommand(this.simulation, command);
    if (accepted) this.entries.push({ tick: this.simulation.tick, command });
    return accepted;
  }

  writeFrame(out: Float64Array): void {
    const sim = this.simulation;
    const layout = this.layout;
    sim.writeVehiclePoses(out);
    for (let t = 0; t < layout.trains; t++) {
      out[layout.trainEdgeStart + t] = sim.trainEdge[t] ?? 0;
      out[layout.trainOffsetStart + t] = sim.trainOffset[t] ?? 0;
      out[layout.trainSpeedStart + t] = sim.trainSpeed[t] ?? 0;
    }
    for (let s = 0; s < layout.switches; s++) {
      out[layout.switchStart + s] = sim.switchStates[s] ?? 0;
    }
    const blocks = sim.blocks;
    for (let t = 0; t < layout.trains; t++) {
      out[layout.arrivalsStart + t] = blocks?.arrivals[t] ?? 0;
      out[layout.routeStateStart + t] = blocks ? ROUTE_STATE_CODES[blocks.routeState(t)] : 0;
    }
    const separation = sim.separationCounters;
    out[layout.sharedPieceTicksIndex] = separation[0] ?? 0;
    out[layout.minBogieSeparationIndex] = separation[1] ?? 0;
    out[layout.checkedTicksIndex] = separation[2] ?? 0;
  }
}

function applyCommand(simulation: Simulation, command: SimCommand): boolean {
  switch (command.kind) {
    case "throttle":
      simulation.setThrottle(command.train, command.speedLduPerS);
      return true;
    case "switch":
      return simulation.setSwitch(command.switchIndex, command.state);
    case "goTo":
      return simulation.goTo(command.train, command.placement);
    case "reverse":
      return simulation.reverse(command.train);
    default: {
      const unhandled: never = command;
      throw new Error(`unhandled sim command ${String(unhandled)}`);
    }
  }
}

export function replay(
  scenario: SimScenario,
  log: ReadonlyArray<SimLogEntry>,
  ticks: number,
): Simulation {
  const session = new SimSession(scenario);
  const sim = session.simulation;
  let next = 0;
  while (sim.tick < ticks || next < log.length) {
    const entry = log[next];
    if (entry && entry.tick === sim.tick) {
      session.apply(entry.command);
      next++;
      continue;
    }
    if (entry && entry.tick < sim.tick)
      throw new Error(`log entry at tick ${entry.tick} is out of order`);
    if (sim.tick >= ticks) break;
    sim.step();
  }
  return sim;
}

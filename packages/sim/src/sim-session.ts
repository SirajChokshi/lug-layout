import type { BlockTopology } from "./blocks/block-map.ts";
import { VEHICLE_POSE_FLOATS, type SimTrack } from "@brr/domain";
import {
  POSE_FLOATS_PER_VEHICLE,
  type OpenEndRule,
  type SimCapacity,
  type Simulation,
  type TrainPlacement,
  type TrainSpec,
} from "./simulation.ts";

export type SimCommand =
  | { readonly kind: "throttle"; readonly train: number; readonly speedLduPerS: number }
  | { readonly kind: "drive"; readonly train: number; readonly signedSpeedLduPerS: number }
  | { readonly kind: "rerail"; readonly train: number }
  | { readonly kind: "switch"; readonly switchIndex: number; readonly state: number }
  | { readonly kind: "reverse"; readonly train: number }
  | { readonly kind: "goTo"; readonly train: number; readonly placement: number };

export interface SimTrainLoad {
  readonly spec: TrainSpec;
  readonly placement: TrainPlacement;
}

export interface SimRailway {
  readonly topology: BlockTopology;
  readonly autopilotSeed: number | null;
}

export interface SimScenario {
  readonly track: SimTrack;
  readonly capacity: SimCapacity;
  readonly trains: ReadonlyArray<SimTrainLoad>;
  readonly railway?: SimRailway;
  readonly openEnds?: OpenEndRule;
}

export type SimSessionFactory = (scenario: SimScenario) => SimSession;

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
  readonly vehiclePoseStart: number;
  readonly vehiclePoseFloats: number;
  readonly trainDirectionStart: number;
  readonly trainFacingStart: number;
  readonly trainDerailSpeedStart: number;
  readonly bogiesOffTrackStart: number;
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
  const vehiclePoseStart = checkedTicksIndex + 1;
  const trainDirectionStart = vehiclePoseStart + vehicles * VEHICLE_POSE_FLOATS;
  const trainFacingStart = trainDirectionStart + trains;
  const trainDerailSpeedStart = trainFacingStart + trains;
  const bogiesOffTrackStart = trainDerailSpeedStart + trains;
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
    vehiclePoseStart,
    vehiclePoseFloats: VEHICLE_POSE_FLOATS,
    trainDirectionStart,
    trainFacingStart,
    trainDerailSpeedStart,
    bogiesOffTrackStart,
    floats: bogiesOffTrackStart + vehicles,
  };
}

export class SimSession {
  readonly layout: SimFrameLayout;

  constructor(readonly simulation: Simulation) {
    this.layout = simFrameLayout(
      simulation.vehicles,
      simulation.trains,
      simulation.track.switchCount,
    );
  }

  apply(command: SimCommand): boolean {
    return applyCommand(this.simulation, command);
  }

  writeFrame(out: Float64Array): void {
    const sim = this.simulation;
    const layout = this.layout;
    sim.writePoses(out, layout.poseStart, out, layout.vehiclePoseStart);
    for (let t = 0; t < layout.trains; t++) {
      out[layout.trainEdgeStart + t] = sim.trainEdge[t] ?? 0;
      out[layout.trainOffsetStart + t] = sim.trainOffset[t] ?? 0;
      out[layout.trainSpeedStart + t] = sim.trainSpeed[t] ?? 0;
      out[layout.trainDirectionStart + t] = sim.direction(t);
      out[layout.trainFacingStart + t] = sim.facing(t);
      out[layout.trainDerailSpeedStart + t] = sim.trainDerailSpeed[t] ?? 0;
    }
    sim.writeBogiesOffTrack(out, layout.bogiesOffTrackStart);
    for (let s = 0; s < layout.switches; s++) {
      out[layout.switchStart + s] = sim.switchStates[s] ?? 0;
    }
    const keeper = sim.keeper;
    for (let t = 0; t < layout.trains; t++) {
      out[layout.arrivalsStart + t] = keeper?.arrivals[t] ?? 0;
      out[layout.routeStateStart + t] = keeper ? ROUTE_STATE_CODES[keeper.routeState(t)] : 0;
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
    case "drive":
      return simulation.drive(command.train, command.signedSpeedLduPerS);
    case "rerail":
      return simulation.rerail(command.train);
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

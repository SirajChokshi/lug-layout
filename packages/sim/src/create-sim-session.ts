import { RunningGearPoser, type SimTrack } from "@brr/domain";
import { Autopilot } from "./blocks/autopilot.ts";
import { BlockKeeper } from "./blocks/block-keeper.ts";
import { BlockMap, type BlockTopology } from "./blocks/block-map.ts";
import { RoutePlanner } from "./routing/route-planner.ts";
import { SimSession, type SimScenario } from "./sim-session.ts";
import { SIM_TICK_HZ, Simulation, type SimCapacity } from "./simulation.ts";
import { TrainClearance } from "./train-clearance.ts";

const AUTOPILOT_DWELL_SECONDS = 3;
const AUTOPILOT_RETRY_SECONDS = 2;

export function createSimSession(scenario: SimScenario): SimSession {
  const { track, capacity, railway } = scenario;
  const keeper = railway ? blockKeeper(railway.topology, track, capacity) : null;
  const seed = railway?.autopilotSeed ?? null;
  const simulation = new Simulation(
    track,
    capacity,
    scenario.openEnds ?? "brake",
    new RunningGearPoser(),
    keeper,
    keeper && seed !== null ? autopilot(keeper, seed, capacity) : null,
    scenario.obstacles ? new TrainClearance(scenario.obstacles) : null,
  );
  for (const train of scenario.trains) simulation.addTrain(train.spec, train.placement);
  return new SimSession(simulation);
}

function blockKeeper(topology: BlockTopology, track: SimTrack, capacity: SimCapacity): BlockKeeper {
  const map = new BlockMap(topology, track.edgeLength);
  return new BlockKeeper(map, new RoutePlanner(map), capacity.trains);
}

function autopilot(keeper: BlockKeeper, seed: number, capacity: SimCapacity): Autopilot {
  return new Autopilot(
    keeper.blocks,
    keeper,
    seed,
    capacity.trains,
    AUTOPILOT_DWELL_SECONDS * SIM_TICK_HZ,
    AUTOPILOT_RETRY_SECONDS * SIM_TICK_HZ,
  );
}

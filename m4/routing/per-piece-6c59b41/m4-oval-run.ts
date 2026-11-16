import { readFileSync } from "node:fs";
import { TrackGraph } from "@brr/domain";
import { SimSession, simTrackFromGraph } from "@brr/sim";
import { parseTrackCatalog } from "../catalog/src/track-catalog.ts";
import { buildTrackPlan } from "./src/scene/track-plan.ts";
import { routeSegments, simTopology } from "./src/sim/sim-track-input.ts";

const manifest = JSON.parse(
  readFileSync("../../tools/asset-pipeline/dist/bundle/standard/manifest.json", "utf8"),
);
const catalog = parseTrackCatalog(manifest.trackCatalog);
const plan = "ldraw:74746*4,ldraw:74747*8,ldraw:74746*4,ldraw:74747*8";
const { layout, catalogPieces } = buildTrackPlan(plan, catalog);
const graph = new TrackGraph(layout);
const topology = simTopology(graph);
const { track } = simTrackFromGraph(topology, routeSegments(graph, layout, catalogPieces));
const vehicle = { lengthLdu: 706, frontBogieLdu: 183, rearBogieLdu: 523 };
const spec = { vehicles: [vehicle], maxSpeedLduPerS: 400, accelerationLduPerS2: 150, brakingLduPerS2: 300 };

function scenario(name: string, fronts: number[][], throttles: number[], minutes: number) {
  const session = new SimSession({
    track,
    capacity: { trains: fronts.length, vehicles: fronts.length },
    trains: fronts.map(([edge, offsetLdu]) => ({ spec, placement: { edge: edge!, offsetLdu: offsetLdu! } })),
    railway: { topology, autopilotSeed: null },
  });
  throttles.forEach((speed, train) => session.apply({ kind: "throttle", train, speedLduPerS: speed }));
  const sim = session.simulation;
  const distance = new Float64Array(fronts.length);
  let stoppedBehindTicks = 0;
  for (let tick = 0; tick < minutes * 3600; tick++) {
    sim.step();
    for (let t = 0; t < fronts.length; t++) {
      distance[t]! += sim.trainSpeed[t]! / 60;
      if (sim.trainSpeed[t]! < (throttles[t] ?? 0)) stoppedBehindTicks++;
    }
  }
  console.log(JSON.stringify({
    name,
    simulatedMinutes: minutes,
    throttles,
    sharedPieceTicks: sim.separationCounters[0],
    checkedTicks: sim.separationCounters[2],
    minBogieSeparationLdu: Math.round(sim.separationCounters[1]!),
    finalSpeeds: Array.from(sim.trainSpeed, Math.round),
    distanceLdu: Array.from(distance, Math.round),
    trainTicksBelowThrottle: stoppedBehindTicks,
  }));
}

scenario("two trains, critic's positions", [[0, 300], [12, 300]], [150, 150], 30);
scenario("follower behind a stopped leader", [[0, 300], [12, 300]], [150, 0], 5);
scenario("four trains, different throttles", [[0, 300], [12, 300], [24, 300], [36, 300]], [100, 200, 300, 400], 30);

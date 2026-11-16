import { readFileSync } from "node:fs";
import { TrackGraph } from "@brr/domain";
import { SimSession, simTrackFromGraph } from "@brr/sim";
import { parseTrackCatalog } from "../catalog/src/track-catalog.ts";
import { buildTrackPlan } from "./src/scene/track-plan.ts";

const manifest = JSON.parse(
  readFileSync("../../tools/asset-pipeline/dist/bundle/standard/manifest.json", "utf8"),
);
const catalog = parseTrackCatalog(manifest.trackCatalog);
const plan = readFileSync(process.env.PLAN ?? "/tmp/ev/dogbone.plan", "utf8").trim();
const { layout, catalogPieces } = buildTrackPlan(plan, catalog);
const graph = new TrackGraph(layout);
const segments = [];
for (let e = 0; e < graph.edgeCount; e += 2) {
  const piece = catalogPieces[layout.piece(graph.edgePlacement[e] ?? 0)];
  segments.push([...(piece?.routes[graph.edgeRoute[e] ?? 0]?.segments ?? [])]);
}
const topology = {
  edgeCount: graph.edgeCount,
  switchCount: graph.switchCount,
  endXLdu: graph.endXLdu,
  endZLdu: graph.endZLdu,
  endHeading: graph.endHeading,
  edgeFromEnd: graph.edgeFromEnd,
  edgeToEnd: graph.edgeToEnd,
  successorStart: graph.successorStart,
  successors: graph.successors,
  edgeSwitch: graph.edgeSwitch,
  placementCount: graph.placementCount,
  edgePlacement: graph.edgePlacement,
  edgeRoute: graph.edgeRoute,
  endPlacement: graph.endPlacement,
  endPartner: graph.endPartner,
  switchEnd: graph.switchEnd,
};
const built = simTrackFromGraph(topology, segments);
const vehicle = { lengthLdu: 706, frontBogieLdu: 183, rearBogieLdu: 523 };
const spec = {
  vehicles: [vehicle],
  maxSpeedLduPerS: 400,
  accelerationLduPerS2: 150,
  brakingLduPerS2: 300,
};
const starts = (process.env.TRAINS ?? "70@300;30@100;110@100")
  .split(";")
  .map((t) => t.split("@").map(Number));
const blocks = process.env.BLOCKS !== "0";
const seed = Number(process.env.SEED ?? 1);
const ticks = Number(process.env.TICKS ?? 60 * 60 * 60 * 2);
const session = new SimSession({
  track: built.track,
  capacity: { trains: starts.length, vehicles: starts.length },
  trains: starts.map(([edge, offsetLdu]) => ({
    spec,
    placement: { edge: edge ?? 0, offsetLdu: offsetLdu ?? 0 },
  })),
  ...(blocks ? { railway: { topology, autopilotSeed: seed } } : {}),
});
const sim = session.simulation;
if (!blocks)
  for (let t = 0; t < starts.length; t++)
    session.apply({ kind: "throttle", train: t, speedLduPerS: 400 });

const stamp = new Int32Array(graph.placementCount).fill(-1);
const owner = new Int32Array(graph.placementCount);
function bodySharesPiece(): boolean {
  let shared = false;
  for (let t = 0; t < sim.trains; t++) {
    let edge = sim.trainEdge[t] ?? 0;
    let covered = sim.trainOffset[t] ?? 0;
    for (;;) {
      const placement = graph.edgePlacement[edge] ?? 0;
      if (stamp[placement] === sim.tick && owner[placement] !== t) shared = true;
      stamp[placement] = sim.tick;
      owner[placement] = t;
      if (covered >= vehicle.lengthLdu) break;
      const back = graph.successor(graph.reverse(edge), sim.switchStates);
      if (back < 0) break;
      edge = graph.reverse(back);
      covered += built.track.edgeLength[edge] ?? 0;
    }
  }
  return shared;
}

let sharedTicks = 0;
let firstSharedTick = -1;
let lastArrivals = 0;
let lastArrivalTick = 0;
let longestGapTicks = 0;
let distance = 0;
const started = performance.now();
for (let i = 0; i < ticks; i++) {
  sim.step();
  for (let t = 0; t < sim.trains; t++) distance += (sim.trainSpeed[t] ?? 0) / 60;
  if (bodySharesPiece()) {
    sharedTicks++;
    if (firstSharedTick < 0) firstSharedTick = sim.tick;
  }
  const arrivals = sim.blocks ? Array.from(sim.blocks.arrivals).reduce((a, b) => a + b, 0) : 0;
  if (arrivals !== lastArrivals) {
    longestGapTicks = Math.max(longestGapTicks, sim.tick - lastArrivalTick);
    lastArrivalTick = sim.tick;
    lastArrivals = arrivals;
  }
}
if (sim.blocks) longestGapTicks = Math.max(longestGapTicks, sim.tick - lastArrivalTick);
console.log(
  JSON.stringify({
    blocks,
    seed: blocks ? seed : null,
    trains: sim.trains,
    simulatedSeconds: sim.tick / 60,
    wallMs: Math.round(performance.now() - started),
    harnessSharedPieceTicks: sharedTicks,
    firstSharedPieceAtSecond: firstSharedTick < 0 ? null : firstSharedTick / 60,
    simMonitorSharedPieceTicks: blocks ? sim.separationCounters[0] : null,
    simMonitorMinBogieSeparationLdu: blocks ? Math.round(sim.separationCounters[1] ?? 0) : null,
    arrivalsPerTrain: sim.blocks ? Array.from(sim.blocks.arrivals) : null,
    longestSecondsWithoutAnyArrival: blocks ? longestGapTicks / 60 : null,
    trainKilometres: (distance * 0.4) / 1e6,
    stateHash: sim.stateHash().toString(16),
  }),
);

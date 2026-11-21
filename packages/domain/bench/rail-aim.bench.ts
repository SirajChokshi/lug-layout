import { PerformanceObserver, performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { NO_SWITCH } from "../src/track/track-graph.ts";
import {
  placeSegments,
  segmentsEnd,
  type PlanPose,
  type SimPathSegment,
} from "../src/rail/route-geometry.ts";
import {
  RAIL_SPOT_FLOATS,
  RailNetwork,
  RailRun,
  SPOT_EDGE,
  SPOT_OFFSET,
} from "../src/rail/rail-network.ts";
import {
  GEOMETRY_FIELDS,
  RunningGearPoser,
  VEHICLE_POSE_FLOATS,
  packGeometry,
  type VehicleGeometry,
} from "../src/rail/running-gear.ts";
import { backwardEdge, buildSimTrack, forwardEdge, type SimRoute } from "../src/rail/sim-track.ts";

const RADIUS = 800;
const ARCS_PER_HALF = 8;
const STRAIGHTS_PER_SIDE = 24;
const AIMS = 200_000;
const WARMUP_AIMS = 20_000;
const SPREAD_LDU = 60;
const VEHICLES = 3;
const ARC: SimPathSegment = {
  kind: "arc",
  radiusLdu: RADIUS,
  sweepRadians: Math.PI / ARCS_PER_HALF,
};
const STRAIGHT: SimPathSegment = { kind: "straight", lengthLdu: 320 };
const GUIDE = (pivotXLdu: number): VehicleGeometry["front"] => ({
  pivotXLdu,
  pivotZLdu: 0,
  leadAxleXLdu: pivotXLdu + 40,
  trailAxleXLdu: pivotXLdu - 40,
  axleZLdu: 0,
  pivots: true,
});
const CAR: VehicleGeometry = {
  front: GUIDE(170),
  rear: GUIDE(-170),
  frontCoupler: { xLdu: 345, zLdu: 0, mount: "body" },
  rearCoupler: { xLdu: -345, zLdu: 0, mount: "body" },
};

const segments = [
  ...Array.from({ length: ARCS_PER_HALF }, () => ARC),
  ...Array.from({ length: STRAIGHTS_PER_SIDE }, () => STRAIGHT),
  ...Array.from({ length: ARCS_PER_HALF }, () => ARC),
  ...Array.from({ length: STRAIGHTS_PER_SIDE }, () => STRAIGHT),
];
const routes: SimRoute[] = [];
let at: PlanPose = { x: 0, z: -RADIUS, heading: 0 };
for (const segment of segments) {
  const to = segmentsEnd(at, placeSegments(at, [segment]));
  routes.push({ from: at, to, segments: [segment] });
  at = to;
}
const count = routes.length;
const successors = routes.flatMap((_, r) => [
  [forwardEdge((r + 1) % count)],
  [backwardEdge((r + count - 1) % count)],
]);
const { track } = buildSimTrack({
  routes,
  successors,
  switchOfEdge: successors.map(() => NO_SWITCH),
  switchCount: 0,
});
const network = new RailNetwork(track, new Uint8Array(0));
const run = new RailRun(network);
const poser = new RunningGearPoser();
const geometry = new Float64Array(VEHICLES * GEOMETRY_FIELDS);
const geometryAt = new Int32Array(VEHICLES);
for (let v = 0; v < VEHICLES; v++) {
  geometryAt[v] = v * GEOMETRY_FIELDS;
  packGeometry(CAR, geometry, v * GEOMETRY_FIELDS);
}
const lengthLdu = VEHICLES * 2 * CAR.frontCoupler.xLdu;
const poses = new Float64Array(VEHICLES * VEHICLE_POSE_FLOATS);
const lengths = new Float64Array(1);
const spot = new Float64Array(RAIL_SPOT_FLOATS);
const point = new Float64Array(2);
let totalLdu = 0;
for (let edge = 0; edge < track.edgeCount; edge += 2) totalLdu += network.edgeLength(edge);

function aim(aims: number): number {
  let seated = 0;
  for (let k = 0; k < aims; k++) {
    point[0] = (k * 7919) % totalLdu;
    let edge = 0;
    while (point[0] > network.edgeLength(edge)) {
      point[0] -= network.edgeLength(edge);
      edge += 2;
    }
    network.point(edge, point, 0);
    const off = ((k % 5) - 2) * (SPREAD_LDU / 2);
    if (!network.nearest((point[0] ?? 0) + off, (point[1] ?? 0) - off, spot)) continue;
    if (!network.seat(spot[SPOT_EDGE] ?? 0, spot[SPOT_OFFSET] ?? 0, lengthLdu, spot)) continue;
    if (!run.standAt(spot[SPOT_EDGE] ?? 0, spot[SPOT_OFFSET] ?? 0, lengthLdu)) continue;
    poser.writeTrain(run, geometry, geometryAt, 0, VEHICLES, false, null, 0, poses, 0, lengths, 0);
    seated++;
  }
  return seated;
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });
const collectGarbage = (globalThis as { gc?: () => void }).gc;

aim(WARMUP_AIMS);
collectGarbage?.();
await new Promise((resolve) => setTimeout(resolve, 50));
const gcBefore = collections;
const heapBefore = process.memoryUsage().heapUsed;
const start = performance.now();
const seated = aim(AIMS);
const ms = performance.now() - start;
const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
await new Promise((resolve) => setTimeout(resolve, 50));
const gcs = collections - gcBefore;
observer.disconnect();

process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"} (${cpus().length} threads)`,
    `an oval of ${count} routes (${2 * ARCS_PER_HALF} R40 arcs, ${2 * STRAIGHTS_PER_SIDE} straights); each aim finds the nearest centreline point, seats a ${VEHICLES}-car consist there and poses its bogies`,
    "",
    "| Aims | Seated | ms | µs each | GCs | Heap growth (bytes) |",
    "|---|---|---|---|---|---|",
    `| ${AIMS.toLocaleString("en-US")} | ${seated.toLocaleString("en-US")} | ${ms.toFixed(1)} | ${((ms * 1e3) / AIMS).toFixed(2)} | ${gcs} | ${heapGrowth} |`,
    "",
  ].join("\n"),
);

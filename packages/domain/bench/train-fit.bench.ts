import { PerformanceObserver, performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { NO_SWITCH } from "../src/track/track-graph.ts";
import {
  pointOnSegment,
  placeSegments,
  type SimPathSegment,
} from "../src/track-path/route-geometry.ts";
import { buildSimTrack, type SimRoute } from "../src/track-path/sim-track.ts";
import { fitTrain, TRAIN_FIT_FLOATS, trainsOverlap } from "../src/rolling-stock/train-fit.ts";
import {
  nearestTrackPoint,
  pointEdge,
  pointOffset,
  TRACK_POINT_FLOATS,
  TrainPath,
} from "../src/rolling-stock/train-path.ts";

const RADIUS_LDU = 800;
const ARCS = 16;
const STRAIGHT_LDU = 320;
const STRAIGHTS_PER_SIDE = 6;
const CONSIST_LDU = 1254;
const PLACED_LDU = 706;
const PICK_LDU = 60;
const AIMS = 20_000;
const WARMUP_AIMS = 2_000;

function oval(): ReturnType<typeof buildSimTrack>["track"] {
  const segments: SimPathSegment[] = [];
  for (let side = 0; side < 2; side++) {
    for (let s = 0; s < STRAIGHTS_PER_SIDE; s++)
      segments.push({ kind: "straight", lengthLdu: STRAIGHT_LDU });
    for (let a = 0; a < ARCS / 2; a++) {
      segments.push({ kind: "arc", radiusLdu: RADIUS_LDU, sweepRadians: (2 * Math.PI) / ARCS });
    }
  }
  const routes: SimRoute[] = [];
  let at = { x: 0, z: 0, heading: 0 };
  for (const segment of segments) {
    const placed = placeSegments(at, [segment]);
    const last = placed[0];
    if (!last) throw new Error("a segment places nothing");
    const to = pointOnSegment(last, last.length);
    routes.push({ from: at, to, segments: [segment] });
    at = to;
  }
  const n = routes.length;
  const successors: number[][] = [];
  for (let e = 0; e < 2 * n; e++) {
    successors.push([e % 2 === 0 ? (e + 2) % (2 * n) : (e - 2 + 2 * n) % (2 * n)]);
  }
  return buildSimTrack({
    routes,
    successors,
    switchOfEdge: successors.map(() => NO_SWITCH),
    switchCount: 0,
  }).track;
}

const track = oval();
const aimPath = new TrainPath(track);
const placedPath = new TrainPath(track);
const fit = new Float64Array(TRAIN_FIT_FLOATS);
const point = new Float64Array(TRACK_POINT_FLOATS);
const scratch = new Float64Array(2);
const routePlacement = Int32Array.from({ length: track.edgeCount / 2 }, (_, route) => route);
if (!placedPath.stand(0, 300, PLACED_LDU)) throw new Error("the placed consist does not stand");

const cursorX = Float64Array.from(
  { length: AIMS + WARMUP_AIMS },
  (_, k) => -900 + ((k * 37) % 3600),
);
const cursorZ = Float64Array.from({ length: AIMS + WARMUP_AIMS }, (_, k) => ((k * 53) % 1700) - 40);

let fits = 0;
let clashes = 0;
function aim(k: number): void {
  if (!nearestTrackPoint(track, cursorX[k] ?? 0, cursorZ[k] ?? 0, PICK_LDU, scratch, point)) return;
  if (!fitTrain(track, aimPath, pointEdge(point), pointOffset(point), CONSIST_LDU, fit)) return;
  fits++;
  if (trainsOverlap(aimPath, CONSIST_LDU, placedPath, PLACED_LDU, routePlacement)) clashes++;
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

for (let k = 0; k < WARMUP_AIMS; k++) aim(k);
await new Promise((resolve) => setTimeout(resolve, 50));
const gcBefore = collections;
const start = performance.now();
for (let k = WARMUP_AIMS; k < AIMS + WARMUP_AIMS; k++) aim(k);
const elapsedMs = performance.now() - start;
await new Promise((resolve) => setTimeout(resolve, 50));
observer.disconnect();
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}, ${track.edgeCount / 2}-route oval`,
    "| aims | elapsed ms | µs per aim | fits | overlaps | GCs during run |",
    "|---|---|---|---|---|---|",
    `| ${AIMS} | ${elapsedMs.toFixed(1)} | ${((elapsedMs * 1000) / AIMS).toFixed(2)} | ${fits} | ${clashes} | ${collections - gcBefore} |`,
    "",
  ].join("\n"),
);

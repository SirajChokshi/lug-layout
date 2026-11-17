import { PerformanceObserver, performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { NO_STUD, RoadNetwork, type RoadPlacement, type RoadSurface } from "@brr/domain";
import { cellExtent, snapToRoadEdge } from "../src/edit/road-snap.ts";

const PLATE_STUDS = 32;
const STUD_LDU = 20;
const PLATE_LDU = PLATE_STUDS * STUD_LDU;
const ROAD_TOP_LDU = 8;
const GRID_SIDES = [4, 8, 12, 16] as const;
const WARMUP_MOVES = 20;
const MOVES = 200;
const CURSOR_INSET_LDU = 100;

const cells = PLATE_STUDS * PLATE_STUDS;
const surface: RoadSurface = {
  minX: -PLATE_LDU / 2,
  minZ: -PLATE_LDU / 2,
  columns: PLATE_STUDS,
  rows: PLATE_STUDS,
  top: new Int32Array(cells).fill(ROAD_TOP_LDU),
  stud: new Int32Array(cells).fill(NO_STUD),
  road: new Uint8Array(cells).fill(1),
};

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });

function msPerMove(work: () => void): readonly [number, number] {
  for (let i = 0; i < WARMUP_MOVES; i++) work();
  const gcBefore = collections;
  const start = performance.now();
  for (let i = 0; i < MOVES; i++) work();
  return [(performance.now() - start) / MOVES, collections - gcBefore];
}

const rows: string[] = [];
for (const side of GRID_SIDES) {
  const placements: RoadPlacement[] = [];
  for (let i = 0; i < side; i++) {
    for (let j = 0; j < side; j++) {
      placements.push({
        id: placements.length,
        x: i * PLATE_LDU,
        z: j * PLATE_LDU,
        yLdu: 0,
        rot: 0,
        surface,
      });
    }
  }
  const network = new RoadNetwork(placements);
  const extents = placements.map(cellExtent);
  const cursorX = side * PLATE_LDU - CURSOR_INSET_LDU;
  const cursorZ = PLATE_LDU / 2 - CURSOR_INSET_LDU;
  const snap = snapToRoadEdge(network, extents, surface, 0, 0, cursorX, cursorZ);
  if (!snap) throw new Error(`the cursor at ${cursorX}, ${cursorZ} does not snap`);
  const ghost: RoadPlacement = { id: -1, x: snap.x, z: snap.z, yLdu: 0, rot: 0, surface };
  const [snapMs, snapGcs] = msPerMove(() => {
    snapToRoadEdge(network, extents, surface, 0, 0, cursorX, cursorZ);
  });
  const [seamMs, seamGcs] = msPerMove(() => {
    network.seams(ghost);
  });
  const joined = network.seams(ghost).length;
  rows.push(
    `| ${placements.length} | ${snapMs.toFixed(2)} | ${seamMs.toFixed(2)} | ${(snapMs + seamMs).toFixed(2)} | ${joined} | ${snapGcs + seamGcs} |`,
  );
}
observer.disconnect();
process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"}, ${MOVES} snapped moves per row`,
    "| road plates | snap ms/move | seams ms/move | total ms/move | seam segments | GCs during run |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"),
);

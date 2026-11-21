import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { SIXTEENTHS_PER_LDU } from "@brr/math";
import measured from "../../../docs/verified-facts/geometry.json" with { type: "json" };
import { levelCrossings, type CrossingTrack } from "../src/level-crossings.ts";
import { PlacedOutline } from "../src/plan/placed-outline.ts";
import { NO_STUD, type RoadPlacement, type RoadSurface } from "../src/road-joins.ts";

const STUD = 20;
const BASEPLATE_SPAN = 640;
const TRACK_WIDTH_LDU = 8 * STUD;
const TRACKS = 4;
const TRACK_PLATES = 4;
const RAIL_TOP_LDU = 24;
const WARMUP = 3;
const RUNS = 15;
const DENSE_WARMUP = 1;
const DENSE_RUNS = 3;
const DENSE_FIELD = 16;
const FIELDS: ReadonlyArray<number> = [16, 32];

function straightSurface(): RoadSurface {
  const map = measured.roadStudZones.find((entry) => entry.part === "44336")?.map ?? [];
  if (map.length === 0) throw new Error("the road geometry facts are missing");
  const columns = map[0]?.length ?? 0;
  const rows = map.length;
  const top = new Int32Array(rows * columns);
  const stud = new Int32Array(rows * columns).fill(NO_STUD);
  const road = new Uint8Array(rows * columns);
  for (let index = 0; index < rows * columns; index++) {
    const studded = map[Math.floor(index / columns)]?.[index % columns] === "o";
    top[index] = 0;
    if (studded) stud[index] = 0;
    road[index] = studded ? 0 : 1;
  }
  return {
    minX: (-columns * STUD) / 2,
    minZ: (-rows * STUD) / 2,
    columns,
    rows,
    topSixteenths: top,
    studSixteenths: stud,
    road,
  };
}

const straight = straightSurface();

function field(side: number): ReadonlyArray<RoadPlacement> {
  const placements: RoadPlacement[] = [];
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      placements.push({
        id: placements.length,
        x: column * BASEPLATE_SPAN,
        z: row * BASEPLATE_SPAN,
        yLdu: 0,
        rot: 0,
        surface: straight,
      });
    }
  }
  return placements;
}

function crossingTracks(side: number): ReadonlyArray<CrossingTrack> {
  const tracks: CrossingTrack[] = [];
  for (let t = 0; t < TRACKS; t++) {
    const z = Math.floor(((t + 1) * side) / (TRACKS + 1)) * BASEPLATE_SPAN;
    const minX = Math.floor(side / 2) * BASEPLATE_SPAN - BASEPLATE_SPAN / 2;
    tracks.push({
      outline: PlacedOutline.ofRect({
        minX,
        minZ: z - TRACK_WIDTH_LDU / 2,
        maxX: minX + TRACK_PLATES * BASEPLATE_SPAN,
        maxZ: z + TRACK_WIDTH_LDU / 2,
      }),
      bedLdu: 0,
      railTopLdu: RAIL_TOP_LDU,
    });
  }
  return tracks;
}

function trackDownEveryRow(side: number): ReadonlyArray<CrossingTrack> {
  const tracks: CrossingTrack[] = [];
  for (let row = 0; row < side; row++) {
    const z = row * BASEPLATE_SPAN;
    tracks.push({
      outline: PlacedOutline.ofRect({
        minX: -BASEPLATE_SPAN / 2,
        minZ: z - TRACK_WIDTH_LDU / 2,
        maxX: side * BASEPLATE_SPAN - BASEPLATE_SPAN / 2,
        maxZ: z + TRACK_WIDTH_LDU / 2,
      }),
      bedLdu: 0,
      railTopLdu: RAIL_TOP_LDU,
    });
  }
  return tracks;
}

function medianMs(
  call: () => number,
  warmup = WARMUP,
  runs = RUNS,
): { readonly ms: number; readonly result: number } {
  let result = 0;
  for (let i = 0; i < warmup; i++) result = call();
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    result = call();
    samples.push(performance.now() - start);
  }
  return { ms: samples.toSorted((a, b) => a - b)[Math.floor(runs / 2)] ?? 0, result };
}

const lines = [
  `cpu: ${cpus()[0]?.model ?? "unknown"} x${cpus().length}, node ${process.version}; straight track strips across a field of 44336 road surfaces, ${SIXTEENTHS_PER_LDU} sixteenths per LDU; median of ${RUNS} calls (${DENSE_RUNS} for the dense row)`,
  "",
  "| Field | Tracks | Road placements | Road cells | levelCrossings median ms | Crossings | Roadway cells |",
  "|---|---|---:|---:|---:|---:|---:|",
];
const scenes = [
  ...FIELDS.map((side) => ({
    side,
    tracks: crossingTracks(side),
    label: `${TRACKS} strips, ${TRACK_PLATES} plates long`,
    warmup: WARMUP,
    runs: RUNS,
  })),
  {
    side: DENSE_FIELD,
    tracks: trackDownEveryRow(DENSE_FIELD),
    label: "one strip down every row, full width",
    warmup: DENSE_WARMUP,
    runs: DENSE_RUNS,
  },
];
for (const { side, tracks, label, warmup, runs } of scenes) {
  const roads = field(side);
  let roadway = 0;
  const { ms, result } = medianMs(
    () => {
      const crossings = levelCrossings(roads, tracks, []);
      roadway = crossings.reduce((sum, crossing) => sum + crossing.roadwayCells, 0);
      return crossings.length;
    },
    warmup,
    runs,
  );
  lines.push(
    `| ${side} x ${side} | ${label} | ${roads.length} | ${roads.length * straight.columns * straight.rows} | ${ms.toFixed(1)} | ${result} | ${roadway} |`,
  );
}
process.stdout.write(`${lines.join("\n")}\n`);

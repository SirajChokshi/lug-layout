import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { GCProfiler, getHeapSpaceStatistics } from "node:v8";
import { SIXTEENTHS_PER_LDU } from "@brr/math";
import measured from "../../../docs/verified-facts/geometry.json" with { type: "json" };
import { LevelCrossings, levelCrossings, type CrossingTrack } from "../src/level-crossings.ts";
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
    occupied: new Uint8Array(top.length).fill(1),
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
const gateSide = FIELDS[FIELDS.length - 1] ?? DENSE_FIELD;
const gateRoads = field(gateSide);
const gateTracks = crossingTracks(gateSide);
const farRoad: RoadPlacement = {
  id: gateRoads.length,
  x: -100 * BASEPLATE_SPAN,
  z: 0,
  yLdu: 0,
  rot: 0,
  surface: straight,
};
const farTrack: CrossingTrack = {
  outline: PlacedOutline.ofRect({ minX: -100_000, minZ: -100_000, maxX: -99_000, maxZ: -99_840 }),
  bedLdu: 0,
  railTopLdu: RAIL_TOP_LDU,
};
const acrossTrack = trackDownEveryRow(gateSide)[1];
if (!acrossTrack) throw new Error("no track to lay across the field");
const [firstStrip] = gateTracks;
if (!firstStrip) throw new Error("the field has no strips");
const overOneCrossing: CrossingTrack = {
  outline: PlacedOutline.ofRect({
    minX: firstStrip.outline.bounds.minX,
    minZ: firstStrip.outline.bounds.minZ,
    maxX: firstStrip.outline.bounds.minX + TRACK_WIDTH_LDU,
    maxZ: firstStrip.outline.bounds.maxZ,
  }),
  bedLdu: 0,
  railTopLdu: RAIL_TOP_LDU,
};
const gate = new LevelCrossings([]);
gate.crossings(gateRoads, gateTracks);
const alternate = (a: () => void, b: () => void): (() => number) => {
  let flip = false;
  return () => {
    flip = !flip;
    (flip ? a : b)();
    return 0;
  };
};
const YOUNG_GENERATION_SPACES: ReadonlyArray<string> = ["new_space", "new_large_object_space"];

function youngGenerationBytes(): number {
  let bytes = 0;
  for (const space of getHeapSpaceStatistics()) {
    if (YOUNG_GENERATION_SPACES.includes(space.space_name)) bytes += space.space_used_size;
  }
  return bytes;
}

function youngUsedIn(
  spaces: ReadonlyArray<{ readonly spaceName: string; readonly spaceUsedSize: number }>,
): number {
  let bytes = 0;
  for (const space of spaces) {
    if (YOUNG_GENERATION_SPACES.includes(space.spaceName)) bytes += space.spaceUsedSize;
  }
  return bytes;
}

function youngBytesAllocatedBy(run: () => void): number {
  const profiler = new GCProfiler();
  profiler.start();
  const before = youngGenerationBytes();
  run();
  const after = youngGenerationBytes();
  let collected = 0;
  for (const collection of profiler.stop().statistics) {
    collected +=
      youngUsedIn(collection.beforeGC.heapSpaceStatistics) -
      youngUsedIn(collection.afterGC.heapSpaceStatistics);
  }
  return after - before + collected;
}

function youngBytesPerCall(call: () => number): number {
  for (let i = 0; i < WARMUP; i++) call();
  return (
    youngBytesAllocatedBy(() => {
      for (let i = 0; i < RUNS; i++) call();
    }) / RUNS
  );
}

const withFarRoad = [...gateRoads, farRoad];
const withFarTrack = [...gateTracks, farTrack];
const withAcross = [...gateTracks, acrossTrack];
const withOverOne = [...gateTracks, overOneCrossing];
const farRoadEdit = alternate(
  () => gate.crossings(withFarRoad, gateTracks),
  () => gate.crossings(gateRoads, gateTracks),
);
const farTrackEdit = alternate(
  () => gate.crossings(gateRoads, withFarTrack),
  () => gate.crossings(gateRoads, gateTracks),
);
function median(samples: ReadonlyArray<number>): number {
  return samples.toSorted((a, b) => a - b)[Math.floor(samples.length / 2)] ?? 0;
}

function takeUp(): number {
  return gate.crossings(gateRoads, gateTracks).length;
}

function layAndTakeUp(withTrack: ReadonlyArray<CrossingTrack>): {
  readonly layMs: number;
  readonly takeUpMs: number;
  readonly layBytes: number;
} {
  const lay = (): number => gate.crossings(gateRoads, withTrack).length;
  const layMs: number[] = [];
  const takeUpMs: number[] = [];
  for (let i = -WARMUP; i < RUNS; i++) {
    const laid = performance.now();
    lay();
    const takenUp = performance.now();
    takeUp();
    const done = performance.now();
    if (i < 0) continue;
    layMs.push(takenUp - laid);
    takeUpMs.push(done - takenUp);
  }
  let layBytes = 0;
  for (let i = 0; i < RUNS; i++) {
    layBytes += youngBytesAllocatedBy(lay);
    takeUp();
  }
  return { layMs: median(layMs), takeUpMs: median(takeUpMs), layBytes: layBytes / RUNS };
}
const crossingsKept = gate.crossings(gateRoads, gateTracks).length;
const farRoadMs = medianMs(farRoadEdit).ms;
const farTrackMs = medianMs(farTrackEdit).ms;
const across = layAndTakeUp(withAcross);
const overOne = layAndTakeUp(withOverOne);
const farRoadBytes = youngBytesPerCall(farRoadEdit);
const farTrackBytes = youngBytesPerCall(farTrackEdit);

lines.push(
  "",
  `LevelCrossings kept across edits on the ${gateSide} x ${gateSide} field with ${TRACKS} strips and ${crossingsKept} crossings (median ms per call, edits alternating with their undo):`,
  "",
  "| Edit | ms | Young-generation bytes per call |",
  "|---|---:|---:|",
  `| a road added and removed far from every track (reused) | ${farRoadMs.toFixed(3)} | ${Math.round(farRoadBytes)} |`,
  `| a track added and removed far from every road (reused) | ${farTrackMs.toFixed(3)} | ${Math.round(farTrackBytes)} |`,
  `| a track laid across the field far from every crossing (its own crossings built, the rest reused) | ${across.layMs.toFixed(1)} | ${Math.round(across.layBytes)} |`,
  `| that track taken up | ${across.takeUpMs.toFixed(2)} | - |`,
  `| a short track laid over one crossing (that crossing rebuilt, the rest reused) | ${overOne.layMs.toFixed(2)} | ${Math.round(overOne.layBytes)} |`,
  `| that short track taken up (that crossing rebuilt, the rest reused) | ${overOne.takeUpMs.toFixed(2)} | - |`,
);
process.stdout.write(`${lines.join("\n")}\n`);

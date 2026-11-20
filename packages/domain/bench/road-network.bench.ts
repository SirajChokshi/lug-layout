import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { getHeapSpaceStatistics } from "node:v8";
import measured from "../../../docs/verified-facts/geometry.json" with { type: "json" };
import { RoadFit } from "../src/road-fit.ts";
import { NO_STUD, RoadNetwork, type RoadPlacement, type RoadSurface } from "../src/road-joins.ts";

const STUD = 20;
const BASEPLATE_SPAN = 640;
const CITY_SIDE = 8;
const PLATE_ROW = 16;
const PLATE_SPAN = 320;
const ROOF_TOP_LDU = 72;
const ROOF_COLUMNS = 4;
const ROOF_ROWS = 8;
const QUARTER_TURNS = 4;
const HOVER_ROUNDS = 40;
const WARMUP_CALLS = 200;
const WARMUP_CHANGES = 1000;
const FAR_LDU = 1_000_000;
const REPORTS = 20;
const BUILDS = 20;
const SETTLE_MS = 50;
const YOUNG_GENERATION_SPACES: ReadonlyArray<string> = ["new_space", "new_large_object_space"];

function surfaceOf(
  columns: number,
  rows: number,
  cell: (index: number) => readonly [number, number, number],
): RoadSurface {
  const top = new Int32Array(rows * columns);
  const stud = new Int32Array(rows * columns);
  const road = new Uint8Array(rows * columns);
  for (let index = 0; index < rows * columns; index++) {
    const [t, s, r] = cell(index);
    top[index] = t;
    stud[index] = s;
    road[index] = r;
  }
  return { minX: (-columns * STUD) / 2, minZ: (-rows * STUD) / 2, columns, rows, top, stud, road };
}

function studMapSurface(map: ReadonlyArray<string>, studTop: number, top: number): RoadSurface {
  const columns = map[0]?.length ?? 0;
  return surfaceOf(columns, map.length, (index) => {
    const studded = map[Math.floor(index / columns)]?.[index % columns] === "o";
    return studded ? [top, studTop, studTop < top ? 1 : 0] : [top, NO_STUD, 1];
  });
}

const straightMap = measured.roadStudZones.find((entry) => entry.part === "44336")?.map ?? [];
const recessed = measured.recessedRoadPlates.find((entry) => entry.part === "69958");
if (straightMap.length === 0 || !recessed) throw new Error("the road geometry facts are missing");
const straight = studMapSurface(straightMap, 0, 0);
const plate = studMapSurface(
  recessed.studMap,
  recessed.thicknessLdu - recessed.recessFloorBelowTopLdu,
  recessed.thicknessLdu,
);
const roof = surfaceOf(ROOF_COLUMNS, ROOF_ROWS, () => [ROOF_TOP_LDU, NO_STUD, 1]);
const marker = surfaceOf(1, 1, () => [0, NO_STUD, 0]);

function city(): ReadonlyArray<RoadPlacement> {
  const placements: RoadPlacement[] = [];
  for (let row = 0; row < CITY_SIDE; row++) {
    for (let column = 0; column < CITY_SIDE; column++) {
      const x = column * BASEPLATE_SPAN;
      const z = row * BASEPLATE_SPAN;
      placements.push({ id: placements.length, x, z, yLdu: 0, rot: 0, surface: straight });
      placements.push({ id: placements.length, x, z, yLdu: 0, rot: 0, surface: roof });
    }
  }
  for (let p = 0; p < PLATE_ROW; p++) {
    const x = p * PLATE_SPAN;
    const z = -BASEPLATE_SPAN / 2 - PLATE_SPAN / 2;
    placements.push({ id: placements.length, x, z, yLdu: 0, rot: 0, surface: plate });
  }
  return placements;
}

const placements = city();
const network = new RoadNetwork(placements);
const fit = new RoadFit();
const probe = { id: -1, x: 0, z: 0, yLdu: 0, rot: 0, surface: straight };
const slideFromX = (CITY_SIDE / 2 - 1) * BASEPLATE_SPAN;
const pastLastRowZ = CITY_SIDE * BASEPLATE_SPAN;
const pastPlateRowZ = -BASEPLATE_SPAN / 2 - PLATE_SPAN - PLATE_SPAN / 2;
const slidePositions = (2 * BASEPLATE_SPAN) / STUD;
const OFF_LATTICE_LDU = 7;
const PROBES_PER_STEP = 4;

function hover(rounds: number): number {
  let joining = 0;
  for (let round = 0; round < rounds; round++) {
    for (let rot = 0; rot < QUARTER_TURNS; rot++) {
      probe.rot = rot;
      for (let step = 0; step < slidePositions; step++) {
        probe.surface = straight;
        probe.x = slideFromX + step * STUD;
        probe.z = pastLastRowZ;
        if (network.cleanFit(probe, fit)) joining++;
        probe.z = pastLastRowZ - BASEPLATE_SPAN / 2;
        if (network.cleanFit(probe, fit)) joining++;
        probe.surface = plate;
        probe.x = step * STUD;
        probe.z = pastPlateRowZ;
        if (network.fit(probe, fit).joinedCells > 0) joining++;
        probe.x = step * STUD + OFF_LATTICE_LDU;
        if (network.fit(probe, fit).joinedCells > 0) joining++;
      }
    }
  }
  return joining;
}

function hoverCalls(rounds: number): number {
  return rounds * QUARTER_TURNS * slidePositions * PROBES_PER_STEP;
}

let markers = 0;

function changeNetwork(): void {
  const id = placements.length + markers;
  network.add({ id, x: FAR_LDU + markers * STUD, z: FAR_LDU, yLdu: 0, rot: 0, surface: marker });
  markers++;
}

function youngGenerationBytes(): number {
  let bytes = 0;
  for (const space of getHeapSpaceStatistics()) {
    if (YOUNG_GENERATION_SPACES.includes(space.space_name)) bytes += space.space_used_size;
  }
  return bytes;
}

interface Probe {
  readonly startMs: number;
  readonly endMs: number;
  readonly youngBytes: number;
  readonly joining: number;
}

function probeHover(rounds: number): Probe {
  const youngBefore = youngGenerationBytes();
  const startMs = performance.now();
  const joining = hover(rounds);
  const endMs = performance.now();
  return { startMs, endMs, youngBytes: youngGenerationBytes() - youngBefore, joining };
}

interface ColdProbe {
  readonly ms: number;
  readonly youngBytes: number;
  readonly windows: ReadonlyArray<readonly [number, number]>;
  readonly joining: number;
}

function probeCold(rounds: number, idleBytes: number): ColdProbe {
  let ms = 0;
  let youngBytes = 0;
  let joining = 0;
  const windows: Array<readonly [number, number]> = [];
  for (let round = 0; round < rounds; round++) {
    changeNetwork();
    const first = probeHover(1);
    ms += first.endMs - first.startMs;
    youngBytes += first.youngBytes - idleBytes;
    joining += first.joining;
    windows.push([first.startMs, first.endMs]);
  }
  return { ms, youngBytes, windows, joining };
}

function median(values: ReadonlyArray<number>): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function timed(runs: number, run: () => void): number {
  const ms: number[] = [];
  for (let r = 0; r < runs; r++) {
    const start = performance.now();
    run();
    ms.push(performance.now() - start);
  }
  return median(ms);
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

const collect: unknown = Reflect.get(globalThis, "gc");
if (typeof collect !== "function") throw new Error("run the road network bench with --expose-gc");
for (let change = 0; change < WARMUP_CHANGES; change++) changeNetwork();
for (let warm = 0; warm < WARMUP_CALLS; warm++) {
  changeNetwork();
  probeHover(1);
  probeHover(1);
}
probeHover(0);
const collections: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) collections.push(entry.startTime);
});
observer.observe({ entryTypes: ["gc"] });
await settle();
collect();
probeHover(0);
const idle = probeHover(0);
const cold = probeCold(HOVER_ROUNDS, idle.youngBytes);
changeNetwork();
probeHover(1);
const busy = probeHover(HOVER_ROUNDS);
await settle();
observer.disconnect();
const during = (from: number, to: number) => collections.filter((at) => at >= from && at <= to);
const coldGcs = cold.windows.reduce((sum, [from, to]) => sum + during(from, to).length, 0);
const gcs = during(busy.startMs, busy.endMs).length;
const allocated = busy.youngBytes - idle.youngBytes;
const calls = hoverCalls(HOVER_ROUNDS);
const coldNs = (cold.ms * 1e6) / calls;
const perCallNs = ((busy.endMs - busy.startMs) * 1e6) / calls;
const fresh = new RoadNetwork(placements);
collect();
await settle();
const buffersBefore = process.memoryUsage().arrayBuffers;
fresh.cleanFit(probe, fit);
const memoBytes = process.memoryUsage().arrayBuffers - buffersBefore;
const reportMs = timed(REPORTS, () => network.report());
const buildMs = timed(BUILDS, () => new RoadNetwork(placements));
const report = network.report();
const cells = placements.reduce((sum, p) => sum + p.surface.columns * p.surface.rows, 0);

process.stdout.write(
  [
    `cpu: ${cpus()[0]?.model ?? "unknown"} x${cpus().length}, node ${process.version}`,
    `method: ${CITY_SIDE}×${CITY_SIDE} measured 44336 straights, each with a ${ROOF_COLUMNS}×${ROOF_ROWS} studless roof stacked ${ROOF_TOP_LDU} LDU up on its roadway, and a row of ${PLATE_ROW} measured 69958 plates (${placements.length} placements, ${cells.toLocaleString("en-US")} cells; ${report.joinedCells} joined, ${report.openCells} open, ${report.mismatchedCells} mismatched). Hover: in each quarter turn, a 44336 slid stud by stud along the city's open road ends and again half overlapping the last row (cleanFit, as road snapping probes), plus a 69958 slid along the plate row on the lattice and ${OFF_LATTICE_LDU} LDU off it (fit). First fits after a change: each of ${HOVER_ROUNDS} timed rounds follows an untimed add of a one-cell marker far away, so no pose is remembered. Repeated poses: ${HOVER_ROUNDS} timed rounds of the same probes. ${WARMUP_CHANGES} warm-up changes and ${WARMUP_CALLS} warm-up runs of both first; young-generation bytes (less an empty probe's own) and GCs counted over the timed rounds only. Report and build: median of ${REPORTS} and ${BUILDS} runs.`,
    "",
    "| Work | Calls | ns per call | Calls that join | GCs during run | Bytes allocated during run |",
    "|---|---:|---:|---:|---:|---:|",
    `| hover fit and cleanFit, first fits after a change | ${calls.toLocaleString("en-US")} | ${coldNs.toFixed(0)} | ${cold.joining} | ${coldGcs} | ${cold.youngBytes} |`,
    `| hover fit and cleanFit, repeated poses | ${calls.toLocaleString("en-US")} | ${perCallNs.toFixed(0)} | ${busy.joining} | ${gcs} | ${allocated} |`,
    "",
    "| Work | ms (median) |",
    "|---|---:|",
    `| report | ${reportMs.toFixed(2)} |`,
    `| build the network | ${buildMs.toFixed(2)} |`,
    "",
    `A newly built network's first fit creates its fit memo once: ${memoBytes.toLocaleString("en-US")} bytes of typed arrays.`,
    "",
  ].join("\n"),
);
if (gcs + coldGcs !== 0 || allocated !== 0 || cold.youngBytes !== 0) {
  process.stderr.write(
    `road fits allocated: ${coldGcs} and ${gcs} collections, ${cold.youngBytes} and ${allocated} bytes\n`,
  );
  process.exitCode = 1;
}

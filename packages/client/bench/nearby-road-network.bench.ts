import { NO_STUD, RoadFit, type RoadPlacement, type RoadSurface } from "@brr/domain";
import { STUD_LDU } from "@brr/math";
import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { getHeapSpaceStatistics } from "node:v8";
import { NearbyRoadNetwork, RoadIndex, cellExtent } from "../src/edit/road-snap.ts";

const PLATE_STUDS = 32;
const PLATE_LDU = PLATE_STUDS * STUD_LDU;
const CITY_SIDE = 24;
const MARGIN_LDU = PLATE_LDU + 64 * STUD_LDU;
const ROUNDS = 40;
const WARMUP_ROUNDS = 200;
const SETTLE_MS = 50;
const QUARTER_TURNS = 4;
const SLIDE_STUDS = 16;
const YOUNG_GENERATION_SPACES: ReadonlyArray<string> = ["new_space", "new_large_object_space"];

function roadPlate(): RoadSurface {
  const cells = PLATE_STUDS * PLATE_STUDS;
  return {
    minX: -PLATE_LDU / 2,
    minZ: -PLATE_LDU / 2,
    columns: PLATE_STUDS,
    rows: PLATE_STUDS,
    topSixteenths: new Int32Array(cells),
    studSixteenths: new Int32Array(cells).fill(NO_STUD),
    road: new Uint8Array(cells).fill(1),
    occupied: new Uint8Array(cells).fill(1),
  };
}

const plate = roadPlate();
const recorded: RoadPlacement[] = [];
for (let row = 0; row < CITY_SIDE; row++) {
  for (let column = 0; column < CITY_SIDE; column++) {
    if ((row + column) % 3 === 0) continue;
    recorded.push({
      id: recorded.length,
      x: column * PLATE_LDU,
      z: row * PLATE_LDU,
      yLdu: 0,
      rot: 0,
      surface: plate,
    });
  }
}
const extents = recorded.map(cellExtent);
const nearby = new NearbyRoadNetwork(recorded, extents, RoadIndex.of(extents), MARGIN_LDU);
const fit = new RoadFit();
const centre = (CITY_SIDE / 2) * PLATE_LDU;
const probe: RoadPlacement = { id: -1, x: centre, z: centre, yLdu: 0, rot: 0, surface: plate };

function carry(): number {
  let joining = 0;
  for (let rot = 0; rot < QUARTER_TURNS; rot++) {
    probe.rot = rot;
    for (let step = -SLIDE_STUDS; step <= SLIDE_STUDS; step++) {
      probe.x = centre + step * STUD_LDU;
      if (nearby.cleanFit(probe, fit)) joining++;
      if (nearby.fit(probe, fit).joinedCells > 0) joining++;
      if (nearby.cleanContact(probe, fit)) joining++;
    }
  }
  return joining;
}

function youngGenerationBytes(): number {
  let bytes = 0;
  for (const space of getHeapSpaceStatistics()) {
    if (YOUNG_GENERATION_SPACES.includes(space.space_name)) bytes += space.space_used_size;
  }
  return bytes;
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

const collect: unknown = Reflect.get(globalThis, "gc");
if (typeof collect !== "function")
  throw new Error("run the nearby road network bench with --expose-gc");
const fillStart = performance.now();
carry();
const fillMs = performance.now() - fillStart;
for (let warm = 0; warm < WARMUP_ROUNDS; warm++) carry();
const collections: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) collections.push(entry.startTime);
});
observer.observe({ entryTypes: ["gc"] });
await settle();
interface Probe {
  readonly startMs: number;
  readonly endMs: number;
  readonly youngBytes: number;
  readonly joining: number;
}

function probeCarries(rounds: number): Probe {
  const youngBefore = youngGenerationBytes();
  const startMs = performance.now();
  let joined = 0;
  for (let round = 0; round < rounds; round++) joined += carry();
  const endMs = performance.now();
  return { startMs, endMs, youngBytes: youngGenerationBytes() - youngBefore, joining: joined };
}

collect();
probeCarries(0);
const idle = probeCarries(0);
const busy = probeCarries(ROUNDS);
const { startMs: start, endMs: end, joining } = busy;
const allocated = busy.youngBytes - idle.youngBytes;
await settle();
observer.disconnect();
const gcs = collections.filter((at) => at >= start && at <= end).length;
const calls = ROUNDS * QUARTER_TURNS * (2 * SLIDE_STUDS + 1) * 3;

process.stdout.write(
  [
    `cpu: ${cpus()[0]?.model ?? "unknown"} x${cpus().length}, node ${process.version}`,
    `method: a ${CITY_SIDE}×${CITY_SIDE} grid of 32×32 all-road plates with every third left out (${recorded.length} placements), read through a NearbyRoadNetwork with a ${MARGIN_LDU} LDU margin, as a dragged plate's snap reads the roads left after the pick-up. A plate carried ${SLIDE_STUDS} studs either way in each quarter turn asks fit, cleanFit and cleanContact at every stud; the first carry fills the region (a partial refill: the region holds the plates near the carry, under the 80,000-cell covering threshold), ${WARMUP_ROUNDS} warm-up carries follow, then ${ROUNDS} timed carries, all served by that one region. Young-generation bytes and GCs counted over the timed carries only.`,
    "",
    "| Work | Calls | ns per call | Calls that join | GCs during run | Bytes allocated during run |",
    "|---|---:|---:|---:|---:|---:|",
    `| served fits on a filled region | ${calls.toLocaleString("en-US")} | ${(((end - start) * 1e6) / calls).toFixed(0)} | ${joining} | ${gcs} | ${allocated} |`,
    "",
    `The first carry, which fills the region, took ${fillMs.toFixed(2)} ms.`,
    "",
  ].join("\n"),
);
if (gcs !== 0 || allocated !== 0) {
  process.stderr.write(`served region fits allocated: ${gcs} collections, ${allocated} bytes\n`);
  process.exitCode = 1;
}

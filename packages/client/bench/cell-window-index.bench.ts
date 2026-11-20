import { CHUNK_STUDS, PLATE_LDU } from "@brr/math";
import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { getHeapSpaceStatistics } from "node:v8";
import { CellWindowIndex } from "../src/edit/cell-window-index.ts";

const BORDER_CELLS = 1;
const WINDOW_CELLS = CHUNK_STUDS + 2 * BORDER_CELLS;
const LAYERS = 15;
const BRICK_PLATES = 3;
const LAYER_LDU = BRICK_PLATES * PLATE_LDU;
const FOOTPRINT_KIND = 1;
const WARMUP_CYCLES = 200;
const TIMED_CYCLES = 200;
const SETTLE_MS = 50;
const YOUNG_GENERATION_SPACES: ReadonlyArray<string> = ["new_space", "new_large_object_space"];
const NEIGHBOUR_DX = Int8Array.of(-1, 0, 1, -1, 1, -1, 0, 1);
const NEIGHBOUR_DZ = Int8Array.of(-1, -1, -1, 0, 0, 1, 1, 1);

interface Probe {
  readonly startMs: number;
  readonly endMs: number;
  readonly youngBytes: number;
  readonly culled: number;
}

function youngGenerationBytes(): number {
  let bytes = 0;
  for (const space of getHeapSpaceStatistics()) {
    if (YOUNG_GENERATION_SPACES.includes(space.space_name)) bytes += space.space_used_size;
  }
  return bytes;
}

function owner(layer: number, cellX: number, cellZ: number): number {
  return layer * WINDOW_CELLS * WINDOW_CELLS + cellZ * WINDOW_CELLS + cellX;
}

function pushAll(footprints: CellWindowIndex, columns: CellWindowIndex): void {
  for (let layer = 0; layer < LAYERS; layer++) {
    for (let z = -BORDER_CELLS; z < CHUNK_STUDS + BORDER_CELLS; z++) {
      for (let x = -BORDER_CELLS; x < CHUNK_STUDS + BORDER_CELLS; x++) {
        const id = owner(layer, x + BORDER_CELLS, z + BORDER_CELLS);
        columns.push(x, z, id, layer * LAYER_LDU, (layer + 1) * LAYER_LDU);
        if (layer > 0) footprints.push(x, z, id, layer * LAYER_LDU, FOOTPRINT_KIND);
      }
    }
  }
}

function fill(footprints: CellWindowIndex, columns: CellWindowIndex): void {
  footprints.reset(-BORDER_CELLS, -BORDER_CELLS, WINDOW_CELLS, WINDOW_CELLS);
  columns.reset(-BORDER_CELLS, -BORDER_CELLS, WINDOW_CELLS, WINDOW_CELLS);
  pushAll(footprints, columns);
  footprints.startFilling();
  columns.startFilling();
  pushAll(footprints, columns);
  footprints.seal();
  columns.seal();
}

function cullAll(footprints: CellWindowIndex, columns: CellWindowIndex): number {
  let culled = 0;
  for (let layer = 0; layer < LAYERS; layer++) {
    const base = layer * LAYER_LDU;
    for (let z = 0; z < CHUNK_STUDS; z++) {
      for (let x = 0; x < CHUNK_STUDS; x++) {
        const end = footprints.end(x, z);
        for (let r = footprints.firstAtOrAbove(x, z, base); r < end; r++) {
          if (footprints.low(r) !== base) break;
          const cover = footprints.owner(r);
          let closed = true;
          for (let n = 0; n < NEIGHBOUR_DX.length && closed; n++) {
            closed = columns.spannedByAnotherOwner(
              x + (NEIGHBOUR_DX[n] ?? 0),
              z + (NEIGHBOUR_DZ[n] ?? 0),
              base,
              cover,
            );
          }
          if (closed) {
            culled++;
            break;
          }
        }
      }
    }
  }
  return culled;
}

function probeCycles(
  footprints: CellWindowIndex,
  columns: CellWindowIndex,
  cycles: number,
  work: boolean,
): Probe {
  let culled = 0;
  const youngBefore = youngGenerationBytes();
  const startMs = performance.now();
  for (let c = 0; c < cycles; c++) {
    if (!work) continue;
    fill(footprints, columns);
    culled = cullAll(footprints, columns);
  }
  const endMs = performance.now();
  return { startMs, endMs, youngBytes: youngGenerationBytes() - youngBefore, culled };
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

const collect: unknown = Reflect.get(globalThis, "gc");
if (typeof collect !== "function") throw new Error("run the culling bench with --expose-gc");
const footprints = new CellWindowIndex(false);
const columns = new CellWindowIndex(true);
probeCycles(footprints, columns, WARMUP_CYCLES, true);
probeCycles(footprints, columns, WARMUP_CYCLES, false);
const collections: number[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) collections.push(entry.startTime);
});
observer.observe({ entryTypes: ["gc"] });
await settle();
collect();
const probe = probeCycles(footprints, columns, TIMED_CYCLES, false);
const timed = probeCycles(footprints, columns, TIMED_CYCLES, true);
await settle();
observer.disconnect();
const gcs = collections.filter((at) => at >= timed.startMs && at <= timed.endMs).length;
const allocated = timed.youngBytes - probe.youngBytes;
const perCycleUs = ((timed.endMs - timed.startMs) / TIMED_CYCLES) * 1000;
const records = 2 * LAYERS * WINDOW_CELLS * WINDOW_CELLS;
process.stdout.write(
  [
    `cpu: ${cpus()[0]?.model ?? "unknown"} x${cpus().length}, node ${process.version}`,
    `method: one chunk's culling window (${WINDOW_CELLS}×${WINDOW_CELLS} cells, ${LAYERS} layers of columns and anti-stud footprints, about ${records.toLocaleString("en-US")} records) is reset, counted, filled, sealed and every stud cell's footprints and 8 neighbours looked up, ${WARMUP_CYCLES} warm-up cycles, then ${TIMED_CYCLES} timed cycles against the same ${TIMED_CYCLES} cycles with the work skipped; young-generation bytes and GCs counted over the timed cycles`,
    "",
    "| Cycles | µs per cycle | Studs culled per cycle | GCs during run | Bytes allocated during run |",
    "|---:|---:|---:|---:|---:|",
    `| ${TIMED_CYCLES} | ${perCycleUs.toFixed(1)} | ${timed.culled.toLocaleString("en-US")} | ${gcs} | ${allocated} |`,
    "",
  ].join("\n"),
);
if (gcs !== 0 || allocated !== 0) {
  process.stderr.write(`the culling window allocated: ${gcs} collections, ${allocated} bytes\n`);
  process.exitCode = 1;
}

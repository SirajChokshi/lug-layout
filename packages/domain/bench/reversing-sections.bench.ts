import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import { PerformanceObserver, performance } from "node:perf_hooks";
import { POSE16_IDENTITY, composePose16, pose16, zeta16, type Pose16 } from "@brr/math";
import { drawingKit } from "../src/track/drawing-kit.ts";
import { solveClosure } from "../src/track/closure.ts";
import { ReversingSectionFinder } from "../src/track/reversing-sections.ts";
import { TrackGraph } from "../src/track/track-graph.ts";
import { TrackLayout, type TrackPieceSpec } from "../src/track/track-layout.ts";
import { layMoves, type TrackPieceDef } from "../src/track/track-pose.ts";
import { runMoves } from "../src/track/track-solver.ts";

interface CatalogPiece {
  readonly id: string;
  readonly status: string;
  readonly system: string;
  readonly connectors: ReadonlyArray<{
    readonly coefficients: ReadonlyArray<string>;
    readonly heading: number;
  }>;
  readonly routes: ReadonlyArray<{ readonly from: number; readonly to: number }>;
}

const CATALOG = new URL("../../../docs/verified-facts/track-catalog.json", import.meta.url);
const BALLOONS = 60;
const RUN_STRAIGHTS = 18;
const BALLOON_PITCH_STUDS = 400n;
const FINDS = 2_000;
const WARMUP_FINDS = 200;

const pieces = (
  JSON.parse(readFileSync(CATALOG, "utf8")) as { readonly pieces: ReadonlyArray<CatalogPiece> }
).pieces.filter((piece) => piece.system === "lego-9v" && piece.status === "certified");
const defs: ReadonlyArray<TrackPieceDef> = pieces.map((piece) => ({
  id: piece.id,
  connectors: piece.connectors.map((c) =>
    pose16(zeta16(c.coefficients.map((value) => BigInt(value))), c.heading),
  ),
}));
const specs: ReadonlyArray<TrackPieceSpec> = pieces.map((piece, i) => ({
  connectors: defs[i]?.connectors ?? [],
  routes: piece.routes.map(({ from, to }) => ({ from, to })),
}));
const indexOf = (id: string): number => pieces.findIndex((piece) => piece.id === id);
const kitResult = drawingKit(
  defs.filter((def) => def.id === "ldraw:74746" || def.id === "ldraw:74747"),
);
if (kitResult.kind !== "kit") throw new Error(kitResult.reason);
const kit = kitResult.kit;
const turnoutIndex = indexOf("ldraw:75541-f1");
const switchDef = defs[turnoutIndex];
if (!switchDef) throw new Error("the certified 9V catalog has no right switch");
const [, straightExit, divergingExit] = switchDef.connectors;
if (!straightExit || !divergingExit) throw new Error("the switch has no exits");
const closure = solveClosure(kit, straightExit, divergingExit);
if (closure.kind !== "exact") throw new Error(`no balloon closure: ${closure.kind}`);
const loop = layMoves(straightExit, runMoves(kit, closure.run)).placed;
const stem = layMoves(
  composePose16(POSE16_IDENTITY, pose16(zeta16([0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n]), 8)),
  runMoves(kit, { segments: [{ kind: "straight", count: RUN_STRAIGHTS }], pieces: RUN_STRAIGHTS }),
).placed;

function shifted(placement: Pose16, studs: bigint): Pose16 {
  return composePose16(pose16(zeta16([0n, 0n, 0n, 0n, studs, 0n, 0n, 0n]), 0), placement);
}

const layout = new TrackLayout(specs);
for (let b = 0; b < BALLOONS; b++) {
  const offset = BigInt(b) * BALLOON_PITCH_STUDS;
  layout.place(turnoutIndex, shifted(POSE16_IDENTITY, offset), 0);
  for (const piece of [...loop, ...stem]) {
    layout.place(indexOf(piece.piece.id), shifted(piece.placement, offset), 0);
  }
}
const graph = new TrackGraph(layout);
const finder = new ReversingSectionFinder();
const found = finder.find(graph);
if (found.count !== BALLOONS) throw new Error(`${BALLOONS} balloons gave ${found.count} sections`);

function find(count: number): number {
  let sections = 0;
  for (let k = 0; k < count; k++) sections += finder.find(graph).count;
  return sections;
}

let collections = 0;
const observer = new PerformanceObserver((list) => {
  collections += list.getEntries().length;
});
observer.observe({ entryTypes: ["gc"] });
const collectGarbage = (globalThis as { gc?: () => void }).gc;

find(WARMUP_FINDS);
collectGarbage?.();
await new Promise((resolve) => setTimeout(resolve, 50));
const gcBefore = collections;
const heapBefore = process.memoryUsage().heapUsed;
const start = performance.now();
find(FINDS);
const ms = performance.now() - start;
const heapGrowth = process.memoryUsage().heapUsed - heapBefore;
await new Promise((resolve) => setTimeout(resolve, 50));
const gcs = collections - gcBefore;
observer.disconnect();

process.stdout.write(
  [
    `node ${process.version}, ${cpus()[0]?.model ?? "unknown CPU"} (${cpus().length} threads)`,
    `${BALLOONS} balloon loops of real 9V pieces closed by the exact closure solver, each on a stem of ${RUN_STRAIGHTS} straights: ${layout.count} pieces, ${graph.endCount} ends, ${graph.switchCount} switch ends, ${graph.joinCount} joins; each find lists every reversing section of the whole graph`,
    "",
    "| Finds | Sections each | ms | µs each | GCs | Heap growth (bytes) | bytes each |",
    "|---|---|---|---|---|---|---|",
    `| ${FINDS.toLocaleString("en-US")} | ${found.count} | ${ms.toFixed(1)} | ${((ms * 1e3) / FINDS).toFixed(1)} | ${gcs} | ${heapGrowth} | ${Math.round(heapGrowth / FINDS)} |`,
    "",
  ].join("\n"),
);

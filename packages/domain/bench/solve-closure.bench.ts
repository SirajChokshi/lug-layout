import { performance } from "node:perf_hooks";
import {
  GCProfiler,
  getHeapSpaceStatistics,
  type GCProfilerResult,
  type HeapSpaceStatistics,
} from "node:v8";
import { conjugateZeta16, pose16, zeta16, ZETA16_ZERO, type Pose16 } from "@brr/math";
import measured from "../../../docs/verified-facts/geometry.json" with { type: "json" };
import { drawingKit, type DrawingKit } from "../src/track/drawing-kit.ts";
import type { TrackPieceDef } from "../src/track/track-pose.ts";
import { solveClosure } from "../src/track/closure.ts";

const NINE_VOLT_STRAIGHT_AND_CURVE: ReadonlyArray<string> = ["74746", "74747"];

const WARMUP_CALLS = 200;
const MEASURED_CALLS = 200;

interface GeometryEnd {
  readonly fieldCertified: boolean;
  readonly coefficients: ReadonlyArray<string> | null;
  readonly headingSteps: number;
}

interface GeometryTrack {
  readonly part: string;
  readonly relative: ReadonlyArray<GeometryEnd>;
}

function yUpPiece(track: GeometryTrack): TrackPieceDef {
  return {
    id: `ldraw:${track.part}`,
    connectors: track.relative.map((end) => {
      if (!end.fieldCertified || !end.coefficients) {
        throw new Error(`${track.part} end is not certified`);
      }
      const ldrawFrame = zeta16(end.coefficients.map((c) => BigInt(c)));
      return pose16(conjugateZeta16(ldrawFrame), -end.headingSteps);
    }),
  };
}

function nineVoltKit(): DrawingKit {
  const tracks: ReadonlyArray<GeometryTrack> = measured.trackEnds;
  const pieces = tracks
    .filter((track) => NINE_VOLT_STRAIGHT_AND_CURVE.includes(track.part))
    .map(yUpPiece);
  const result = drawingKit(pieces);
  if (result.kind !== "kit") throw new Error(result.reason);
  return result.kit;
}

function usedAcrossSpaces(spaces: ReadonlyArray<HeapSpaceStatistics>): number {
  let bytes = 0;
  for (const space of spaces) bytes += space.spaceUsedSize;
  return bytes;
}

function usedNow(): number {
  let bytes = 0;
  for (const space of getHeapSpaceStatistics()) bytes += space.space_used_size;
  return bytes;
}

function allocatedAcross(
  from: number,
  to: number,
  collections: GCProfilerResult["statistics"],
): number {
  let bytes = 0;
  let segmentStart = from;
  for (const collection of collections) {
    bytes += usedAcrossSpaces(collection.beforeGC.heapSpaceStatistics) - segmentStart;
    segmentStart = usedAcrossSpaces(collection.afterGC.heapSpaceStatistics);
  }
  return bytes + to - segmentStart;
}

const collect = globalThis.gc;
if (!collect) throw new Error("run with --expose-gc");
const gc: () => void = collect;
const kit = nineVoltKit();
const benchStart = pose16(zeta16([-80n, 0n, 0n, 0n, 256n, 0n, 0n, 0n]), 0);
const cases: ReadonlyArray<readonly [string, Pose16, Pose16]> = [
  [
    "one stud off the drag-join goal (impossible)",
    benchStart,
    pose16(zeta16([17n, 0n, 0n, 0n, 320n, 0n, 0n, 0n]), 8),
  ],
  [
    "the bench drag-join's whole closure",
    benchStart,
    pose16(zeta16([16n, 0n, 0n, 0n, 320n, 0n, 0n, 0n]), 8),
  ],
  [
    "a five-turn gap only the complete search closes",
    pose16(ZETA16_ZERO, 0),
    pose16(zeta16([112n, 16n, 0n, 0n, 72n, 0n, 0n, -56n]), 3),
  ],
];

function measure(label: string, start: Pose16, goal: Pose16): string {
  for (let i = 0; i < WARMUP_CALLS; i++) solveClosure(kit, start, goal);
  const kind = solveClosure(kit, start, goal).kind;
  gc();
  const profiler = new GCProfiler();
  profiler.start();
  const before = usedNow();
  const began = performance.now();
  for (let i = 0; i < MEASURED_CALLS; i++) solveClosure(kit, start, goal);
  const elapsed = performance.now() - began;
  const after = usedNow();
  const { statistics } = profiler.stop();
  const bytes = allocatedAcross(before, after, statistics) / MEASURED_CALLS;
  const micros = (elapsed * 1000) / MEASURED_CALLS;
  return `| ${label} | ${kind} | ${Math.round(bytes)} | ${micros.toFixed(1)} | ${statistics.length} |`;
}

const rows = cases.map(([label, start, goal]) => measure(label, start, goal));
process.stdout.write(
  [
    `method: solveClosure on the 9V kit (74746, 74747 from docs/verified-facts/geometry.json) with no site and an unlimited budget, so the solve is closuresWithinTurns plus completeClosure. ${WARMUP_CALLS.toLocaleString("en-US")} warm-up calls per row, then ${MEASURED_CALLS.toLocaleString("en-US")} measured calls; heap bytes are counted across every heap space and summed across any collection inside the window (GCProfiler).`,
    "",
    "| goal | result | bytes per call | µs per call | collections |",
    "|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"),
);

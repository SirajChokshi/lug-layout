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
import { closuresWithinTurns } from "../src/track/track-solver.ts";

const NINE_VOLT_STRAIGHT_AND_CURVE: ReadonlyArray<string> = ["74746", "74747"];
const YOUNG_GENERATION_SPACES: ReadonlyArray<string> = ["new_space", "new_large_object_space"];
const WARMUP_CALLS = 20_000;
const MEASURED_CALLS = 5_000;
const RECORDED_START_HEADING = 3;
const RECORDED_GOAL_HEADING = 8;
const RECORDED_CAP = 23;
const NO_CLOSURE_CAPS: ReadonlyArray<number> = [7, 17, 30, Number.POSITIVE_INFINITY];

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

function youngBytes(): number {
  let bytes = 0;
  for (const space of getHeapSpaceStatistics()) {
    if (YOUNG_GENERATION_SPACES.includes(space.space_name)) bytes += space.space_used_size;
  }
  return bytes;
}

function youngUsed(spaces: ReadonlyArray<HeapSpaceStatistics>): number {
  let bytes = 0;
  for (const space of spaces) {
    if (YOUNG_GENERATION_SPACES.includes(space.spaceName)) bytes += space.spaceUsedSize;
  }
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
    bytes += youngUsed(collection.beforeGC.heapSpaceStatistics) - segmentStart;
    segmentStart = youngUsed(collection.afterGC.heapSpaceStatistics);
  }
  return bytes + to - segmentStart;
}

const collect = globalThis.gc;
if (!collect) throw new Error("run with --expose-gc");
const gc: () => void = collect;
const kit = nineVoltKit();
const recordedStart = pose16(ZETA16_ZERO, RECORDED_START_HEADING);
const recordedGoal = pose16(zeta16([96n, 0n, 0n, 0n, 24n, 0n, 0n, 40n]), RECORDED_GOAL_HEADING);
const unreachable = pose16(zeta16([97n, 0n, 0n, 0n, 24n, 0n, 0n, 40n]), RECORDED_GOAL_HEADING);
let sink = 0;

function measure(label: string, start: Pose16, goal: Pose16, cap: number): string {
  const call = (): void => {
    sink += closuresWithinTurns(kit, start, goal, cap).length;
  };
  for (let i = 0; i < WARMUP_CALLS; i++) call();
  const runs = closuresWithinTurns(kit, start, goal, cap).length;
  gc();
  const profiler = new GCProfiler();
  profiler.start();
  const before = youngBytes();
  const began = performance.now();
  for (let i = 0; i < MEASURED_CALLS; i++) call();
  const elapsed = performance.now() - began;
  const after = youngBytes();
  const { statistics } = profiler.stop();
  const bytes = allocatedAcross(before, after, statistics) / MEASURED_CALLS;
  const micros = (elapsed * 1000) / MEASURED_CALLS;
  return `| ${label} | ${cap === Number.POSITIVE_INFINITY ? "none" : cap} | ${runs} | ${Math.round(bytes)} | ${micros.toFixed(2)} | ${statistics.length} |`;
}

const rows = [
  ...NO_CLOSURE_CAPS.map((cap) =>
    measure("no closure (one stud off)", recordedStart, unreachable, cap),
  ),
  measure("recorded drag-join backoff point", recordedStart, recordedGoal, RECORDED_CAP),
];
process.stdout.write(
  [
    `method: closuresWithinTurns on the 9V kit (74746, 74747 from docs/verified-facts/geometry.json), start heading ${RECORDED_START_HEADING} at the origin, goal heading ${RECORDED_GOAL_HEADING}. The recorded point is a drag-join backoff point whose difference closes in 15 runs at cap ${RECORDED_CAP}; one stud off it nothing closes at any cap. ${WARMUP_CALLS.toLocaleString("en-US")} warm-up calls per row, then ${MEASURED_CALLS.toLocaleString("en-US")} measured calls; young-generation bytes are summed across any collection inside the window (GCProfiler).`,
    "",
    "| goal | cap | runs | bytes per call | µs per call | collections |",
    "|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n"),
);
if (sink < 0) throw new Error("unreachable");

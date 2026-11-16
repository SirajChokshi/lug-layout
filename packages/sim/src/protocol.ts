import type { TrackGraphTopology } from "./graph-track.ts";
import type { SimPathSegment } from "./route-geometry.ts";
import type { SimCommand, SimFrameLayout, SimTrainLoad } from "./sim-session.ts";
import type { SimCapacity } from "./simulation.ts";

export interface SimLoad {
  readonly graph: TrackGraphTopology;
  readonly routeSegments: ReadonlyArray<ReadonlyArray<SimPathSegment>>;
  readonly capacity: SimCapacity;
  readonly trains: ReadonlyArray<SimTrainLoad>;
}

export interface SimLoaded {
  readonly layout: SimFrameLayout;
  readonly tickHz: number;
  readonly maxEndResidualLdu: number;
  readonly maxEndHeadingResidualRadians: number;
}

export interface SimFrameMessage {
  readonly tick: number;
  readonly stateHash: number;
  readonly batchTicks: number;
  readonly batchStepMs: number;
  readonly data: Float64Array;
}

export interface SimBenchResult {
  readonly replayedToTick: number;
  readonly replayHash: number;
  readonly liveHash: number;
  readonly ticks: number;
  readonly elapsedMs: number;
}

export type SimRequest =
  | { readonly kind: "load"; readonly load: SimLoad }
  | { readonly kind: "run"; readonly running: boolean }
  | { readonly kind: "command"; readonly command: SimCommand }
  | { readonly kind: "recycle"; readonly buffer: Float64Array }
  | { readonly kind: "bench"; readonly ticks: number };

export type SimReply =
  | { readonly kind: "loaded"; readonly loaded: SimLoaded }
  | { readonly kind: "frame"; readonly frame: SimFrameMessage }
  | { readonly kind: "commanded"; readonly accepted: boolean; readonly tick: number }
  | { readonly kind: "bench"; readonly result: SimBenchResult }
  | { readonly kind: "failed"; readonly message: string };

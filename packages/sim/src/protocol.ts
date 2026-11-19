import type { TrackGraphTopology } from "./graph-track.ts";
import type { SimPathSegment } from "./route-geometry.ts";
import type { SimCommand, SimFrameLayout, SimTrainLoad } from "./sim-session.ts";
import type { OpenEndRule, SimCapacity } from "./simulation.ts";

export interface SimLoad {
  readonly graph: TrackGraphTopology;
  readonly routeSegments: ReadonlyArray<ReadonlyArray<SimPathSegment>>;
  readonly capacity: SimCapacity;
  readonly trains: ReadonlyArray<SimTrainLoad>;
  readonly autopilotSeed: number | null;
  readonly openEnds: OpenEndRule;
}

export interface SimLoaded {
  readonly layout: SimFrameLayout;
  readonly tickHz: number;
  readonly maxEndResidualLdu: number;
  readonly frontRailTops: Float64Array;
  readonly rearRailTops: Float64Array;
  readonly maxEndHeadingResidualRadians: number;
}

export interface SimFrameMessage {
  readonly tick: number;
  readonly stateHash: number;
  readonly data: Float64Array;
}

export type SimRequest =
  | { readonly kind: "load"; readonly load: SimLoad }
  | { readonly kind: "run"; readonly running: boolean }
  | { readonly kind: "command"; readonly command: SimCommand }
  | { readonly kind: "recycle"; readonly buffer: Float64Array };

export type SimReply =
  | { readonly kind: "loaded"; readonly loaded: SimLoaded }
  | { readonly kind: "frame"; readonly frame: SimFrameMessage }
  | { readonly kind: "commanded"; readonly accepted: boolean; readonly tick: number }
  | { readonly kind: "failed"; readonly message: string };

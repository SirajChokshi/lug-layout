import { type Vec3 } from "../assembly.ts";
import type { HeadBandSpan } from "./placement.ts";
export interface RollingSurfaceContact {
  readonly instance: number;
  readonly headBand: HeadBandSpan;
}

export interface PlannedWheelset {
  readonly x: number;
  readonly y: number;
  readonly unit: string;
  readonly instances: ReadonlyArray<number>;
  readonly rail: string | null;
  readonly rollingSurfaces: ReadonlyArray<RollingSurfaceContact>;
  readonly negative: "gauge miss" | "one head band" | "split across pivot" | null;
}

export interface PlannedEnd {
  readonly candidates: ReadonlyArray<{ readonly instance: number; readonly tip: Vec3 }>;
  readonly nonCandidates: ReadonlyArray<{
    readonly instance: number;
    readonly at: Vec3;
    readonly reason: "inward" | "off-axis" | "buffer";
  }>;
}

export type EndPlan = PlannedEnd | "plain" | "unasserted";

export interface VehiclePlan {
  readonly body: ReadonlyArray<string>;
  readonly bogies: ReadonlyArray<{
    readonly unit: string;
    readonly pivot: readonly [number, number];
  }>;
  readonly front: EndPlan;
  readonly rear: EndPlan;
}

export interface CouplingPlan {
  readonly vehicles: readonly [number, number];
  readonly via: ReadonlyArray<string>;
  readonly pivots: ReadonlyArray<readonly [number, number]>;
}

export interface TrainPlan {
  readonly wheelsets: ReadonlyArray<PlannedWheelset>;
  readonly vehicles: ReadonlyArray<VehiclePlan>;
  readonly attachments: ReadonlyArray<string>;
  readonly couplingsInModel: ReadonlyArray<CouplingPlan>;
  readonly unresolvedRunningGear: ReadonlyArray<{
    readonly units: ReadonlyArray<string>;
    readonly reason: string;
  }>;
}

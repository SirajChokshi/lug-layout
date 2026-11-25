import { PLATE_LDU, STUD_LDU, zeta16ToStuds, type Pose16 } from "@brr/math";
import { LEVEL_TRACK, type TrackLift } from "../rail/sim-track.ts";
import type { TrackLayout } from "./track-layout.ts";

export interface RampShear {
  readonly gx: number;
  readonly gz: number;
  readonly lowX: number;
  readonly lowZ: number;
}

const LOW_END = 0;
const HIGH_END = 1;

export function rampShear(low: Pose16, high: Pose16, risePlates: number): RampShear {
  const from = zeta16ToStuds(low.position);
  const to = zeta16ToStuds(high.position);
  const dx = (to.x - from.x) * STUD_LDU;
  const dz = (to.z - from.z) * STUD_LDU;
  const scale = (risePlates * PLATE_LDU) / (dx * dx + dz * dz);
  return { gx: dx * scale, gz: dz * scale, lowX: from.x * STUD_LDU, lowZ: from.z * STUD_LDU };
}

export function placementLift(layout: TrackLayout, placement: number): TrackLift {
  const baseLdu = layout.yPlates(placement) * PLATE_LDU;
  const rise = layout.rise(placement);
  if (rise === 0) return { ...LEVEL_TRACK, baseLdu };
  return {
    baseLdu,
    ...rampShear(
      layout.connectorPose(placement, LOW_END),
      layout.connectorPose(placement, HIGH_END),
      rise,
    ),
  };
}

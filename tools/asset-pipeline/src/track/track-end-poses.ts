import type { LdrawLibrary } from "../ldraw/library.ts";
import { ZETA16_ORDER } from "./cyclotomic.ts";
import { findTrackEnds, relativeToEntry, type TrackEndMarker } from "./track-ends.ts";

const PART_FRAME_GRID_DEGREES = 360 / (2 * ZETA16_ORDER);

export interface TrackEndPose {
  readonly marker: string;
  readonly xLdu: number;
  readonly zLdu: number;
  readonly outwardDegrees: number;
  readonly headingSteps: number;
  readonly certified: boolean;
  readonly coefficients: ReadonlyArray<number> | null;
}

export interface TrackPartPoses {
  readonly id: string;
  readonly entryInwardDegrees: number;
  readonly ends: ReadonlyArray<TrackEndPose>;
}

function snapDegrees(radians: number): number {
  const degrees = (radians * 180) / Math.PI;
  const snapped = Math.round(degrees / PART_FRAME_GRID_DEGREES) * PART_FRAME_GRID_DEGREES;
  return (((snapped % 360) + 360) % 360) + 0;
}

export function trackPartPoses(
  library: LdrawLibrary,
  markers: ReadonlyArray<TrackEndMarker>,
  id: string,
): TrackPartPoses {
  const ends = findTrackEnds(library, id, markers);
  const relative = relativeToEntry(ends);
  const entry = ends[0];
  if (entry === undefined) throw new Error(`${id} has no track ends`);
  return {
    id,
    entryInwardDegrees: snapDegrees(entry.outward + Math.PI),
    ends: ends.map((end, index) => {
      const pose = relative[index];
      if (pose === undefined) throw new Error(`${id} end ${index} has no relative pose`);
      return {
        marker: end.marker,
        xLdu: end.x,
        zLdu: end.z,
        outwardDegrees: snapDegrees(end.outward),
        headingSteps: pose.headingSteps,
        certified: pose.fieldCertified,
        coefficients: pose.coefficients === null ? null : pose.coefficients.map(Number),
      };
    }),
  };
}

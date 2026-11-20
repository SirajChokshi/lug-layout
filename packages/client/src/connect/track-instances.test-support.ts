import type { PartBundle } from "@brr/catalog";
import {
  STUD_LDU,
  ZETA16_STEP_RADIANS,
  attachPose16,
  composePose16,
  zeta16Direction,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";
import type { TrackInstances } from "./model-track-ends.ts";

type TrackBundle = Pick<PartBundle, "parts" | "trackCatalog">;
type CatalogPiece = PartBundle["trackCatalog"]["pieces"][number];

export function catalogPieceOf(bundle: TrackBundle, partId: string): CatalogPiece {
  const piece = bundle.trackCatalog.pieces.find((candidate) => candidate.part === partId);
  if (!piece) throw new Error(`${partId} is not in the track catalog`);
  return piece;
}

export function chainedPoses(
  bundle: TrackBundle,
  start: Pose16,
  partIds: ReadonlyArray<string>,
): Array<readonly [string, Pose16]> {
  const pieces: Array<readonly [string, Pose16]> = [];
  for (const partId of partIds) {
    const previous = pieces.at(-1);
    const entry = catalogPieceOf(bundle, partId).connectors[0]?.pose;
    const exit = previous ? catalogPieceOf(bundle, previous[0]).connectors[1]?.pose : undefined;
    pieces.push([
      partId,
      previous && entry && exit ? attachPose16(entry, composePose16(previous[1], exit)) : start,
    ]);
  }
  return pieces;
}

export function instancesAt(
  bundle: TrackBundle,
  pieces: ReadonlyArray<readonly [string, Pose16]>,
): TrackInstances {
  const partIndex: number[] = [];
  const matrices: number[] = [];
  for (const [partId, placement] of pieces) {
    const part = bundle.parts.findIndex((candidate) => candidate.id === partId);
    const frame = catalogPieceOf(bundle, partId).partFrame;
    const turn = (placement.heading + frame.headingHalfSteps / 2) * ZETA16_STEP_RADIANS;
    const at = zeta16ToStuds(placement.position);
    const facing = zeta16Direction(placement.heading);
    const offsetX = frame.xLdu / STUD_LDU;
    const offsetZ = frame.zLdu / STUD_LDU;
    partIndex.push(part);
    matrices.push(
      Math.cos(turn),
      0,
      -Math.sin(turn),
      STUD_LDU * (at.x + facing.x * offsetX - facing.z * offsetZ),
      0,
      1,
      0,
      -(bundle.parts[part]?.boundsMin[1] ?? 0),
      Math.sin(turn),
      0,
      Math.cos(turn),
      STUD_LDU * (at.z + facing.z * offsetX + facing.x * offsetZ),
    );
  }
  return { count: pieces.length, partIndex, matrices: Float64Array.from(matrices) };
}

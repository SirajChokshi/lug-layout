import { composePose16, STUD_LDU, zeta16ToStuds, type Pose16 } from "@brr/math";
import type { TrackFrame } from "./end-gaps.ts";
import type { TrackPieceSpec } from "./track-layout.ts";

const RAMP_HIGH_END = 1;

const MADE_BY_PIECE_ENDS: unique symbol = Symbol("pieceEnds");

export interface PiecePlacement {
  readonly piece: number;
  readonly pose: Pose16;
  readonly yPlates: number;
  readonly rise: number;
  readonly frame: TrackFrame;
}

interface PieceEnd {
  readonly pose: Pose16;
  readonly yPlates: number;
  readonly xLdu: number;
  readonly zLdu: number;
  readonly key: string;
}

export interface PieceEnds {
  readonly [MADE_BY_PIECE_ENDS]: true;
  readonly spec: TrackPieceSpec;
  readonly placement: PiecePlacement;
  readonly ends: ReadonlyArray<PieceEnd>;
}

export function endYPlatesOf(yPlates: number, rise: number, connector: number): number {
  return connector === RAMP_HIGH_END ? yPlates + rise : yPlates;
}

function endKey(pose: Pose16, yPlates: number, frame: number): string {
  return `${frame}:${yPlates}:${pose.position.join(",")}`;
}

export function pieceEnds(spec: TrackPieceSpec, placement: PiecePlacement): PieceEnds {
  const { pose: piecePose, yPlates: pieceYPlates, rise, frame } = placement;
  const ends = spec.connectors.map((local, connector): PieceEnd => {
    const yPlates = endYPlatesOf(pieceYPlates, rise, connector);
    const pose = composePose16(piecePose, local);
    const studs = zeta16ToStuds(pose.position);
    return {
      pose,
      yPlates,
      xLdu: studs.x * STUD_LDU + frame.xLdu,
      zLdu: studs.z * STUD_LDU + frame.zLdu,
      key: endKey(pose, yPlates, frame.id),
    };
  });
  return { [MADE_BY_PIECE_ENDS]: true, spec, placement, ends };
}

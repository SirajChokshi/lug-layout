import { POSE16_IDENTITY, posesJoin16, type Pose16 } from "@brr/math";
import { connectorPose, type PlacedPiece, type TrackPieceDef } from "./track-pose.ts";

export interface ArrangedPiece {
  readonly piece: number;
  readonly placement: Pose16;
}

export interface TrackArrangement {
  readonly pieces: ReadonlyArray<ArrangedPiece>;
  readonly ends: ReadonlyArray<Pose16>;
}

export function pieceArrangement(
  piece: number,
  connectors: ReadonlyArray<Pose16>,
): TrackArrangement {
  return { pieces: [{ piece, placement: POSE16_IDENTITY }], ends: connectors };
}

export function arranged(
  placed: ReadonlyArray<PlacedPiece>,
  indexOf: (piece: TrackPieceDef) => number,
): TrackArrangement {
  const ends = placed.flatMap((piece) =>
    piece.piece.connectors.map((_, connector) => connectorPose(piece, connector)),
  );
  return {
    pieces: placed.map(({ piece, placement }) => ({ piece: indexOf(piece), placement })),
    ends: ends.filter((end) => !ends.some((other) => posesJoin16(end, other))),
  };
}

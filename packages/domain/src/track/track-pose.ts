import {
  HALF_TURN_16,
  attachPose16,
  composePose16,
  normalizeHeading16,
  pose16,
  rotateZeta16,
  subtractZeta16,
  type Pose16,
  type Zeta16,
} from "@brr/math";

export interface TrackPieceDef {
  readonly id: string;
  readonly connectors: ReadonlyArray<Pose16>;
}

export interface TrackMove {
  readonly piece: TrackPieceDef;
  readonly from: number;
  readonly to: number;
  readonly delta: Zeta16;
  readonly turn: number;
}

export interface PlacedPiece {
  readonly piece: TrackPieceDef;
  readonly placement: Pose16;
}

function connector(piece: TrackPieceDef, index: number): Pose16 {
  const c = piece.connectors[index];
  if (!c) throw new RangeError(`${piece.id} has no connector ${index}`);
  return c;
}

export function trackMove(piece: TrackPieceDef, from: number, to: number): TrackMove {
  const entry = connector(piece, from);
  const exit = connector(piece, to);
  const frame = HALF_TURN_16 - entry.heading;
  return {
    piece,
    from,
    to,
    delta: rotateZeta16(subtractZeta16(exit.position, entry.position), frame),
    turn: normalizeHeading16(frame + exit.heading),
  };
}

export function connectorPose(placed: PlacedPiece, index: number): Pose16 {
  return composePose16(placed.placement, connector(placed.piece, index));
}

export function advance(end: Pose16, move: TrackMove): Pose16 {
  return composePose16(end, pose16(move.delta, move.turn));
}

export function layMoves(
  start: Pose16,
  moves: ReadonlyArray<TrackMove>,
): { readonly placed: ReadonlyArray<PlacedPiece>; readonly end: Pose16 } {
  const placed: PlacedPiece[] = [];
  let end = start;
  for (const move of moves) {
    const piece: PlacedPiece = {
      piece: move.piece,
      placement: attachPose16(connector(move.piece, move.from), end),
    };
    placed.push(piece);
    end = connectorPose(piece, move.to);
  }
  return { placed, end };
}

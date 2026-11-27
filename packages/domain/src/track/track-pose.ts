import {
  HALF_TURN_16,
  ZETA16_ORDER,
  attachPose16,
  composePose16,
  isLatticePose16,
  nearestQuarterTurn16,
  normalizeHeading16,
  pose16,
  rotateZeta16,
  subtractZeta16,
  zeta16,
  zeta16ToStuds,
  type Pose16,
  type Zeta16,
} from "@brr/math";

const LATTICE_ENDS_OF_A_SEATED_BODY = 2;

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

function turnSteps(heading: number): number {
  const steps = normalizeHeading16(heading);
  return Math.min(steps, ZETA16_ORDER - steps);
}

export function continuingExit(piece: TrackPieceDef, entry: number): number | null {
  const ahead = connector(piece, entry).heading + HALF_TURN_16;
  let exit: number | null = null;
  let fewest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < piece.connectors.length; index++) {
    const end = piece.connectors[index];
    if (index === entry || !end) continue;
    const steps = turnSteps(end.heading - ahead);
    if (steps >= fewest) continue;
    exit = index;
    fewest = steps;
  }
  return exit;
}

export function continuingMove(piece: TrackPieceDef, entry: number): TrackMove | null {
  const exit = continuingExit(piece, entry);
  return exit === null ? null : trackMove(piece, entry, exit);
}

export function seatsOnStuds(piece: TrackPieceDef): boolean {
  return piece.connectors.filter(isLatticePose16).length >= LATTICE_ENDS_OF_A_SEATED_BODY;
}

function nearestLatticePosition(value: Zeta16): Zeta16 {
  const studs = zeta16ToStuds(value);
  const x = BigInt(Math.round(studs.x));
  const z = BigInt(Math.round(studs.z));
  return zeta16([x, 0n, 0n, 0n, z, 0n, 0n, 0n]);
}

export function freePlacement(piece: TrackPieceDef, held: number, free: Pose16): Pose16 {
  const end = connector(piece, held);
  const attached = attachPose16(end, free);
  if (!seatsOnStuds(piece) || isLatticePose16(attached)) return attached;
  const heading = nearestQuarterTurn16(attached.heading);
  const ideal = subtractZeta16(free.position, rotateZeta16(end.position, heading));
  return pose16(nearestLatticePosition(ideal), heading);
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

import type { PartAsset } from "@brr/catalog";
import type { TrackCatalog } from "@brr/schema/bundle";
import {
  STUD_LDU,
  UNROUNDED_TOLERANCE_LDU,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  certifiedZeta16,
  composePose16,
  HALF_TURN_16,
  normalizeHeading16,
  pose16,
  posesJoin16,
  rotateZeta16,
  subtractZeta16,
  zeta16,
  type Pose16,
} from "@brr/math";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import type { ChunkPartInstances } from "../scene/placements.ts";

const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_RADIANS / 2;
const QUARTER_TURN_STEPS = ZETA16_ORDER / 4;

export interface HeldPiece {
  readonly catalogIndex: number;
  readonly pieceId: string;
  readonly local: Pose16;
}

export interface ModelTrack {
  readonly pieces: ReadonlyArray<HeldPiece>;
  readonly openEnds: ReadonlyArray<Pose16>;
  readonly uncertified: ReadonlyArray<string>;
}

interface PieceOfPart {
  readonly connectors: ReadonlyArray<Pose16>;
  readonly catalogIndex: number;
  readonly pieceId: string;
  readonly xLdu: number;
  readonly zLdu: number;
  readonly headingHalfSteps: number;
}

function piecesByPart(catalog: TrackCatalog): Map<string, PieceOfPart | null> {
  const byPart = new Map<string, PieceOfPart | null>();
  catalog.pieces.forEach((piece, catalogIndex) => {
    const entry: PieceOfPart = {
      connectors: piece.connectors.map((connector) => connector.pose),
      catalogIndex,
      pieceId: piece.id,
      xLdu: piece.partFrame.xLdu,
      zLdu: piece.partFrame.zLdu,
      headingHalfSteps: piece.partFrame.headingHalfSteps,
    };
    byPart.set(piece.part, byPart.has(piece.part) ? null : entry);
  });
  return byPart;
}

const QUARTER_TURN_ENTRIES: ReadonlyArray<number> = [-1, 0, 1];

function exactQuarterTurnOnWholeLdu(m: Float32Array, o: number): boolean {
  return (
    m[o + 1] === 0 &&
    m[o + 4] === 0 &&
    m[o + 5] === 1 &&
    m[o + 6] === 0 &&
    m[o + 9] === 0 &&
    m[o] === m[o + 10] &&
    m[o + 2] === -(m[o + 8] ?? 0) &&
    QUARTER_TURN_ENTRIES.includes(m[o] ?? 0) &&
    QUARTER_TURN_ENTRIES.includes(m[o + 8] ?? 0) &&
    Number.isInteger(m[o + 3]) &&
    Number.isInteger(m[o + 11])
  );
}

function piecePose(m: Float32Array, o: number, piece: PieceOfPart): Pose16 | null {
  if (!exactQuarterTurnOnWholeLdu(m, o)) return null;
  const phi = Math.atan2(m[o + 8] ?? 0, m[o] ?? 0);
  const steps = (phi - piece.headingHalfSteps * HALF_STEP_RADIANS) / HEADING_RADIANS;
  const heading = Math.round(steps);
  if (heading !== steps) return null;
  const theta = heading * HEADING_RADIANS;
  const x = (m[o + 3] ?? 0) - (Math.cos(theta) * piece.xLdu - Math.sin(theta) * piece.zLdu);
  const z = (m[o + 11] ?? 0) - (Math.sin(theta) * piece.xLdu + Math.cos(theta) * piece.zLdu);
  const position = certifiedZeta16({ x: x / STUD_LDU, y: z / STUD_LDU }, UNROUNDED_TOLERANCE_LDU);
  return position ? pose16(position, normalizeHeading16(heading)) : null;
}

export function modelTrack(
  local: ChunkPartInstances,
  parts: ReadonlyArray<PartAsset>,
  catalog: TrackCatalog,
): ModelTrack | null {
  const byPart = piecesByPart(catalog);
  const pieces: HeldPiece[] = [];
  const ends: Pose16[] = [];
  const uncertified: string[] = [];
  for (let i = 0; i < local.count; i++) {
    const partId = parts[local.partIndex[i] ?? 0]?.id ?? "";
    if (!byPart.has(partId)) continue;
    const piece = byPart.get(partId);
    const pose = piece ? piecePose(local.matrices, i * INSTANCE_MATRIX_FLOATS, piece) : null;
    if (!piece || !pose) {
      uncertified.push(partId);
      continue;
    }
    pieces.push({ catalogIndex: piece.catalogIndex, pieceId: piece.pieceId, local: pose });
    for (const connector of piece.connectors) ends.push(composePose16(pose, connector));
  }
  if (pieces.length === 0 && uncertified.length === 0) return null;
  const openEnds = ends.filter(
    (end, i) => !ends.some((other, j) => j !== i && posesJoin16(end, other)),
  );
  return { pieces, openEnds, uncertified };
}

export function latticePose16(xLdu: number, zLdu: number, rot: number): Pose16 {
  const position = Array.from({ length: ZETA16_COEFFICIENT_COUNT }, () => 0n);
  position[0] = BigInt(xLdu / STUD_LDU);
  position[ZETA16_COEFFICIENT_COUNT / 2] = BigInt(zLdu / STUD_LDU);
  return pose16(zeta16(position), -QUARTER_TURN_STEPS * rot);
}

export function heldPlacements(
  track: ModelTrack,
  xLdu: number,
  zLdu: number,
  rot: number,
): ReadonlyArray<{ readonly catalogIndex: number; readonly placement: Pose16 }> {
  const frame = latticePose16(xLdu, zLdu, rot);
  return track.pieces.map((piece) => ({
    catalogIndex: piece.catalogIndex,
    placement: composePose16(frame, piece.local),
  }));
}

export interface LatticeSnap {
  readonly xLdu: number;
  readonly zLdu: number;
}

export function latticeSnap(local: Pose16, target: Pose16, rot: number): LatticeSnap | null {
  const heading = -QUARTER_TURN_STEPS * rot;
  if (normalizeHeading16(heading + local.heading - target.heading) !== HALF_TURN_16) return null;
  const offset = subtractZeta16(target.position, rotateZeta16(local.position, heading));
  const zAxis = ZETA16_COEFFICIENT_COUNT / 2;
  for (let k = 0; k < ZETA16_COEFFICIENT_COUNT; k++) {
    if (k !== 0 && k !== zAxis && offset[k] !== 0n) return null;
  }
  return { xLdu: Number(offset[0]) * STUD_LDU, zLdu: Number(offset[zAxis]) * STUD_LDU };
}

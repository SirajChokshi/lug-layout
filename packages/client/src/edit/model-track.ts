import type { PartShapeAsset } from "@brr/catalog";
import type { TrackCatalog } from "@brr/schema/bundle";
import {
  PLATE_LDU,
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
  type Zeta16,
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
  readonly plates: number;
}

export interface HeldEnd {
  readonly local: Pose16;
  readonly plates: number;
}

export interface ModelTrack {
  readonly pieces: ReadonlyArray<HeldPiece>;
  readonly openEnds: ReadonlyArray<HeldEnd>;
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
    if (piece.status !== "certified") return;
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

function exactPosition(xLdu: number, zLdu: number): Zeta16 | null {
  const xStuds = xLdu / STUD_LDU;
  const zStuds = zLdu / STUD_LDU;
  if (Number.isInteger(xStuds) && Number.isInteger(zStuds)) {
    const coefficients = Array.from({ length: ZETA16_COEFFICIENT_COUNT }, () => 0n);
    coefficients[0] = BigInt(xStuds);
    coefficients[ZETA16_COEFFICIENT_COUNT / 2] = BigInt(zStuds);
    return zeta16(coefficients);
  }
  return certifiedZeta16({ x: xStuds, y: zStuds }, UNROUNDED_TOLERANCE_LDU);
}

function piecePlates(m: Float32Array, o: number, part: PartShapeAsset): number | null {
  const plates = ((m[o + 7] ?? 0) + part.boundsMin[1]) / PLATE_LDU;
  return Number.isInteger(plates) ? plates : null;
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
  const position = exactPosition(x, z);
  return position ? pose16(position, normalizeHeading16(heading)) : null;
}

export function modelTrack(
  local: ChunkPartInstances,
  parts: ReadonlyArray<PartShapeAsset>,
  catalog: TrackCatalog,
): ModelTrack | null {
  const byPart = piecesByPart(catalog);
  const pieces: HeldPiece[] = [];
  const ends: HeldEnd[] = [];
  const uncertified: string[] = [];
  for (let i = 0; i < local.count; i++) {
    const part = parts[local.partIndex[i] ?? 0];
    if (!part) continue;
    const partId = part.aliasOf ?? part.id;
    if (!byPart.has(partId)) continue;
    const piece = byPart.get(partId);
    const o = i * INSTANCE_MATRIX_FLOATS;
    const pose = piece ? piecePose(local.matrices, o, piece) : null;
    const plates = piecePlates(local.matrices, o, part);
    if (!piece || !pose || plates === null) {
      uncertified.push(part.id);
      continue;
    }
    pieces.push({ catalogIndex: piece.catalogIndex, pieceId: piece.pieceId, local: pose, plates });
    for (const connector of piece.connectors) {
      ends.push({ local: composePose16(pose, connector), plates });
    }
  }
  if (pieces.length === 0 && uncertified.length === 0) return null;
  const openEnds = ends.filter(
    (end, i) =>
      !ends.some(
        (other, j) => j !== i && other.plates === end.plates && posesJoin16(end.local, other.local),
      ),
  );
  return { pieces, openEnds, uncertified };
}

export function latticePose16(xLdu: number, zLdu: number, rot: number): Pose16 {
  if (!Number.isInteger(xLdu / STUD_LDU) || !Number.isInteger(zLdu / STUD_LDU)) {
    throw new RangeError(`(${xLdu}, ${zLdu}) LDU is not on the stud lattice`);
  }
  const position = Array.from({ length: ZETA16_COEFFICIENT_COUNT }, () => 0n);
  position[0] = BigInt(xLdu / STUD_LDU);
  position[ZETA16_COEFFICIENT_COUNT / 2] = BigInt(zLdu / STUD_LDU);
  return pose16(zeta16(position), -QUARTER_TURN_STEPS * rot);
}

export function heldPlacements(
  track: ModelTrack,
  xLdu: number,
  zLdu: number,
  yPlates: number,
  rot: number,
): ReadonlyArray<{
  readonly catalogIndex: number;
  readonly placement: Pose16;
  readonly plates: number;
}> {
  const frame = latticePose16(xLdu, zLdu, rot);
  return track.pieces.map((piece) => ({
    catalogIndex: piece.catalogIndex,
    placement: composePose16(frame, piece.local),
    plates: yPlates + piece.plates,
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

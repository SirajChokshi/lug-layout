import type { PartShapeAsset } from "@brr/catalog";
import type { TrackEnd } from "@brr/domain";
import {
  PLATE_LDU,
  STUD_LDU,
  UNROUNDED_TOLERANCE_LDU,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  certifiedZeta16,
  composePose16,
  normalizeHeading16,
  pose16,
  posesJoin16,
  zeta16,
  type Pose16,
  type Zeta16,
} from "@brr/math";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import type { TrackCatalog } from "@brr/schema/bundle";

const HEADING_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_RADIANS / 2;
const QUARTER_TURN_ENTRIES: ReadonlyArray<number> = [-1, 0, 1];
const QUARTER_TURN_STEPS = ZETA16_ORDER / 4;

export interface TrackInstances {
  readonly count: number;
  readonly partIndex: ArrayLike<number>;
  readonly matrices: Float64Array;
}

export interface HeldTrackPiece {
  readonly catalogIndex: number;
  readonly placement: Pose16;
  readonly yPlates: number;
}

export interface ModelTrackEnds {
  readonly pieces: ReadonlyArray<HeldTrackPiece>;
  readonly openEnds: ReadonlyArray<TrackEnd>;
  readonly uncertified: ReadonlyArray<string>;
}

interface PieceOfPart {
  readonly catalogIndex: number;
  readonly connectors: ReadonlyArray<Pose16>;
  readonly xLdu: number;
  readonly zLdu: number;
  readonly headingHalfSteps: number;
}

function piecesByPart(catalog: TrackCatalog): Map<string, PieceOfPart | null> {
  const byPart = new Map<string, PieceOfPart | null>();
  catalog.pieces.forEach((piece, catalogIndex) => {
    if (piece.status !== "certified") return;
    const entry: PieceOfPart = {
      catalogIndex,
      connectors: piece.connectors.map((connector) => connector.pose),
      xLdu: piece.partFrame.xLdu,
      zLdu: piece.partFrame.zLdu,
      headingHalfSteps: piece.partFrame.headingHalfSteps,
    };
    byPart.set(piece.part, byPart.has(piece.part) ? null : entry);
  });
  return byPart;
}

function exactQuarterTurnOnWholeLdu(m: Float64Array, o: number): boolean {
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

function piecePose(m: Float64Array, o: number, piece: PieceOfPart): Pose16 | null {
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

function piecePlates(m: Float64Array, o: number, part: PartShapeAsset): number | null {
  const plates = ((m[o + 7] ?? 0) + part.boundsMin[1]) / PLATE_LDU;
  return Number.isInteger(plates) ? plates : null;
}

export function modelTrackEnds(
  instances: TrackInstances,
  parts: ReadonlyArray<PartShapeAsset>,
  catalog: TrackCatalog,
): ModelTrackEnds {
  const byPart = piecesByPart(catalog);
  const pieces: HeldTrackPiece[] = [];
  const ends: TrackEnd[] = [];
  const uncertified: string[] = [];
  for (let i = 0; i < instances.count; i++) {
    const part = parts[instances.partIndex[i] ?? -1];
    if (!part || !byPart.has(part.id)) continue;
    const piece = byPart.get(part.id);
    const o = i * INSTANCE_MATRIX_FLOATS;
    const placement = piece ? piecePose(instances.matrices, o, piece) : null;
    const plates = piecePlates(instances.matrices, o, part);
    if (!piece || !placement || plates === null) {
      uncertified.push(part.id);
      continue;
    }
    pieces.push({ catalogIndex: piece.catalogIndex, placement, yPlates: plates });
    for (const connector of piece.connectors) {
      ends.push({ pose: composePose16(placement, connector), yPlates: plates });
    }
  }
  const openEnds = ends.filter(
    (end, i) =>
      !ends.some(
        (other, j) => j !== i && other.yPlates === end.yPlates && posesJoin16(end.pose, other.pose),
      ),
  );
  return { pieces, openEnds, uncertified };
}

export function heldPieces(
  track: ModelTrackEnds,
  frame: Pose16,
  yPlates: number,
): ReadonlyArray<HeldTrackPiece> {
  return track.pieces.map((piece) => ({
    catalogIndex: piece.catalogIndex,
    placement: composePose16(frame, piece.placement),
    yPlates: yPlates + piece.yPlates,
  }));
}

export function latticeFrame(xLdu: number, zLdu: number, rot: number): Pose16 | null {
  const xStuds = xLdu / STUD_LDU;
  const zStuds = zLdu / STUD_LDU;
  if (!Number.isInteger(xStuds) || !Number.isInteger(zStuds)) return null;
  const coefficients = Array.from({ length: ZETA16_COEFFICIENT_COUNT }, () => 0n);
  coefficients[0] = BigInt(xStuds);
  coefficients[ZETA16_COEFFICIENT_COUNT / 2] = BigInt(zStuds);
  return pose16(zeta16(coefficients), normalizeHeading16(-QUARTER_TURN_STEPS * rot));
}

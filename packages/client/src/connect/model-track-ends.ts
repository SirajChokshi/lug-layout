import type { PartShapeAsset } from "@brr/catalog";
import {
  NEAR_MISS_RADIUS_LDU,
  WORLD_TRACK_FRAME,
  type TrackEnd,
  type TrackFrame,
} from "@brr/domain";
import {
  CERTIFIED_RESIDUAL_LIMIT_LDU,
  HALF_TURN_16,
  PLATE_LDU,
  STUD_LDU,
  UNROUNDED_TOLERANCE_LDU,
  ZETA16_COEFFICIENT_COUNT,
  ZETA16_ORDER,
  ZETA16_STEP_RADIANS,
  addZeta16,
  attachPose16,
  certifiedZeta16,
  composePose16,
  isLatticePose16,
  normalizeHeading16,
  pose16,
  pose16Equals,
  posesJoin16,
  subtractZeta16,
  zeta16,
  zeta16Direction,
  zeta16ToStuds,
  type PlaneStuds,
  type Pose16,
  type Zeta16,
} from "@brr/math";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import type { TrackCatalog } from "@brr/schema/bundle";

const HALF_STEP_RADIANS = ZETA16_STEP_RADIANS / 2;
const QUARTER_TURN_STEPS = ZETA16_ORDER / 4;
const RESIDUAL_LIMIT_STUDS = CERTIFIED_RESIDUAL_LIMIT_LDU / STUD_LDU;
const ROTATION_ENTRY_RESIDUAL = CERTIFIED_RESIDUAL_LIMIT_LDU;
const PAIRED_ENDS_REACH_STUDS = 2 * RESIDUAL_LIMIT_STUDS;
const END_FLOATS = 4;
const NEAR_MISS_RADIUS_STUDS = NEAR_MISS_RADIUS_LDU / STUD_LDU;
const AGREEING_ANCHORS_OFF_THE_LATTICE = 2;

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

export interface FramedTrackPiece extends HeldTrackPiece {
  readonly frame: TrackFrame;
}

export interface TrackRun {
  readonly pieces: ReadonlyArray<HeldTrackPiece>;
  readonly originStuds: PlaneStuds;
}

export type UncertifiedReason = "notFlat" | "noAnchor" | "overLimit" | "contradiction";

export interface UncertifiedPiece {
  readonly partId: string;
  readonly reason: UncertifiedReason;
}

export interface ModelTrackEnds {
  readonly pieces: ReadonlyArray<HeldTrackPiece>;
  readonly openEnds: ReadonlyArray<TrackEnd>;
  readonly runs: ReadonlyArray<TrackRun>;
  readonly uncertified: ReadonlyArray<UncertifiedPiece>;
}

interface Placements {
  readonly outcomes: Array<Pose16 | UncertifiedReason>;
  readonly unanchoredOnly: Uint8Array;
}

interface RunFrame {
  readonly members: ReadonlyArray<number>;
  readonly relative: ReadonlyArray<Pose16>;
  readonly originStuds: PlaneStuds;
}

interface PieceOfPart {
  readonly catalogIndex: number;
  readonly connectors: ReadonlyArray<Pose16>;
  readonly offset: PlaneStuds;
  readonly halfSteps: number;
  readonly localEnds: Float64Array;
}

interface Candidate {
  readonly partId: string;
  readonly piece: PieceOfPart;
  readonly heading: number;
  readonly plates: number;
  readonly placement: PlaneStuds;
  readonly ends: Float64Array;
}

interface Anchor {
  readonly pose: Pose16;
  readonly seated: boolean;
}

interface ExactTurn {
  readonly heading: number;
  readonly cos: number;
  readonly sin: number;
}

function rotated(point: PlaneStuds, radians: number): PlaneStuds {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: cos * point.x - sin * point.z, z: sin * point.x + cos * point.z };
}

function latticePoint(xStuds: number, zStuds: number): Zeta16 {
  const coefficients = Array.from({ length: ZETA16_COEFFICIENT_COUNT }, () => 0n);
  coefficients[0] = BigInt(xStuds);
  coefficients[ZETA16_COEFFICIENT_COUNT / 2] = BigInt(zStuds);
  return zeta16(coefficients);
}

function pieceOfPart(catalogIndex: number, piece: TrackCatalog["pieces"][number]): PieceOfPart {
  const connectors = piece.connectors.map((connector) => connector.pose);
  const offset = { x: piece.partFrame.xLdu / STUD_LDU, z: piece.partFrame.zLdu / STUD_LDU };
  const halfSteps = piece.partFrame.headingHalfSteps;
  const toPart = -halfSteps * HALF_STEP_RADIANS;
  const localEnds = new Float64Array(connectors.length * END_FLOATS);
  connectors.forEach((pose, c) => {
    const exact = zeta16ToStuds(pose.position);
    const at = rotated({ x: exact.x - offset.x, z: exact.z - offset.z }, toPart);
    const facing = rotated(zeta16Direction(pose.heading), toPart);
    localEnds.set([at.x, at.z, facing.x, facing.z], c * END_FLOATS);
  });
  return { catalogIndex, connectors, offset, halfSteps, localEnds };
}

function piecesByPart(catalog: TrackCatalog): Map<string, PieceOfPart | null> {
  const byPart = new Map<string, PieceOfPart | null>();
  catalog.pieces.forEach((piece, catalogIndex) => {
    if (piece.status !== "certified") return;
    byPart.set(piece.part, byPart.has(piece.part) ? null : pieceOfPart(catalogIndex, piece));
  });
  return byPart;
}

function liesFlat(m: Float64Array, o: number): boolean {
  return m[o + 1] === 0 && m[o + 4] === 0 && m[o + 5] === 1 && m[o + 6] === 0 && m[o + 9] === 0;
}

function piecePlates(m: Float64Array, o: number, part: PartShapeAsset): number | null {
  const plates = ((m[o + 7] ?? 0) + part.boundsMin[1]) / PLATE_LDU;
  return Number.isInteger(plates) ? plates : null;
}

function exactTurn(m: Float64Array, o: number, piece: PieceOfPart): ExactTurn | null {
  const radians = Math.atan2(m[o + 8] ?? 0, m[o] ?? 0) - piece.halfSteps * HALF_STEP_RADIANS;
  const heading = normalizeHeading16(Math.round(radians / ZETA16_STEP_RADIANS));
  const turn = heading * ZETA16_STEP_RADIANS + piece.halfSteps * HALF_STEP_RADIANS;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  const residuals = [
    (m[o] ?? 0) - cos,
    (m[o + 2] ?? 0) + sin,
    (m[o + 8] ?? 0) - sin,
    (m[o + 10] ?? 0) - cos,
  ];
  return residuals.every((residual) => Math.abs(residual) <= ROTATION_ENTRY_RESIDUAL)
    ? { heading, cos, sin }
    : null;
}

function candidateOf(
  m: Float64Array,
  o: number,
  part: PartShapeAsset,
  piece: PieceOfPart,
): Candidate | UncertifiedReason {
  const plates = piecePlates(m, o, part);
  if (!liesFlat(m, o) || plates === null) return "notFlat";
  const turn = exactTurn(m, o, piece);
  if (!turn) return "overLimit";
  const { heading, cos, sin } = turn;
  const facing = zeta16Direction(heading);
  const placement = {
    x: (m[o + 3] ?? 0) / STUD_LDU - (facing.x * piece.offset.x - facing.z * piece.offset.z),
    z: (m[o + 11] ?? 0) / STUD_LDU - (facing.z * piece.offset.x + facing.x * piece.offset.z),
  };
  const local = piece.localEnds;
  const ends = new Float64Array(local.length);
  for (let e = 0; e < local.length; e += END_FLOATS) {
    const x = local[e] ?? 0;
    const z = local[e + 1] ?? 0;
    const dx = local[e + 2] ?? 0;
    const dz = local[e + 3] ?? 0;
    ends[e] = cos * x - sin * z + (m[o + 3] ?? 0) / STUD_LDU;
    ends[e + 1] = sin * x + cos * z + (m[o + 11] ?? 0) / STUD_LDU;
    ends[e + 2] = cos * dx - sin * dz;
    ends[e + 3] = sin * dx + cos * dz;
  }
  return { partId: part.id, piece, heading, plates, placement, ends };
}

function withinLimit(dx: number, dz: number): boolean {
  return Math.abs(dx) <= RESIDUAL_LIMIT_STUDS && Math.abs(dz) <= RESIDUAL_LIMIT_STUDS;
}

function endsMatch(candidate: Candidate, placement: Pose16): boolean {
  return candidate.piece.connectors.every((connector, c) => {
    const end = composePose16(placement, connector);
    const at = zeta16ToStuds(end.position);
    const facing = zeta16Direction(end.heading);
    const e = c * END_FLOATS;
    const ends = candidate.ends;
    return (
      withinLimit((ends[e] ?? 0) - at.x, (ends[e + 1] ?? 0) - at.z) &&
      withinLimit((ends[e + 2] ?? 0) - facing.x, (ends[e + 3] ?? 0) - facing.z)
    );
  });
}

function anchorOf(candidate: Candidate): Anchor | null {
  const x = Math.round(candidate.placement.x);
  const z = Math.round(candidate.placement.z);
  const seat = pose16(latticePoint(x, z), candidate.heading);
  if (isLatticePose16(seat) && withinLimit(candidate.placement.x - x, candidate.placement.z - z)) {
    return { pose: seat, seated: true };
  }
  const remainder = certifiedZeta16(
    { x: candidate.placement.x - x, y: candidate.placement.z - z },
    UNROUNDED_TOLERANCE_LDU,
  );
  if (!remainder) return null;
  return {
    pose: pose16(addZeta16(latticePoint(x, z), remainder), candidate.heading),
    seated: false,
  };
}

class EndIndex {
  private readonly cells = new Map<string, number[]>();

  constructor(private readonly candidates: ReadonlyArray<Candidate>) {
    candidates.forEach((candidate, i) => {
      for (let c = 0; c < candidate.piece.connectors.length; c++) {
        const key = EndIndex.key(
          Math.floor(candidate.ends[c * END_FLOATS] ?? 0),
          Math.floor(candidate.ends[c * END_FLOATS + 1] ?? 0),
        );
        const cell = this.cells.get(key);
        if (cell) cell.push(i, c);
        else this.cells.set(key, [i, c]);
      }
    });
  }

  private static key(x: number, z: number): string {
    return `${x},${z}`;
  }

  near(x: number, z: number, visit: (candidate: number, connector: number) => void): void {
    this.within(x, z, Math.SQRT2 * PAIRED_ENDS_REACH_STUDS, (candidate, connector) => {
      const ends = this.candidates[candidate]?.ends;
      const e = connector * END_FLOATS;
      if (
        ends &&
        Math.abs((ends[e] ?? 0) - x) <= PAIRED_ENDS_REACH_STUDS &&
        Math.abs((ends[e + 1] ?? 0) - z) <= PAIRED_ENDS_REACH_STUDS
      ) {
        visit(candidate, connector);
      }
    });
  }

  within(
    x: number,
    z: number,
    radius: number,
    visit: (candidate: number, connector: number) => void,
  ): void {
    const cellX = Math.floor(x);
    const cellZ = Math.floor(z);
    const reach = Math.ceil(radius);
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const cell = this.cells.get(EndIndex.key(cellX + dx, cellZ + dz)) ?? [];
        for (let k = 0; k < cell.length; k += 2) {
          const i = cell[k] ?? 0;
          const c = cell[k + 1] ?? 0;
          const ends = this.candidates[i]?.ends;
          if (!ends) continue;
          const e = c * END_FLOATS;
          if (Math.hypot((ends[e] ?? 0) - x, (ends[e + 1] ?? 0) - z) <= radius) {
            visit(i, c);
          }
        }
      }
    }
  }
}

function certifiedPlacements(candidates: ReadonlyArray<Candidate>, index: EndIndex): Placements {
  const placements: Array<Pose16 | null> = candidates.map(() => null);
  const ambiguous = new Uint8Array(candidates.length);
  const overLimit = new Uint8Array(candidates.length);
  const uncorroborated = new Uint8Array(candidates.length);

  const implied = (i: number): Pose16[] => {
    const candidate = candidates[i];
    const options: Pose16[] = [];
    if (!candidate) return options;
    candidate.piece.connectors.forEach((connector, c) => {
      const e = c * END_FLOATS;
      index.near(candidate.ends[e] ?? 0, candidate.ends[e + 1] ?? 0, (j, d) => {
        const other = candidates[j];
        const at = placements[j];
        const theirs = other?.piece.connectors[d];
        if (j === i || !other || !at || !theirs || other.plates !== candidate.plates) return;
        const end = composePose16(at, theirs);
        if (
          normalizeHeading16(candidate.heading + connector.heading - end.heading) !== HALF_TURN_16
        ) {
          return;
        }
        const option = attachPose16(connector, end);
        if (!endsMatch(candidate, option)) {
          overLimit[i] = 1;
          return;
        }
        if (!options.some((known) => pose16Equals(known, option))) options.push(option);
      });
    });
    return options;
  };

  const spread = (from: number): number[] => {
    const group = [from];
    const queue = [from];
    while (queue.length > 0) {
      const j = queue.pop() ?? 0;
      const placed = candidates[j];
      if (!placed) continue;
      for (let d = 0; d < placed.piece.connectors.length; d++) {
        const e = d * END_FLOATS;
        index.near(placed.ends[e] ?? 0, placed.ends[e + 1] ?? 0, (i) => {
          if (placements[i] || ambiguous[i]) return;
          const options = implied(i);
          if (options.length > 1) ambiguous[i] = 1;
          const only = options.length === 1 ? options[0] : undefined;
          if (!only) return;
          placements[i] = only;
          group.push(i);
          queue.push(i);
        });
      }
    }
    return group;
  };

  const anchors = candidates.map((candidate, i) => {
    const anchor = anchorOf(candidate);
    if (!anchor || endsMatch(candidate, anchor.pose)) return anchor;
    overLimit[i] = 1;
    return null;
  });

  const settleByVote = (
    group: ReadonlyArray<number>,
    before: { readonly ambiguous: Uint8Array; readonly overLimit: Uint8Array },
  ): void => {
    const votes = new Map<string, { readonly shift: Zeta16; count: number; seated: boolean }>();
    for (const i of group) {
      const anchor = anchors[i];
      const placed = placements[i];
      if (!anchor || !placed || anchor.pose.heading !== placed.heading) continue;
      const shift = subtractZeta16(anchor.pose.position, placed.position);
      const vote = votes.get(shift.join(","));
      if (vote) {
        vote.count++;
        vote.seated ||= anchor.seated;
      } else {
        votes.set(shift.join(","), { shift, count: 1, seated: anchor.seated });
      }
    }
    const corroborated = [...votes.values()]
      .filter((vote) => vote.seated || vote.count >= AGREEING_ANCHORS_OFF_THE_LATTICE)
      .toSorted((a, b) => b.count - a.count);
    const winner = corroborated[0];
    if (!winner) {
      ambiguous.set(before.ambiguous);
      overLimit.set(before.overLimit);
      for (const i of group) {
        placements[i] = null;
        uncorroborated[i] = 1;
      }
      return;
    }
    const tied = corroborated[1]?.count === winner.count;
    const rivals = [...votes.values()]
      .filter((vote) => vote !== winner)
      .map((vote) => subtractZeta16(vote.shift, winner.shift));
    for (const i of group) {
      const placed = placements[i];
      const candidate = candidates[i];
      const moved =
        !tied && placed ? pose16(addZeta16(placed.position, winner.shift), placed.heading) : null;
      const unique =
        moved &&
        candidate &&
        endsMatch(candidate, moved) &&
        !rivals.some((rival) =>
          endsMatch(candidate, pose16(addZeta16(moved.position, rival), moved.heading)),
        );
      placements[i] = unique ? moved : null;
      if (!unique) ambiguous[i] = 1;
    }
  };

  const missesACertifiedNeighbour = (i: number): boolean => {
    const candidate = candidates[i];
    if (!candidate) return false;
    let missed = false;
    for (let c = 0; c < candidate.piece.connectors.length; c++) {
      const e = c * END_FLOATS;
      index.within(
        candidate.ends[e] ?? 0,
        candidate.ends[e + 1] ?? 0,
        NEAR_MISS_RADIUS_STUDS,
        (j, d) => {
          const other = candidates[j];
          const at = placements[j];
          const theirs = other?.piece.connectors[d];
          if (j === i || !other || !at || !theirs || other.plates !== candidate.plates) return;
          const facing = zeta16Direction(composePose16(at, theirs).heading);
          const facingAway =
            (candidate.ends[e + 2] ?? 0) * facing.x + (candidate.ends[e + 3] ?? 0) * facing.z;
          if (facingAway < 0) missed = true;
        },
      );
    }
    return missed;
  };

  const seatedFirst = anchors
    .map((anchor, a) => ({ anchor, a }))
    .filter((entry): entry is { anchor: Anchor; a: number } => entry.anchor !== null)
    .toSorted((x, y) => Number(y.anchor.seated) - Number(x.anchor.seated));
  for (const { anchor, a } of seatedFirst) {
    if (placements[a] || ambiguous[a] || uncorroborated[a]) continue;
    const before = { ambiguous: ambiguous.slice(), overLimit: overLimit.slice() };
    placements[a] = anchor.pose;
    settleByVote(spread(a), before);
  }
  const unanchoredOnly = new Uint8Array(candidates.length);
  const outcomes = placements.map((placement, i): Pose16 | UncertifiedReason => {
    if (!placement) {
      if (ambiguous[i]) return "contradiction";
      if (overLimit[i]) return "overLimit";
      unanchoredOnly[i] = 1;
      return missesACertifiedNeighbour(i) ? "overLimit" : "noAnchor";
    }
    const absolute = anchors[i]?.pose;
    const agreed =
      (!absolute || pose16Equals(absolute, placement)) &&
      implied(i).every((option) => pose16Equals(option, placement));
    return agreed ? placement : "contradiction";
  });
  return { outcomes, unanchoredOnly };
}

function runPartners(
  candidates: ReadonlyArray<Candidate>,
  index: EndIndex,
  eligible: Uint8Array,
): ReadonlyArray<ReadonlyArray<ReadonlyArray<readonly [number, number]>>> {
  return candidates.map((candidate, i) =>
    candidate.piece.connectors.map((connector, c) => {
      const partners: Array<readonly [number, number]> = [];
      if (!eligible[i]) return partners;
      const e = c * END_FLOATS;
      const facing = normalizeHeading16(candidate.heading + connector.heading);
      index.near(candidate.ends[e] ?? 0, candidate.ends[e + 1] ?? 0, (j, d) => {
        const other = candidates[j];
        const theirs = other?.piece.connectors[d];
        if (j === i || !eligible[j] || !other || !theirs || other.plates !== candidate.plates) {
          return;
        }
        const opposite = normalizeHeading16(facing - other.heading - theirs.heading);
        if (opposite === HALF_TURN_16) partners.push([j, d]);
      });
      return partners;
    }),
  );
}

function runFrames(
  candidates: ReadonlyArray<Candidate>,
  index: EndIndex,
  eligible: Uint8Array,
): { readonly runs: ReadonlyArray<RunFrame>; readonly contradicted: Uint8Array } {
  const partners = runPartners(candidates, index, eligible);
  const contradicted = new Uint8Array(candidates.length);
  partners.forEach((ends, i) => {
    for (const end of ends) {
      if (end.length <= 1) continue;
      contradicted[i] = 1;
      for (const [j] of end) contradicted[j] = 1;
    }
  });
  const relative: Array<Pose16 | null> = candidates.map(() => null);
  const runs: RunFrame[] = [];
  candidates.forEach((root, r) => {
    if (!eligible[r] || relative[r]) return;
    relative[r] = pose16(latticePoint(0, 0), root.heading);
    const members = [r];
    let consistent = true;
    for (let q = 0; q < members.length; q++) {
      const i = members[q] ?? 0;
      const at = relative[i];
      const candidate = candidates[i];
      if (!at || !candidate) continue;
      candidate.piece.connectors.forEach((connector, c) => {
        for (const [j, d] of partners[i]?.[c] ?? []) {
          const theirs = candidates[j]?.piece.connectors[d];
          if (!theirs) continue;
          const implied = attachPose16(theirs, composePose16(at, connector));
          const known = relative[j];
          if (!known) {
            relative[j] = implied;
            members.push(j);
          } else if (!pose16Equals(known, implied)) consistent = false;
        }
      });
    }
    if (members.length < 2) return;
    const box = { lowX: -Infinity, highX: Infinity, lowZ: -Infinity, highZ: Infinity };
    for (const i of members) {
      const at = relative[i];
      const candidate = candidates[i];
      if (!at || !candidate) continue;
      const offset = zeta16ToStuds(at.position);
      box.lowX = Math.max(box.lowX, candidate.placement.x - offset.x - RESIDUAL_LIMIT_STUDS);
      box.highX = Math.min(box.highX, candidate.placement.x - offset.x + RESIDUAL_LIMIT_STUDS);
      box.lowZ = Math.max(box.lowZ, candidate.placement.z - offset.z - RESIDUAL_LIMIT_STUDS);
      box.highZ = Math.min(box.highZ, candidate.placement.z - offset.z + RESIDUAL_LIMIT_STUDS);
    }
    const fits = box.lowX <= box.highX && box.lowZ <= box.highZ;
    if (!consistent || !fits || members.some((i) => contradicted[i])) {
      for (const i of members) contradicted[i] = 1;
      return;
    }
    runs.push({
      members,
      relative: members.map((i) => relative[i] ?? pose16(latticePoint(0, 0), 0)),
      originStuds: { x: (box.lowX + box.highX) / 2, z: (box.lowZ + box.highZ) / 2 },
    });
  });
  return { runs, contradicted };
}

function pointKey(end: TrackEnd): string {
  return `${end.yPlates}:${end.pose.position.join(",")}`;
}

export function modelTrackEnds(
  instances: TrackInstances,
  parts: ReadonlyArray<PartShapeAsset>,
  catalog: TrackCatalog,
): ModelTrackEnds {
  const byPart = piecesByPart(catalog);
  const candidates: Candidate[] = [];
  const uncertified: UncertifiedPiece[] = [];
  for (let i = 0; i < instances.count; i++) {
    const part = parts[instances.partIndex[i] ?? -1];
    if (!part || !byPart.has(part.id)) continue;
    const piece = byPart.get(part.id);
    if (!piece) {
      uncertified.push({ partId: part.id, reason: "contradiction" });
      continue;
    }
    const candidate = candidateOf(instances.matrices, i * INSTANCE_MATRIX_FLOATS, part, piece);
    if (typeof candidate === "string") uncertified.push({ partId: part.id, reason: candidate });
    else candidates.push(candidate);
  }
  const index = new EndIndex(candidates);
  const { outcomes, unanchoredOnly } = certifiedPlacements(candidates, index);
  const { runs, contradicted } = runFrames(candidates, index, unanchoredOnly);
  const inRun = new Uint8Array(candidates.length);
  for (const run of runs) for (const i of run.members) inRun[i] = 1;
  const pieces: HeldTrackPiece[] = [];
  const ends: TrackEnd[] = [];
  outcomes.forEach((placement, i) => {
    const candidate = candidates[i];
    if (!candidate || inRun[i]) return;
    if (typeof placement === "string") {
      const reason = contradicted[i] ? "contradiction" : placement;
      uncertified.push({ partId: candidate.partId, reason });
      return;
    }
    pieces.push({
      catalogIndex: candidate.piece.catalogIndex,
      placement,
      yPlates: candidate.plates,
    });
    for (const connector of candidate.piece.connectors) {
      ends.push({
        pose: composePose16(placement, connector),
        yPlates: candidate.plates,
        frame: WORLD_TRACK_FRAME,
      });
    }
  });
  const atPoint = new Map<string, TrackEnd[]>();
  for (const end of ends) {
    const sharing = atPoint.get(pointKey(end));
    if (sharing) sharing.push(end);
    else atPoint.set(pointKey(end), [end]);
  }
  const openEnds = ends.filter(
    (end) =>
      !(atPoint.get(pointKey(end)) ?? []).some(
        (other) => other !== end && posesJoin16(end.pose, other.pose),
      ),
  );
  const trackRuns = runs.map((run): TrackRun => ({
    originStuds: run.originStuds,
    pieces: run.members.map((i, k) => ({
      catalogIndex: candidates[i]?.piece.catalogIndex ?? 0,
      placement: run.relative[k] ?? pose16(latticePoint(0, 0), 0),
      yPlates: candidates[i]?.plates ?? 0,
    })),
  }));
  return { pieces, openEnds, runs: trackRuns, uncertified };
}

export function heldPieces(
  track: ModelTrackEnds,
  frame: Pose16,
  yPlates: number,
): ReadonlyArray<FramedTrackPiece> {
  return track.pieces.map((piece) => ({
    catalogIndex: piece.catalogIndex,
    placement: composePose16(frame, piece.placement),
    yPlates: yPlates + piece.yPlates,
    frame: WORLD_TRACK_FRAME,
  }));
}

export function heldRuns(
  track: ModelTrackEnds,
  frame: Pose16,
  yPlates: number,
  firstFrameId: number,
): ReadonlyArray<FramedTrackPiece> {
  const facing = zeta16Direction(frame.heading);
  return track.runs.flatMap((run, r) => {
    const { x, z } = run.originStuds;
    const runFrame: TrackFrame = {
      id: firstFrameId + r,
      xLdu: (facing.x * x - facing.z * z) * STUD_LDU,
      zLdu: (facing.z * x + facing.x * z) * STUD_LDU,
    };
    return run.pieces.map((piece) => ({
      catalogIndex: piece.catalogIndex,
      placement: composePose16(frame, piece.placement),
      yPlates: yPlates + piece.yPlates,
      frame: runFrame,
    }));
  });
}

export function latticeFrame(xLdu: number, zLdu: number, rot: number): Pose16 | null {
  const xStuds = xLdu / STUD_LDU;
  const zStuds = zLdu / STUD_LDU;
  if (!Number.isInteger(xStuds) || !Number.isInteger(zStuds)) return null;
  return pose16(latticePoint(xStuds, zStuds), normalizeHeading16(-QUARTER_TURN_STEPS * rot));
}

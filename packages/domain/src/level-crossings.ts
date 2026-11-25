import {
  CHUNK_LDU,
  SIXTEENTHS_PER_LDU,
  STUD_LDU,
  isRot90,
  rot90Cos,
  rot90Sin,
  type Rot90,
} from "@brr/math";
import type { CrossingRamp } from "@brr/schema/bundle";
import { PlacedOutline, type AxisEdge, type OutlineRing } from "./plan/placed-outline.ts";
import type { LduRect } from "./plan/plan-region.ts";
import { placedCells, type RoadPlacement } from "./road-joins.ts";

export interface CrossingTrack {
  readonly outline: PlacedOutline;
  readonly bedLdu: number;
  readonly railTopLdu: number;
}

export interface RampPart {
  readonly facts: CrossingRamp;
  readonly outline: ReadonlyArray<OutlineRing>;
}

export interface RampCandidate {
  readonly part: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly rot: Rot90;
  readonly rect: LduRect;
  readonly undersideLdu: number;
  readonly antiStuds: ReadonlyArray<readonly [number, number]>;
  readonly roadwayCovered: number;
}

export interface LevelCrossing {
  readonly tracks: ReadonlyArray<number>;
  readonly roads: ReadonlyArray<number>;
  readonly roadwayCells: number;
  readonly candidates: ReadonlyArray<RampCandidate>;
}

interface SurfaceCell {
  readonly placement: number;
  readonly nearIndex: number;
  readonly topSixteenths: number;
  readonly road: boolean;
  readonly square: LduRect;
}

interface Candidate {
  readonly track: number;
  readonly part: RampPart;
  readonly x: number;
  readonly z: number;
  readonly rot: Rot90;
  readonly rect: LduRect;
  readonly high: readonly [readonly [number, number], readonly [number, number]];
}

const HALF_STUD_LDU = STUD_LDU / 2;
const CELL_KEY_SPAN = 2 ** 24;
const ROTATIONS: ReadonlyArray<Rot90> = [0, 1, 2, 3];

function cellKey(cellX: number, cellZ: number): number {
  return (cellX + CELL_KEY_SPAN / 2) * CELL_KEY_SPAN + (cellZ + CELL_KEY_SPAN / 2);
}

function rotated(rot: Rot90, x: number, z: number): readonly [number, number] {
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  return [cos * x + sin * z + 0, -sin * x + cos * z + 0];
}

function rotatedBox(rot: Rot90, box: LduRect): LduRect {
  const [ax, az] = rotated(rot, box.minX, box.minZ);
  const [bx, bz] = rotated(rot, box.maxX, box.maxZ);
  return {
    minX: Math.min(ax, bx),
    minZ: Math.min(az, bz),
    maxX: Math.max(ax, bx),
    maxZ: Math.max(az, bz),
  };
}

function shifted(box: LduRect, x: number, z: number): LduRect {
  return { minX: box.minX + x, minZ: box.minZ + z, maxX: box.maxX + x, maxZ: box.maxZ + z };
}

function latticePhase(offset: number): number {
  return (((HALF_STUD_LDU - offset) % STUD_LDU) + STUD_LDU) % STUD_LDU;
}

function onPhase(value: number, phase: number): boolean {
  return (((value - phase) % STUD_LDU) + STUD_LDU) % STUD_LDU === 0;
}

class SurfaceIndex {
  readonly cells: SurfaceCell[] = [];
  readonly cellsOf = new Map<number, readonly [number, number]>();
  readonly firstCellOf: number[] = [];
  private readonly buckets = new Map<number, number[]>();

  add(cell: SurfaceCell): void {
    const index = this.cells.length;
    this.cells.push(cell);
    const key = cellKey(
      Math.floor((cell.square.minX + HALF_STUD_LDU) / STUD_LDU),
      Math.floor((cell.square.minZ + HALF_STUD_LDU) / STUD_LDU),
    );
    const bucket = this.buckets.get(key);
    if (bucket) bucket.push(index);
    else this.buckets.set(key, [index]);
  }

  overlapping(rect: LduRect): ReadonlyArray<number> {
    const found: number[] = [];
    this.eachOverlapping(rect, (index) => found.push(index));
    return found;
  }

  countOverlapping(rect: LduRect): number {
    let count = 0;
    this.eachOverlapping(rect, () => count++);
    return count;
  }

  private eachOverlapping(rect: LduRect, visit: (index: number) => void): void {
    const reach = grown(rect);
    const toX = Math.ceil(reach.maxX / STUD_LDU);
    const toZ = Math.ceil(reach.maxZ / STUD_LDU);
    for (let x = Math.floor(reach.minX / STUD_LDU); x < toX; x++) {
      for (let z = Math.floor(reach.minZ / STUD_LDU); z < toZ; z++) {
        const bucket = this.buckets.get(cellKey(x, z));
        if (!bucket) continue;
        for (const index of bucket) {
          const cell = this.cells[index];
          if (cell && squaresOverlap(cell.square, rect)) visit(index);
        }
      }
    }
  }
}

function surfaceIndex(roads: ReadonlyArray<RoadPlacement>): SurfaceIndex {
  const index = new SurfaceIndex();
  roads.forEach((road, nearIndex) => {
    const first = index.cells.length;
    index.firstCellOf.push(first);
    for (const cell of placedCells(road)) {
      index.add({
        placement: cell.placement,
        nearIndex,
        topSixteenths: cell.topSixteenths,
        road: cell.road === 1,
        square: {
          minX: cell.centreX - HALF_STUD_LDU,
          minZ: cell.centreZ - HALF_STUD_LDU,
          maxX: cell.centreX + HALF_STUD_LDU,
          maxZ: cell.centreZ + HALF_STUD_LDU,
        },
      });
    }
    index.cellsOf.set(road.id, [first, index.cells.length]);
  });
  return index;
}

function placementRect(road: RoadPlacement): LduRect {
  const { surface, rot } = road;
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  const local = {
    minX: surface.minX,
    minZ: surface.minZ,
    maxX: surface.minX + surface.columns * STUD_LDU,
    maxZ: surface.minZ + surface.rows * STUD_LDU,
  };
  return shifted(rotatedBox(rot, local), road.x, road.z);
}

function chunkSpan(from: number, to: number): readonly [number, number] {
  return [Math.floor(from / CHUNK_LDU), Math.floor(to / CHUNK_LDU)];
}

function rectsMeet(a: LduRect, b: LduRect): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minZ <= b.maxZ && b.minZ <= a.maxZ;
}

function grown(rect: LduRect): LduRect {
  return {
    minX: rect.minX - HALF_STUD_LDU,
    minZ: rect.minZ - HALF_STUD_LDU,
    maxX: rect.maxX + HALF_STUD_LDU,
    maxZ: rect.maxZ + HALF_STUD_LDU,
  };
}

function squaresOverlap(a: LduRect, b: LduRect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
}

function shareAnEdge(a: LduRect, b: LduRect): boolean {
  const alongX = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const alongZ = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  return (alongX > 0 && alongZ >= 0) || (alongZ > 0 && alongX >= 0);
}

function touchingReach(square: LduRect): LduRect {
  return {
    minX: square.minX - 1,
    minZ: square.minZ - 1,
    maxX: square.maxX + 1,
    maxZ: square.maxZ + 1,
  };
}

function bedSixteenths(track: CrossingTrack): number {
  return track.bedLdu * SIXTEENTHS_PER_LDU;
}

function coveredRoadway(track: CrossingTrack, index: SurfaceIndex): ReadonlyArray<number> {
  const covered: number[] = [];
  const bed = bedSixteenths(track);
  for (const at of index.overlapping(track.outline.bounds)) {
    const cell = index.cells[at];
    if (!cell?.road || cell.topSixteenths !== bed) continue;
    if (track.outline.overlaps(PlacedOutline.ofRect(cell.square))) covered.push(at);
  }
  return covered;
}

function components(
  members: ReadonlySet<number>,
  index: SurfaceIndex,
): ReadonlyArray<ReadonlyArray<number>> {
  const seen = new Set<number>();
  const groups: number[][] = [];
  for (const start of [...members].toSorted((a, b) => a - b)) {
    if (seen.has(start)) continue;
    const group: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const at = stack.pop();
      if (at === undefined) break;
      group.push(at);
      const square = index.cells[at]?.square;
      if (!square) continue;
      for (const next of index.overlapping(touchingReach(square))) {
        const other = index.cells[next]?.square;
        if (!members.has(next) || seen.has(next) || !other || !shareAnEdge(square, other)) continue;
        seen.add(next);
        stack.push(next);
      }
    }
    groups.push(group.toSorted((a, b) => a - b));
  }
  return groups;
}

function highSide(rot: Rot90, facts: CrossingRamp): readonly [number, number] {
  const unit = facts.rise.axis === "x" ? [facts.rise.toward, 0] : [0, facts.rise.toward];
  return rotated(rot, unit[0] ?? 0, unit[1] ?? 0);
}

function candidatesAlong(track: number, edge: AxisEdge, part: RampPart, rot: Rot90): Candidate[] {
  const [riseX, riseZ] = highSide(rot, part.facts);
  const normal = edge.axis === "x" ? [edge.inside, 0] : [0, edge.inside];
  if (riseX !== normal[0] || riseZ !== normal[1]) return [];
  const box = rotatedBox(rot, part.facts.footprint);
  const [firstStud] = part.facts.antiStuds;
  if (!firstStud) return [];
  const [studX, studZ] = rotated(rot, firstStud[0], firstStud[1]);
  const phaseX = latticePhase(studX);
  const phaseZ = latticePhase(studZ);
  const out: Candidate[] = [];
  if (edge.axis === "x") {
    const highRel = riseX > 0 ? box.maxX : box.minX;
    const x = edge.at - highRel;
    if (!Number.isInteger(x) || !onPhase(x, phaseX)) return [];
    const highX = x + highRel;
    const first = Math.ceil((edge.from - box.maxZ - phaseZ) / STUD_LDU) * STUD_LDU + phaseZ;
    for (let z = first; z + box.minZ < edge.to; z += STUD_LDU) {
      const rect = shifted(box, x, z);
      out.push({
        track,
        part,
        x,
        z,
        rot,
        rect,
        high: [
          [highX, rect.minZ],
          [highX, rect.maxZ],
        ],
      });
    }
    return out;
  }
  const highRel = riseZ > 0 ? box.maxZ : box.minZ;
  const z = edge.at - highRel;
  if (!Number.isInteger(z) || !onPhase(z, phaseZ)) return [];
  const highZ = z + highRel;
  const first = Math.ceil((edge.from - box.maxX - phaseX) / STUD_LDU) * STUD_LDU + phaseX;
  for (let x = first; x + box.minX < edge.to; x += STUD_LDU) {
    const rect = shifted(box, x, z);
    out.push({
      track,
      part,
      x,
      z,
      rot,
      rect,
      high: [
        [rect.minX, highZ],
        [rect.maxX, highZ],
      ],
    });
  }
  return out;
}

function roadwayUnder(rect: LduRect, roadway: SurfaceIndex): number {
  return roadway.countOverlapping(rect);
}

function worldAntiStuds(candidate: Candidate): ReadonlyArray<readonly [number, number]> {
  return candidate.part.facts.antiStuds.map(([ax, az]) => {
    const [dx, dz] = rotated(candidate.rot, ax, az);
    return [candidate.x + dx, candidate.z + dz] as const;
  });
}

function rampCandidates(
  candidates: ReadonlyArray<Candidate>,
  tracks: ReadonlyArray<CrossingTrack>,
  roadway: SurfaceIndex,
): RampCandidate[] {
  const seen = new Set<string>();
  const valid: RampCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.part.facts.part}|${candidate.x}|${candidate.z}|${candidate.rot}`;
    if (seen.has(key)) continue;
    const roadwayCovered = roadwayUnder(candidate.rect, roadway);
    if (roadwayCovered === 0) continue;
    const track = tracks[candidate.track];
    if (!track?.outline.runsAlong(candidate.high[0], candidate.high[1])) continue;
    seen.add(key);
    const outline = PlacedOutline.onLattice(
      candidate.part.outline,
      candidate.x,
      candidate.z,
      candidate.rot,
    );
    if (tracks.some((other) => other.outline.overlaps(outline))) continue;
    valid.push({
      part: candidate.part.facts.part,
      x: candidate.x,
      y: track.bedLdu - candidate.part.facts.undersideY,
      z: candidate.z,
      rot: candidate.rot,
      rect: candidate.rect,
      undersideLdu: track.bedLdu,
      antiStuds: worldAntiStuds(candidate),
      roadwayCovered,
    });
  }
  return valid.toSorted((a, b) => b.roadwayCovered - a.roadwayCovered);
}

class RoadChunks {
  private readonly rects: ReadonlyArray<LduRect>;
  private readonly byChunk = new Map<number, Map<number, number[]>>();

  constructor(readonly roads: ReadonlyArray<RoadPlacement>) {
    this.rects = roads.map(placementRect);
    this.rects.forEach((rect, road) => {
      const [x0, x1] = chunkSpan(rect.minX, rect.maxX);
      const [z0, z1] = chunkSpan(rect.minZ, rect.maxZ);
      for (let cx = x0; cx <= x1; cx++) {
        let column = this.byChunk.get(cx);
        if (!column) {
          column = new Map();
          this.byChunk.set(cx, column);
        }
        for (let cz = z0; cz <= z1; cz++) {
          const bucket = column.get(cz);
          if (bucket) bucket.push(road);
          else column.set(cz, [road]);
        }
      }
    });
  }

  nearTracks(tracks: ReadonlyArray<CrossingTrack>): ReadonlyArray<RoadPlacement> {
    if (tracks.length === 0) return [];
    const near = new Uint8Array(this.roads.length);
    for (const track of tracks) {
      const reach = grown(track.outline.bounds);
      const [x0, x1] = chunkSpan(reach.minX, reach.maxX);
      const [z0, z1] = chunkSpan(reach.minZ, reach.maxZ);
      for (let cx = x0; cx <= x1; cx++) {
        const column = this.byChunk.get(cx);
        for (let cz = z0; cz <= z1; cz++) {
          for (const road of column?.get(cz) ?? []) {
            const rect = this.rects[road];
            if (rect && rectsMeet(rect, reach)) near[road] = 1;
          }
        }
      }
    }
    return this.roads.filter((_, road) => near[road] === 1);
  }
}

function recordsNear(
  chunks: RoadChunks,
  tracks: ReadonlyArray<CrossingTrack>,
  rampParts: ReadonlyArray<RampPart>,
): CrossingRecord[] {
  const near = chunks.nearTracks(tracks);
  if (near.length === 0) return [];
  return crossingsOver(near, tracks, rampParts, everyIndex(tracks.length), null);
}

export class RoadSurfaceCells {
  private readonly chunks: RoadChunks;

  constructor(roads: ReadonlyArray<RoadPlacement>) {
    this.chunks = new RoadChunks(roads);
  }

  get empty(): boolean {
    return this.chunks.roads.length === 0;
  }

  crossings(
    tracks: ReadonlyArray<CrossingTrack>,
    rampParts: ReadonlyArray<RampPart>,
  ): ReadonlyArray<LevelCrossing> {
    return recordsNear(this.chunks, tracks, rampParts).map((record) => record.crossing);
  }
}

export function levelCrossings(
  roads: ReadonlyArray<RoadPlacement>,
  tracks: ReadonlyArray<CrossingTrack>,
  rampParts: ReadonlyArray<RampPart>,
): ReadonlyArray<LevelCrossing> {
  return new RoadSurfaceCells(roads).crossings(tracks, rampParts);
}

interface CrossingRecord {
  readonly crossing: LevelCrossing;
  readonly anchor: RoadPlacement;
  readonly anchorCell: number;
  readonly cells: ReadonlyArray<readonly [RoadPlacement, Int32Array]>;
  readonly cellBounds: LduRect;
}

type IsDirtyCell = (road: RoadPlacement, cell: number, coverers: ReadonlySet<number>) => boolean;

function everyIndex(count: number): ReadonlyArray<number> {
  return Array.from({ length: count }, (_, index) => index);
}

function crossingsOver(
  near: ReadonlyArray<RoadPlacement>,
  tracks: ReadonlyArray<CrossingTrack>,
  rampParts: ReadonlyArray<RampPart>,
  coverers: ReadonlyArray<number>,
  isDirty: IsDirtyCell | null,
): CrossingRecord[] {
  const surfaces = surfaceIndex(near);
  const coveredBy = new Map<number, Set<number>>();
  for (const trackIndex of coverers) {
    const track = tracks[trackIndex];
    if (!track) continue;
    for (const at of coveredRoadway(track, surfaces)) {
      const set = coveredBy.get(at) ?? new Set<number>();
      set.add(trackIndex);
      coveredBy.set(at, set);
    }
  }
  const grouped = new Set<number>();
  for (const [at, by] of coveredBy) {
    if (!isDirty || cellIsDirty(at, by, surfaces, near, isDirty)) grouped.add(at);
  }
  return components(grouped, surfaces).map((group) => {
    const members = new Set<number>();
    const roadIds = new Set<number>();
    for (const at of group) {
      for (const track of coveredBy.get(at) ?? []) members.add(track);
      const placement = surfaces.cells[at]?.placement;
      if (placement !== undefined) roadIds.add(placement);
    }
    const trackList = [...members].toSorted((a, b) => a - b);
    const bed = surfaces.cells[group[0] ?? 0]?.topSixteenths;
    const roadway = new SurfaceIndex();
    const ranges = [...roadIds]
      .map((id) => surfaces.cellsOf.get(id) ?? ([0, 0] as const))
      .toSorted((a, b) => a[0] - b[0]);
    for (const [from, to] of ranges) {
      for (let at = from; at < to; at++) {
        const cell = surfaces.cells[at];
        if (cell?.road && cell.topSixteenths === bed) roadway.add(cell);
      }
    }
    const candidates: Candidate[] = [];
    for (const index of trackList) {
      const track = tracks[index];
      if (!track) continue;
      const edges = track.outline.axisEdges();
      for (const part of rampParts) {
        if (part.facts.highEdgeLdu !== track.railTopLdu) continue;
        for (const rot of ROTATIONS) {
          for (const edge of edges) {
            candidates.push(...candidatesAlong(index, edge, part, rot));
          }
        }
      }
    }
    const crossing: LevelCrossing = {
      tracks: trackList,
      roads: [...roadIds].toSorted((a, b) => a - b),
      roadwayCells: group.length,
      candidates: rampCandidates(candidates, tracks, roadway),
    };
    return recordOf(crossing, group, surfaces, near);
  });
}

function cellIsDirty(
  at: number,
  coverers: ReadonlySet<number>,
  surfaces: SurfaceIndex,
  near: ReadonlyArray<RoadPlacement>,
  isDirty: IsDirtyCell,
): boolean {
  const nearIndex = surfaces.cells[at]?.nearIndex ?? 0;
  const road = near[nearIndex];
  return road !== undefined && isDirty(road, at - (surfaces.firstCellOf[nearIndex] ?? 0), coverers);
}

function recordOf(
  crossing: LevelCrossing,
  group: ReadonlyArray<number>,
  surfaces: SurfaceIndex,
  near: ReadonlyArray<RoadPlacement>,
): CrossingRecord {
  const byNearIndex = new Map<number, number[]>();
  let bounds: LduRect | null = null;
  for (const at of group) {
    const cell = surfaces.cells[at];
    if (!cell) continue;
    const offsets = byNearIndex.get(cell.nearIndex) ?? [];
    offsets.push(at - (surfaces.firstCellOf[cell.nearIndex] ?? 0));
    byNearIndex.set(cell.nearIndex, offsets);
    bounds = bounds ? unionBounds(bounds, cell.square) : cell.square;
  }
  const first = surfaces.cells[group[0] ?? 0];
  const anchor = near[first?.nearIndex ?? 0];
  if (!first || !anchor || !bounds) throw new Error("a crossing has no cells");
  return {
    crossing,
    anchor,
    anchorCell: (group[0] ?? 0) - (surfaces.firstCellOf[first.nearIndex] ?? 0),
    cells: [...byNearIndex].map(([nearIndex, offsets]) => [
      near[nearIndex] ?? anchor,
      Int32Array.from(offsets),
    ]),
    cellBounds: bounds,
  };
}

interface RoadChange {
  readonly removed: ReadonlyArray<RoadPlacement>;
  readonly added: ReadonlyArray<RoadPlacement>;
}

interface TrackChange {
  readonly changed: ReadonlyArray<CrossingTrack>;
  readonly newIndexOf: Int32Array;
  readonly addedAt: Uint8Array;
}

const NOT_KEPT = -1;

function roadChange(
  before: ReadonlyArray<RoadPlacement>,
  after: ReadonlyArray<RoadPlacement>,
): RoadChange | null {
  const indexBefore = new Map<RoadPlacement, number>();
  before.forEach((road, index) => indexBefore.set(road, index));
  const kept = new Set(after);
  if (indexBefore.size !== before.length || kept.size !== after.length) return null;
  const added: RoadPlacement[] = [];
  let last = NOT_KEPT;
  for (const road of after) {
    const index = indexBefore.get(road);
    if (index === undefined) added.push(road);
    else if (index < last) return null;
    else last = index;
  }
  return { removed: before.filter((road) => !kept.has(road)), added };
}

function occurrences(tracks: ReadonlyArray<CrossingTrack>): Map<CrossingTrack, number> {
  const counts = new Map<CrossingTrack, number>();
  for (const track of tracks) counts.set(track, (counts.get(track) ?? 0) + 1);
  return counts;
}

function trackChange(
  before: ReadonlyArray<CrossingTrack>,
  after: ReadonlyArray<CrossingTrack>,
): TrackChange | null {
  const countBefore = occurrences(before);
  const countAfter = occurrences(after);
  const keptOnce = (track: CrossingTrack): boolean =>
    countBefore.get(track) === 1 && countAfter.get(track) === 1;
  const indexBefore = new Map<CrossingTrack, number>();
  before.forEach((track, index) => {
    if (keptOnce(track)) indexBefore.set(track, index);
  });
  const newIndexOf = new Int32Array(before.length).fill(NOT_KEPT);
  const addedAt = new Uint8Array(after.length);
  const changed = before.filter((track) => !keptOnce(track));
  let last = NOT_KEPT;
  for (let index = 0; index < after.length; index++) {
    const track = after[index];
    if (!track) continue;
    const old = indexBefore.get(track);
    if (old === undefined) {
      changed.push(track);
      addedAt[index] = 1;
      continue;
    }
    if (old < last) return null;
    last = old;
    newIndexOf[old] = index;
  }
  return { changed, newIndexOf, addedAt };
}

function relabelled(crossing: LevelCrossing, newIndexOf: Int32Array): LevelCrossing | null {
  let moved = false;
  const tracks: number[] = [];
  for (const old of crossing.tracks) {
    const index = newIndexOf[old] ?? NOT_KEPT;
    if (index === NOT_KEPT) return null;
    if (index !== old) moved = true;
    tracks.push(index);
  }
  return moved ? { ...crossing, tracks } : crossing;
}

function unionBounds(a: LduRect, b: LduRect): LduRect {
  return {
    minX: Math.min(a.minX, b.minX),
    minZ: Math.min(a.minZ, b.minZ),
    maxX: Math.max(a.maxX, b.maxX),
    maxZ: Math.max(a.maxZ, b.maxZ),
  };
}

function sharesAnId(roads: ReadonlyArray<RoadPlacement>): boolean {
  const ids = new Set<number>();
  for (const road of roads) {
    if (ids.has(road.id)) return true;
    ids.add(road.id);
  }
  return false;
}

function grownByCell(rect: LduRect): LduRect {
  return {
    minX: rect.minX - STUD_LDU,
    minZ: rect.minZ - STUD_LDU,
    maxX: rect.maxX + STUD_LDU,
    maxZ: rect.maxZ + STUD_LDU,
  };
}

function meetsRamps(bounds: LduRect, ramps: LduRect | null): boolean {
  return ramps !== null && rectsMeet(bounds, ramps);
}

function relabelledEntry(entry: KeptCrossing, newIndexOf: Int32Array): KeptCrossing | null {
  const crossing = relabelled(entry.record.crossing, newIndexOf);
  if (!crossing) return null;
  return crossing === entry.record.crossing
    ? entry
    : { ...entry, record: { ...entry.record, crossing } };
}

function isDirtyCellOf(
  addedRoads: ReadonlyArray<RoadPlacement>,
  addedAt: Uint8Array,
  dirty: ReadonlyArray<KeptCrossing>,
): IsDirtyCell {
  const added = new Set(addedRoads);
  const cells = new Map<RoadPlacement, Set<number>>();
  for (const entry of dirty) {
    for (const [road, offsets] of entry.record.cells) {
      const set = cells.get(road) ?? new Set<number>();
      for (const offset of offsets) set.add(offset);
      cells.set(road, set);
    }
  }
  return (road, cell, coverers) => {
    if (added.has(road) || cells.get(road)?.has(cell) === true) return true;
    for (const track of coverers) if (addedAt[track] === 1) return true;
    return false;
  };
}

interface KeptCrossing {
  readonly record: CrossingRecord;
  readonly rampOutlineBounds: LduRect | null;
}

export class LevelCrossings {
  private roads: ReadonlyArray<RoadPlacement> = [];
  private tracks: ReadonlyArray<CrossingTrack> = [];
  private kept: ReadonlyArray<KeptCrossing> = [];
  private found: ReadonlyArray<LevelCrossing> = [];
  private readonly roadRects = new WeakMap<RoadPlacement, LduRect>();
  private readonly trackRampOutlineBounds = new WeakMap<CrossingTrack, LduRect | null>();

  constructor(private readonly rampParts: ReadonlyArray<RampPart>) {}

  crossings(
    roads: ReadonlyArray<RoadPlacement>,
    tracks: ReadonlyArray<CrossingTrack>,
  ): ReadonlyArray<LevelCrossing> {
    const kept = this.update(roads, tracks) ?? this.recomputed(roads, tracks);
    if (kept !== this.kept) {
      this.kept = kept;
      this.found = kept.map((entry) => entry.record.crossing);
    }
    this.roads = roads;
    this.tracks = tracks;
    return this.found;
  }

  private recomputed(
    roads: ReadonlyArray<RoadPlacement>,
    tracks: ReadonlyArray<CrossingTrack>,
  ): ReadonlyArray<KeptCrossing> {
    return recordsNear(new RoadChunks(roads), tracks, this.rampParts).map((record) =>
      this.keep(record, tracks),
    );
  }

  private keep(record: CrossingRecord, tracks: ReadonlyArray<CrossingTrack>): KeptCrossing {
    return { record, rampOutlineBounds: this.outlineBoundsOf(record.crossing, tracks) };
  }

  private update(
    roads: ReadonlyArray<RoadPlacement>,
    tracks: ReadonlyArray<CrossingTrack>,
  ): ReadonlyArray<KeptCrossing> | null {
    if (this.roads.length === 0 || this.tracks.length === 0) return null;
    const roadsMoved = roadChange(this.roads, roads);
    const tracksMoved = trackChange(this.tracks, tracks);
    if (!roadsMoved || !tracksMoved) return null;
    if (this.untouched(tracks, roadsMoved, tracksMoved)) {
      return this.relabelledAll(tracksMoved.newIndexOf);
    }
    if (sharesAnId(roads)) return null;
    return this.rebuiltAround(roads, tracks, roadsMoved, tracksMoved);
  }

  private untouched(
    tracks: ReadonlyArray<CrossingTrack>,
    roadsMoved: RoadChange,
    tracksMoved: TrackChange,
  ): boolean {
    if (roadsMoved.removed.some((road) => this.meetsTrack(road, this.tracks))) return false;
    if (roadsMoved.added.some((road) => this.meetsTrack(road, tracks))) return false;
    for (const track of tracksMoved.changed) {
      if (this.meetsRoad(track, this.roads)) return false;
      const bounds = track.outline.bounds;
      if (this.kept.some((entry) => meetsRamps(bounds, entry.rampOutlineBounds))) return false;
    }
    return true;
  }

  private relabelledAll(newIndexOf: Int32Array): ReadonlyArray<KeptCrossing> | null {
    const kept: KeptCrossing[] = [];
    let moved = false;
    for (const entry of this.kept) {
      const relabel = relabelledEntry(entry, newIndexOf);
      if (!relabel) return null;
      if (relabel !== entry) moved = true;
      kept.push(relabel);
    }
    return moved ? kept : this.kept;
  }

  private rebuiltAround(
    roads: ReadonlyArray<RoadPlacement>,
    tracks: ReadonlyArray<CrossingTrack>,
    roadsMoved: RoadChange,
    tracksMoved: TrackChange,
  ): ReadonlyArray<KeptCrossing> | null {
    const changedRoads = [...roadsMoved.removed, ...roadsMoved.added];
    const changedTracks = tracksMoved.changed;
    const clean: KeptCrossing[] = [];
    const dirty: KeptCrossing[] = [];
    let moved = false;
    for (const entry of this.kept) {
      if (this.isDirty(entry, changedRoads, changedTracks)) {
        dirty.push(entry);
        moved = true;
        continue;
      }
      const relabel = relabelledEntry(entry, tracksMoved.newIndexOf);
      if (!relabel) return null;
      if (relabel !== entry) moved = true;
      clean.push(relabel);
    }
    const coverers = this.localCoverers(tracks, roadsMoved.added, tracksMoved, dirty);
    const local =
      coverers.length === 0
        ? []
        : crossingsOver(
            this.localRoads(roads, tracks, coverers),
            tracks,
            this.rampParts,
            coverers,
            isDirtyCellOf(roadsMoved.added, tracksMoved.addedAt, dirty),
          );
    if (!moved && local.length === 0) return this.kept;
    const rank = new Map<RoadPlacement, number>();
    roads.forEach((road, index) => rank.set(road, index));
    return [...clean, ...local.map((record) => this.keep(record, tracks))].toSorted(
      (a, b) =>
        (rank.get(a.record.anchor) ?? 0) - (rank.get(b.record.anchor) ?? 0) ||
        a.record.anchorCell - b.record.anchorCell,
    );
  }

  private isDirty(
    entry: KeptCrossing,
    changedRoads: ReadonlyArray<RoadPlacement>,
    changedTracks: ReadonlyArray<CrossingTrack>,
  ): boolean {
    const cells = entry.record.cellBounds;
    if (changedRoads.some((road) => rectsMeet(this.rectOf(road), cells))) return true;
    return changedTracks.some((track) => {
      const bounds = track.outline.bounds;
      return rectsMeet(grownByCell(bounds), cells) || meetsRamps(bounds, entry.rampOutlineBounds);
    });
  }

  private localCoverers(
    tracks: ReadonlyArray<CrossingTrack>,
    addedRoads: ReadonlyArray<RoadPlacement>,
    tracksMoved: TrackChange,
    dirty: ReadonlyArray<KeptCrossing>,
  ): ReadonlyArray<number> {
    const coverers = new Set<number>();
    for (const entry of dirty) {
      for (const old of entry.record.crossing.tracks) {
        const index = tracksMoved.newIndexOf[old] ?? NOT_KEPT;
        if (index !== NOT_KEPT) coverers.add(index);
      }
    }
    tracks.forEach((track, index) => {
      const reach = grown(track.outline.bounds);
      if (tracksMoved.addedAt[index] === 1) coverers.add(index);
      else if (addedRoads.some((road) => rectsMeet(this.rectOf(road), reach))) coverers.add(index);
    });
    return [...coverers].toSorted((a, b) => a - b);
  }

  private localRoads(
    roads: ReadonlyArray<RoadPlacement>,
    tracks: ReadonlyArray<CrossingTrack>,
    coverers: ReadonlyArray<number>,
  ): ReadonlyArray<RoadPlacement> {
    const reaches: LduRect[] = [];
    for (const index of coverers) {
      const track = tracks[index];
      if (track) reaches.push(grown(track.outline.bounds));
    }
    return roads.filter((road) => {
      const rect = this.rectOf(road);
      return reaches.some((reach) => rectsMeet(rect, reach));
    });
  }

  private meetsTrack(road: RoadPlacement, tracks: ReadonlyArray<CrossingTrack>): boolean {
    const rect = this.rectOf(road);
    return tracks.some((track) => rectsMeet(rect, grown(track.outline.bounds)));
  }

  private meetsRoad(track: CrossingTrack, roads: ReadonlyArray<RoadPlacement>): boolean {
    const reach = grown(track.outline.bounds);
    return roads.some((road) => rectsMeet(this.rectOf(road), reach));
  }

  private rectOf(road: RoadPlacement): LduRect {
    let rect = this.roadRects.get(road);
    if (!rect) {
      rect = placementRect(road);
      this.roadRects.set(road, rect);
    }
    return rect;
  }

  private outlineBoundsOf(
    crossing: LevelCrossing,
    tracks: ReadonlyArray<CrossingTrack>,
  ): LduRect | null {
    let bounds: LduRect | null = null;
    for (const index of crossing.tracks) {
      const track = tracks[index];
      const own = track ? this.rampOutlineBoundsOf(track) : null;
      if (own) bounds = bounds ? unionBounds(bounds, own) : own;
    }
    return bounds;
  }

  private rampOutlineBoundsOf(track: CrossingTrack): LduRect | null {
    const known = this.trackRampOutlineBounds.get(track);
    if (known !== undefined) return known;
    const seen = new Set<string>();
    let bounds: LduRect | null = null;
    const edges = track.outline.axisEdges();
    for (const part of this.rampParts) {
      if (part.facts.highEdgeLdu !== track.railTopLdu) continue;
      for (const rot of ROTATIONS) {
        for (const edge of edges) {
          for (const candidate of candidatesAlong(0, edge, part, rot)) {
            const key = `${part.facts.part}|${candidate.x}|${candidate.z}|${rot}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const outline = PlacedOutline.onLattice(part.outline, candidate.x, candidate.z, rot);
            bounds = bounds ? unionBounds(bounds, outline.bounds) : outline.bounds;
          }
        }
      }
    }
    this.trackRampOutlineBounds.set(track, bounds);
    return bounds;
  }
}

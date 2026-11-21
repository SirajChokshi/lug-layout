import { STUD_LDU, isRot90, rot90Cos, rot90Sin, type Rot90 } from "@brr/math";
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
  readonly top: number;
  readonly road: boolean;
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

function cellOfKey(key: number): readonly [number, number] {
  return [
    Math.floor(key / CELL_KEY_SPAN) - CELL_KEY_SPAN / 2,
    (key % CELL_KEY_SPAN) - CELL_KEY_SPAN / 2,
  ];
}

function cellRect(cellX: number, cellZ: number): LduRect {
  return {
    minX: cellX * STUD_LDU,
    minZ: cellZ * STUD_LDU,
    maxX: (cellX + 1) * STUD_LDU,
    maxZ: (cellZ + 1) * STUD_LDU,
  };
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

function cellsUnder(rect: LduRect): Array<readonly [number, number]> {
  const cells: Array<readonly [number, number]> = [];
  for (let x = Math.floor(rect.minX / STUD_LDU); x < Math.ceil(rect.maxX / STUD_LDU); x++) {
    for (let z = Math.floor(rect.minZ / STUD_LDU); z < Math.ceil(rect.maxZ / STUD_LDU); z++) {
      cells.push([x, z]);
    }
  }
  return cells;
}

function surfaceCells(roads: ReadonlyArray<RoadPlacement>): ReadonlyMap<number, SurfaceCell> {
  const cells = new Map<number, SurfaceCell>();
  for (const road of roads) {
    for (const cell of placedCells(road)) {
      const key = cellKey(cell.cellX, cell.cellZ);
      const existing = cells.get(key);
      if (existing && existing.top >= cell.top) continue;
      cells.set(key, { placement: cell.placement, top: cell.top, road: cell.road === 1 });
    }
  }
  return cells;
}

function coveredRoadway(
  track: CrossingTrack,
  cells: ReadonlyMap<number, SurfaceCell>,
): ReadonlyArray<number> {
  const covered: number[] = [];
  for (const [x, z] of cellsUnder(track.outline.bounds)) {
    const key = cellKey(x, z);
    const cell = cells.get(key);
    if (!cell?.road || cell.top !== track.bedLdu) continue;
    if (track.outline.overlaps(PlacedOutline.ofRect(cellRect(x, z)))) covered.push(key);
  }
  return covered;
}

function components(keys: ReadonlySet<number>): ReadonlyArray<ReadonlyArray<number>> {
  const seen = new Set<number>();
  const groups: number[][] = [];
  for (const start of [...keys].toSorted((a, b) => a - b)) {
    if (seen.has(start)) continue;
    const group: number[] = [];
    const stack = [start];
    seen.add(start);
    while (stack.length > 0) {
      const key = stack.pop();
      if (key === undefined) break;
      group.push(key);
      const [x, z] = cellOfKey(key);
      for (const [dx, dz] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const next = cellKey(x + dx, z + dz);
        if (keys.has(next) && !seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
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

function roadwayUnder(rect: LduRect, roadway: ReadonlySet<number>): number {
  let count = 0;
  for (const [x, z] of cellsUnder(rect)) if (roadway.has(cellKey(x, z))) count++;
  return count;
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
  roadway: ReadonlySet<number>,
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

interface CellRange {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

function placedCellRange(placement: RoadPlacement): CellRange | null {
  const { surface, rot } = placement;
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  if (surface.rows === 0 || surface.columns === 0) return null;
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const row of [0, surface.rows - 1]) {
    for (const column of [0, surface.columns - 1]) {
      const localX = surface.minX + column * STUD_LDU + HALF_STUD_LDU;
      const localZ = surface.minZ + row * STUD_LDU + HALF_STUD_LDU;
      const cellX = Math.floor((placement.x + cos * localX + sin * localZ) / STUD_LDU);
      const cellZ = Math.floor((placement.z - sin * localX + cos * localZ) / STUD_LDU);
      minX = Math.min(minX, cellX);
      maxX = Math.max(maxX, cellX);
      minZ = Math.min(minZ, cellZ);
      maxZ = Math.max(maxZ, cellZ);
    }
  }
  return { minX, maxX, minZ, maxZ };
}

export class RoadSurfaceCells {
  private built: ReadonlyMap<number, SurfaceCell> | null = null;
  private readonly ranges: ReadonlyArray<CellRange>;

  constructor(private readonly roads: ReadonlyArray<RoadPlacement>) {
    this.ranges = roads.flatMap((road) => placedCellRange(road) ?? []);
  }

  get empty(): boolean {
    return this.roads.length === 0;
  }

  private underRoad(track: CrossingTrack): boolean {
    const { bounds } = track.outline;
    const minX = Math.floor(bounds.minX / STUD_LDU);
    const maxX = Math.ceil(bounds.maxX / STUD_LDU) - 1;
    const minZ = Math.floor(bounds.minZ / STUD_LDU);
    const maxZ = Math.ceil(bounds.maxZ / STUD_LDU) - 1;
    return this.ranges.some(
      (range) =>
        minX <= range.maxX && range.minX <= maxX && minZ <= range.maxZ && range.minZ <= maxZ,
    );
  }

  crossings(
    tracks: ReadonlyArray<CrossingTrack>,
    rampParts: ReadonlyArray<RampPart>,
  ): ReadonlyArray<LevelCrossing> {
    if (!tracks.some((track) => this.underRoad(track))) return [];
    this.built ??= surfaceCells(this.roads);
    const cells = this.built;
    const coveredBy = new Map<number, Set<number>>();
    tracks.forEach((track, index) => {
      for (const key of coveredRoadway(track, cells)) {
        const set = coveredBy.get(key) ?? new Set<number>();
        set.add(index);
        coveredBy.set(key, set);
      }
    });
    return components(new Set(coveredBy.keys())).map((group) => {
      const members = new Set<number>();
      const roadIds = new Set<number>();
      for (const key of group) {
        for (const track of coveredBy.get(key) ?? []) members.add(track);
        const placement = cells.get(key)?.placement;
        if (placement !== undefined) roadIds.add(placement);
      }
      const trackList = [...members].toSorted((a, b) => a - b);
      const bed = cells.get(group[0] ?? 0)?.top;
      const roadway = new Set<number>();
      for (const [key, cell] of cells) {
        if (cell.road && cell.top === bed && roadIds.has(cell.placement)) roadway.add(key);
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
      return {
        tracks: trackList,
        roads: [...roadIds].toSorted((a, b) => a - b),
        roadwayCells: group.length,
        candidates: rampCandidates(candidates, tracks, roadway),
      };
    });
  }
}

export function levelCrossings(
  roads: ReadonlyArray<RoadPlacement>,
  tracks: ReadonlyArray<CrossingTrack>,
  rampParts: ReadonlyArray<RampPart>,
): ReadonlyArray<LevelCrossing> {
  return new RoadSurfaceCells(roads).crossings(tracks, rampParts);
}

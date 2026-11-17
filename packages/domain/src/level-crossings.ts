import { STUD_LDU, rot90Cos, rot90Sin, type Rot90 } from "@brr/math";
import type { LevelCrossingRecipe } from "@brr/schema/bundle";
import { rectsOverlap, type LduRect } from "./plan/plan-region.ts";
import { placedCells, type RoadPlacement } from "./road-joins.ts";

export type TrackAxis = "x" | "z";

export interface TrackLine {
  readonly axis: TrackAxis;
  readonly across: number;
  readonly from: number;
  readonly to: number;
}

export interface CrossingTrackPiece {
  readonly index: number;
  readonly bedLdu: number;
  readonly straight: boolean;
  readonly line: TrackLine | null;
  readonly box: LduRect;
}

export type TrackMeetsRect = (track: number, rect: LduRect) => boolean;

export type CrossingConflict =
  | "raised-road"
  | "not-straight"
  | "off-lattice"
  | "along-road"
  | "not-straight-road"
  | "narrow-roadway"
  | "roadway-off-grid"
  | "ramps-off-road"
  | "ramps-hit-track"
  | "ramps-overlap";

export interface CrossingConflictReport {
  readonly track: number;
  readonly road: number;
  readonly reason: CrossingConflict;
}

export interface PlacedCrossingSlope {
  readonly rot: Rot90;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly footprint: LduRect;
}

export interface LevelCrossing {
  readonly roads: ReadonlyArray<number>;
  readonly axis: TrackAxis;
  readonly centreX: number;
  readonly centreZ: number;
  readonly bedLdu: number;
  readonly tracks: ReadonlyArray<number>;
  readonly slopes: ReadonlyArray<PlacedCrossingSlope>;
}

export interface CrossingPlan {
  readonly crossings: ReadonlyArray<LevelCrossing>;
  readonly conflicts: ReadonlyArray<CrossingConflictReport>;
}

interface RoadCell {
  readonly top: number;
  readonly road: boolean;
}

interface RoadArea {
  readonly id: number;
  readonly rect: LduRect;
  readonly cells: ReadonlyMap<number, RoadCell>;
  readonly axis: TrackAxis | null;
  readonly band: { readonly min: number; readonly max: number } | null;
}

interface Candidate {
  readonly areas: RoadArea[];
  readonly band: RoadArea["band"];
  readonly axis: TrackAxis;
  readonly across: number;
  readonly bedLdu: number;
  readonly tracks: number[];
}

const CELL_KEY_SPAN = 2 ** 26;
const AXIS_FRAME: Readonly<Record<TrackAxis, Rot90>> = { x: 0, z: 3 };

function cellKey(cellX: number, cellZ: number): number {
  return cellX * CELL_KEY_SPAN + cellZ;
}

function cellRect(cellX: number, cellZ: number): LduRect {
  return {
    minX: cellX * STUD_LDU,
    maxX: (cellX + 1) * STUD_LDU,
    minZ: cellZ * STUD_LDU,
    maxZ: (cellZ + 1) * STUD_LDU,
  };
}

function roadArea(placement: RoadPlacement): RoadArea {
  const cells = new Map<number, RoadCell>();
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  const placed = placedCells(placement);
  for (const cell of placed) {
    cells.set(cellKey(cell.cellX, cell.cellZ), { top: cell.top, road: cell.road === 1 });
    minX = Math.min(minX, cell.cellX);
    maxX = Math.max(maxX, cell.cellX);
    minZ = Math.min(minZ, cell.cellZ);
    maxZ = Math.max(maxZ, cell.cellZ);
  }
  const roadOn = (test: (cellX: number, cellZ: number) => boolean) =>
    placed.filter((cell) => cell.road === 1 && test(cell.cellX, cell.cellZ));
  const arms = {
    minX: roadOn((x) => x === minX),
    maxX: roadOn((x) => x === maxX),
    minZ: roadOn((_x, z) => z === minZ),
    maxZ: roadOn((_x, z) => z === maxZ),
  };
  const alongX = arms.minX.length > 0 && arms.maxX.length > 0;
  const alongZ = arms.minZ.length > 0 && arms.maxZ.length > 0;
  const crossArms =
    (arms.minZ.length > 0 || arms.maxZ.length > 0) &&
    (arms.minX.length > 0 || arms.maxX.length > 0);
  const axis: TrackAxis | null = crossArms ? null : alongX ? "x" : alongZ ? "z" : null;
  const edge = axis === "x" ? arms.minX.map((c) => c.cellZ) : arms.minZ.map((c) => c.cellX);
  const band =
    axis === null || edge.length === 0
      ? null
      : { min: Math.min(...edge) * STUD_LDU, max: (Math.max(...edge) + 1) * STUD_LDU };
  return {
    id: placement.id,
    rect: {
      minX: minX * STUD_LDU,
      maxX: (maxX + 1) * STUD_LDU,
      minZ: minZ * STUD_LDU,
      maxZ: (maxZ + 1) * STUD_LDU,
    },
    cells,
    axis,
    band,
  };
}

function lineRect(line: TrackLine, halfWidth: number): LduRect {
  return line.axis === "x"
    ? {
        minX: line.from,
        maxX: line.to,
        minZ: line.across - halfWidth,
        maxZ: line.across + halfWidth,
      }
    : {
        minX: line.across - halfWidth,
        maxX: line.across + halfWidth,
        minZ: line.from,
        maxZ: line.to,
      };
}

function cellsUnder(rect: LduRect): Array<readonly [number, number]> {
  const cells: Array<readonly [number, number]> = [];
  const fromX = Math.floor(rect.minX / STUD_LDU);
  const toX = Math.ceil(rect.maxX / STUD_LDU);
  const fromZ = Math.floor(rect.minZ / STUD_LDU);
  const toZ = Math.ceil(rect.maxZ / STUD_LDU);
  for (let x = fromX; x < toX; x++) {
    for (let z = fromZ; z < toZ; z++) cells.push([x, z]);
  }
  return cells;
}

function intersection(a: LduRect, b: LduRect): LduRect | null {
  const rect = {
    minX: Math.max(a.minX, b.minX),
    maxX: Math.min(a.maxX, b.maxX),
    minZ: Math.max(a.minZ, b.minZ),
    maxZ: Math.min(a.maxZ, b.maxZ),
  };
  return rect.minX < rect.maxX && rect.minZ < rect.maxZ ? rect : null;
}

function rotated(rot: Rot90, x: number, z: number): readonly [number, number] {
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  return [cos * x + sin * z + 0, -sin * x + cos * z + 0];
}

function addRot(a: Rot90, b: Rot90): Rot90 {
  const sum = (a + b) % 4;
  return sum === 1 ? 1 : sum === 2 ? 2 : sum === 3 ? 3 : 0;
}

function placedSlopes(
  recipe: LevelCrossingRecipe,
  axis: TrackAxis,
  centreX: number,
  centreZ: number,
  bedLdu: number,
): ReadonlyArray<PlacedCrossingSlope> {
  const frame = AXIS_FRAME[axis];
  return recipe.slopes.map((slope) => {
    const [x, z] = rotated(frame, slope.offset[0], slope.offset[2]);
    const [ax, az] = rotated(frame, slope.footprint.minX, slope.footprint.minZ);
    const [bx, bz] = rotated(frame, slope.footprint.maxX, slope.footprint.maxZ);
    return {
      rot: addRot(frame, slope.rot),
      x: centreX + x,
      y: bedLdu + slope.offset[1],
      z: centreZ + z,
      footprint: {
        minX: centreX + Math.min(ax, bx),
        maxX: centreX + Math.max(ax, bx),
        minZ: centreZ + Math.min(az, bz),
        maxZ: centreZ + Math.max(az, bz),
      },
    };
  });
}

function crossingBand(recipe: LevelCrossingRecipe): number {
  const minX = Math.min(...recipe.slopes.map((slope) => slope.footprint.minX));
  const maxX = Math.max(...recipe.slopes.map((slope) => slope.footprint.maxX));
  return maxX - minX;
}

class Planner {
  private readonly conflicts: CrossingConflictReport[] = [];
  private readonly reported = new Set<string>();
  private readonly pieceRects = new Map<number, LduRect>();

  constructor(
    private readonly recipe: LevelCrossingRecipe,
    private readonly tracks: ReadonlyArray<CrossingTrackPiece>,
    private readonly meets: TrackMeetsRect,
  ) {
    for (const track of tracks) {
      if (track.line)
        this.pieceRects.set(track.index, lineRect(track.line, recipe.trackHalfWidthLdu));
    }
  }

  conflict(track: number, road: number, reason: CrossingConflict): void {
    const key = `${track}|${road}|${reason}`;
    if (this.reported.has(key)) return;
    this.reported.add(key);
    this.conflicts.push({ track, road, reason });
  }

  report(): ReadonlyArray<CrossingConflictReport> {
    return this.conflicts.toSorted((a, b) => a.track - b.track || a.road - b.road);
  }

  pieceMeets(track: CrossingTrackPiece, rect: LduRect): boolean {
    const exact = this.pieceRects.get(track.index);
    if (exact) return rectsOverlap(exact, rect);
    return rectsOverlap(track.box, rect) && this.meets(track.index, rect);
  }

  coveredCells(track: CrossingTrackPiece, area: RoadArea): ReadonlyArray<RoadCell> {
    const exact = this.pieceRects.get(track.index);
    const reach = intersection(exact ?? track.box, area.rect);
    if (!reach) return [];
    const covered: RoadCell[] = [];
    for (const [x, z] of cellsUnder(reach)) {
      const cell = area.cells.get(cellKey(x, z));
      if (cell && this.pieceMeets(track, cellRect(x, z))) covered.push(cell);
    }
    return covered;
  }

  hitsAnyTrack(rect: LduRect): ReadonlyArray<number> {
    return this.tracks.filter((track) => this.pieceMeets(track, rect)).map((track) => track.index);
  }
}

function slopesOnRoad(
  cells: ReadonlyMap<number, RoadCell>,
  slopes: ReadonlyArray<PlacedCrossingSlope>,
  bed: number,
): boolean {
  return slopes.every((slope) =>
    cellsUnder(slope.footprint).every(([x, z]) => {
      const cell = cells.get(cellKey(x, z));
      return cell !== undefined && cell.road && cell.top === bed;
    }),
  );
}

export function planLevelCrossings(
  recipe: LevelCrossingRecipe,
  roads: ReadonlyArray<RoadPlacement>,
  tracks: ReadonlyArray<CrossingTrackPiece>,
  meets: TrackMeetsRect,
): CrossingPlan {
  const areas = roads.map(roadArea);
  const allCells = new Map(areas.flatMap((area) => [...area.cells]));
  const planner = new Planner(recipe, tracks, meets);
  const candidates = new Map<string, Candidate>();
  for (const track of tracks) {
    for (const area of areas) {
      if (!rectsOverlap(track.box, area.rect)) continue;
      const covered = planner.coveredCells(track, area);
      if (covered.some((cell) => cell.top !== track.bedLdu)) {
        planner.conflict(track.index, area.id, "raised-road");
        continue;
      }
      if (!covered.some((cell) => cell.road)) continue;
      const { line } = track;
      if (!track.straight) planner.conflict(track.index, area.id, "not-straight");
      else if (!line) planner.conflict(track.index, area.id, "off-lattice");
      else if (area.axis === null) planner.conflict(track.index, area.id, "not-straight-road");
      else if (area.axis === line.axis) planner.conflict(track.index, area.id, "along-road");
      else {
        const band = area.band;
        const key = `${line.axis}|${line.across}|${track.bedLdu}|${band?.min}|${band?.max}`;
        const candidate = candidates.get(key) ?? {
          areas: [],
          band,
          axis: line.axis,
          across: line.across,
          bedLdu: track.bedLdu,
          tracks: [],
        };
        if (!candidate.areas.includes(area)) candidate.areas.push(area);
        if (!candidate.tracks.includes(track.index)) candidate.tracks.push(track.index);
        candidates.set(key, candidate);
      }
    }
  }
  const band = crossingBand(recipe);
  const placed: LevelCrossing[] = [];
  for (const candidate of candidates.values()) {
    const { areas: under, axis, across, bedLdu, tracks: members } = candidate;
    const roadIds = under.map((area) => area.id).toSorted((a, b) => a - b);
    const fail = (reason: CrossingConflict) => {
      for (const track of members)
        for (const road of roadIds) planner.conflict(track, road, reason);
    };
    const roadway = candidate.band;
    if (!roadway || roadway.max - roadway.min < band) {
      fail("narrow-roadway");
      continue;
    }
    const along = (roadway.min + roadway.max) / 2;
    if (!Number.isInteger(along / STUD_LDU)) {
      fail("roadway-off-grid");
      continue;
    }
    const centreX = axis === "x" ? along : across;
    const centreZ = axis === "x" ? across : along;
    const slopes = placedSlopes(recipe, axis, centreX, centreZ, bedLdu);
    if (!slopesOnRoad(allCells, slopes, bedLdu)) {
      fail("ramps-off-road");
      continue;
    }
    const hit = slopes.flatMap((slope) => planner.hitsAnyTrack(slope.footprint));
    if (hit.length > 0) {
      fail("ramps-hit-track");
      for (const track of hit) {
        for (const road of roadIds) planner.conflict(track, road, "ramps-hit-track");
      }
      continue;
    }
    placed.push({
      roads: roadIds,
      axis,
      centreX,
      centreZ,
      bedLdu,
      tracks: members.toSorted((a, b) => a - b),
      slopes,
    });
  }
  const overlapping = new Set<LevelCrossing>();
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const a = placed[i];
      const b = placed[j];
      if (!a || !b) continue;
      const clash = a.slopes.some((p) =>
        b.slopes.some((q) => rectsOverlap(p.footprint, q.footprint)),
      );
      if (!clash) continue;
      overlapping.add(a);
      overlapping.add(b);
    }
  }
  for (const crossing of overlapping) {
    for (const track of crossing.tracks) {
      for (const road of crossing.roads) planner.conflict(track, road, "ramps-overlap");
    }
  }
  return {
    crossings: placed
      .filter((crossing) => !overlapping.has(crossing))
      .toSorted((a, b) => a.centreX - b.centreX || a.centreZ - b.centreZ),
    conflicts: planner.report(),
  };
}

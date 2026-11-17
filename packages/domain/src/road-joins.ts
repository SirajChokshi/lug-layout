import { STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";

export const NO_STUD = -0x8000_0000;

export interface RoadSurface {
  readonly minX: number;
  readonly minZ: number;
  readonly columns: number;
  readonly rows: number;
  readonly top: Int32Array;
  readonly stud: Int32Array;
  readonly road: Uint8Array;
}

export interface RoadPlacement {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly yLdu: number;
  readonly rot: number;
  readonly surface: RoadSurface;
}

export type RoadSide = "minX" | "maxX" | "minZ" | "maxZ";
export type RoadCellStatus = "joined" | "open" | "mismatch";

export interface RoadEdgeSegment {
  readonly placement: number;
  readonly side: RoadSide;
  readonly line: number;
  readonly from: number;
  readonly to: number;
  readonly topLdu: number;
  readonly status: RoadCellStatus;
}

export interface RoadJoinReport {
  readonly placements: number;
  readonly joinedCells: number;
  readonly openCells: number;
  readonly mismatchedCells: number;
  readonly overlaps: ReadonlyArray<readonly [number, number]>;
  readonly segments: ReadonlyArray<RoadEdgeSegment>;
}

export interface RoadFit {
  readonly joinedCells: number;
  readonly joinedRoadCells: number;
  readonly mismatchedCells: number;
  readonly overlappingCells: number;
}

interface Cell {
  readonly placement: number;
  readonly top: number;
  readonly stud: number;
  readonly road: number;
}

interface PlacedCell extends Cell {
  readonly cellX: number;
  readonly cellZ: number;
}

const SIDES: ReadonlyArray<readonly [RoadSide, number, number]> = [
  ["minX", -1, 0],
  ["maxX", 1, 0],
  ["minZ", 0, -1],
  ["maxZ", 0, 1],
];
const HALF_STUD = STUD_LDU / 2;

class CellMap<T> {
  private readonly columns = new Map<number, Map<number, T>>();

  get(cellX: number, cellZ: number): T | undefined {
    return this.columns.get(cellX)?.get(cellZ);
  }

  has(cellX: number, cellZ: number): boolean {
    return this.columns.get(cellX)?.has(cellZ) ?? false;
  }

  set(cellX: number, cellZ: number, value: T): void {
    let column = this.columns.get(cellX);
    if (!column) {
      column = new Map();
      this.columns.set(cellX, column);
    }
    column.set(cellZ, value);
  }
}

function sameSurface(a: Cell, b: Cell): boolean {
  return a.top === b.top && a.stud === b.stud && a.road === b.road;
}

export function placedCells(placement: RoadPlacement): ReadonlyArray<PlacedCell> {
  const { surface, rot } = placement;
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const cells: PlacedCell[] = [];
  for (let row = 0; row < surface.rows; row++) {
    for (let column = 0; column < surface.columns; column++) {
      const index = row * surface.columns + column;
      const localX = surface.minX + column * STUD_LDU + HALF_STUD;
      const localZ = surface.minZ + row * STUD_LDU + HALF_STUD;
      const worldX = placement.x + cos * localX + sin * localZ;
      const worldZ = placement.z - sin * localX + cos * localZ;
      const stud = surface.stud[index] ?? NO_STUD;
      cells.push({
        placement: placement.id,
        cellX: Math.floor(worldX / STUD_LDU),
        cellZ: Math.floor(worldZ / STUD_LDU),
        top: (surface.top[index] ?? 0) + placement.yLdu,
        stud: stud === NO_STUD ? NO_STUD : stud + placement.yLdu,
        road: surface.road[index] ?? 0,
      });
    }
  }
  return cells;
}

function edgeLine(side: RoadSide, cellX: number, cellZ: number): number {
  switch (side) {
    case "minX":
      return cellX * STUD_LDU;
    case "maxX":
      return (cellX + 1) * STUD_LDU;
    case "minZ":
      return cellZ * STUD_LDU;
    case "maxZ":
      return (cellZ + 1) * STUD_LDU;
    default: {
      const unhandled: never = side;
      throw new Error(`unhandled side ${String(unhandled)}`);
    }
  }
}

function alongEdge(side: RoadSide, cellX: number, cellZ: number): number {
  return side === "minX" || side === "maxX" ? cellZ : cellX;
}

interface EdgeCell {
  readonly placement: number;
  readonly side: RoadSide;
  readonly line: number;
  readonly along: number;
  readonly topLdu: number;
  readonly status: RoadCellStatus;
}

interface EdgeRun {
  readonly first: EdgeCell;
  readonly along: Set<number>;
  min: number;
  max: number;
}

function runKey(cell: EdgeCell): string {
  return `${cell.placement}|${cell.side}|${cell.line}|${cell.status}|${cell.topLdu}`;
}

function mergeSegments(cells: ReadonlyArray<EdgeCell>): ReadonlyArray<RoadEdgeSegment> {
  const runs = new Map<string, EdgeRun>();
  for (const cell of cells) {
    const key = runKey(cell);
    const run = runs.get(key);
    if (!run) {
      runs.set(key, {
        first: cell,
        along: new Set([cell.along]),
        min: cell.along,
        max: cell.along,
      });
      continue;
    }
    run.along.add(cell.along);
    run.min = Math.min(run.min, cell.along);
    run.max = Math.max(run.max, cell.along);
  }
  const segments: RoadEdgeSegment[] = [];
  for (const { first, along, min, max } of runs.values()) {
    let from: number | null = null;
    for (let index = min; index <= max + 1; index++) {
      if (along.has(index)) {
        from ??= index;
        continue;
      }
      if (from === null) continue;
      segments.push({
        placement: first.placement,
        side: first.side,
        line: first.line,
        from: from * STUD_LDU,
        to: index * STUD_LDU,
        topLdu: first.topLdu,
        status: first.status,
      });
      from = null;
    }
  }
  return segments;
}

const STAMP_CELL_INTS = 5;
const STAMP_EDGE_INTS = 3;

interface CellRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

interface RoadStamp extends CellRect {
  readonly cells: Int32Array;
  readonly edges: Int32Array;
}

const stamps = new WeakMap<RoadSurface, Array<RoadStamp | undefined>>();

function rectOf(cells: ReadonlyArray<PlacedCell>): CellRect {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const cell of cells) {
    minX = Math.min(minX, cell.cellX);
    minZ = Math.min(minZ, cell.cellZ);
    maxX = Math.max(maxX, cell.cellX);
    maxZ = Math.max(maxZ, cell.cellZ);
  }
  return { minX, minZ, maxX, maxZ };
}

function buildStamp(surface: RoadSurface, rot: number): RoadStamp {
  const local = placedCells({ id: -1, x: 0, z: 0, yLdu: 0, rot, surface });
  const own = new CellMap<boolean>();
  for (const cell of local) own.set(cell.cellX, cell.cellZ, true);
  const cells = new Int32Array(local.length * STAMP_CELL_INTS);
  const edges: number[] = [];
  local.forEach((cell, index) => {
    cells.set([cell.cellX, cell.cellZ, cell.top, cell.stud, cell.road], index * STAMP_CELL_INTS);
    for (const [, dx, dz] of SIDES) {
      if (!own.has(cell.cellX + dx, cell.cellZ + dz)) edges.push(index, dx, dz);
    }
  });
  return { ...rectOf(local), cells, edges: Int32Array.from(edges) };
}

function stampOf(surface: RoadSurface, rot: number): RoadStamp {
  let byRot = stamps.get(surface);
  if (!byRot) {
    byRot = [];
    stamps.set(surface, byRot);
  }
  const cached = byRot[rot];
  if (cached) return cached;
  const stamp = buildStamp(surface, rot);
  byRot[rot] = stamp;
  return stamp;
}

function rectsMeet(a: CellRect, b: CellRect, offsetX: number, offsetZ: number): boolean {
  return (
    a.minX + offsetX <= b.maxX &&
    a.maxX + offsetX >= b.minX &&
    a.minZ + offsetZ <= b.maxZ &&
    a.maxZ + offsetZ >= b.minZ
  );
}

export class RoadNetwork {
  private readonly cells = new CellMap<Cell>();
  private readonly placed: ReadonlyArray<ReadonlyArray<PlacedCell>>;
  private readonly rects: ReadonlyArray<CellRect>;
  private readonly overlapPairs = new Set<string>();

  constructor(placements: ReadonlyArray<RoadPlacement>) {
    this.placed = placements.map(placedCells);
    this.rects = this.placed.map(rectOf);
    for (const cells of this.placed) {
      for (const cell of cells) {
        const existing = this.cells.get(cell.cellX, cell.cellZ);
        if (existing && existing.placement !== cell.placement) {
          const low = Math.min(existing.placement, cell.placement);
          const high = Math.max(existing.placement, cell.placement);
          this.overlapPairs.add(`${low},${high}`);
          continue;
        }
        this.cells.set(cell.cellX, cell.cellZ, cell);
      }
    }
  }

  report(): RoadJoinReport {
    const edgeCells: EdgeCell[] = [];
    let joinedCells = 0;
    let openCells = 0;
    let mismatchedCells = 0;
    for (const cells of this.placed) {
      for (const cell of cells) {
        for (const [side, dx, dz] of SIDES) {
          const neighbour = this.cells.get(cell.cellX + dx, cell.cellZ + dz);
          if (neighbour?.placement === cell.placement) continue;
          let status: RoadCellStatus;
          if (!neighbour) {
            if (cell.road === 0) continue;
            status = "open";
            openCells++;
          } else if (sameSurface(cell, neighbour)) {
            status = "joined";
            if (cell.placement < neighbour.placement) joinedCells++;
          } else {
            status = "mismatch";
            if (cell.placement < neighbour.placement) mismatchedCells++;
          }
          edgeCells.push({
            placement: cell.placement,
            side,
            line: edgeLine(side, cell.cellX, cell.cellZ),
            along: alongEdge(side, cell.cellX, cell.cellZ),
            topLdu: Math.max(cell.top, neighbour?.top ?? cell.top),
            status,
          });
        }
      }
    }
    return {
      placements: this.placed.length,
      joinedCells,
      openCells,
      mismatchedCells,
      overlaps: [...this.overlapPairs].map((pair) => {
        const [a = 0, b = 0] = pair.split(",").map(Number);
        return [a, b] as const;
      }),
      segments: mergeSegments(edgeCells),
    };
  }

  fit(candidate: RoadPlacement): RoadFit {
    const onLattice = candidate.x % STUD_LDU === 0 && candidate.z % STUD_LDU === 0;
    if (!onLattice || !isRot90(candidate.rot)) return this.fitCells(candidate);
    const stamp = stampOf(candidate.surface, candidate.rot);
    const offsetX = candidate.x / STUD_LDU;
    const offsetZ = candidate.z / STUD_LDU;
    const y = candidate.yLdu;
    const { cells, edges } = stamp;
    let overlappingCells = 0;
    if (this.rects.some((rect) => rectsMeet(stamp, rect, offsetX, offsetZ))) {
      for (let c = 0; c < cells.length; c += STAMP_CELL_INTS) {
        if (this.cells.has((cells[c] ?? 0) + offsetX, (cells[c + 1] ?? 0) + offsetZ)) {
          overlappingCells++;
        }
      }
    }
    let joinedCells = 0;
    let joinedRoadCells = 0;
    let mismatchedCells = 0;
    for (let e = 0; e < edges.length; e += STAMP_EDGE_INTS) {
      const c = (edges[e] ?? 0) * STAMP_CELL_INTS;
      const neighbour = this.cells.get(
        (cells[c] ?? 0) + offsetX + (edges[e + 1] ?? 0),
        (cells[c + 1] ?? 0) + offsetZ + (edges[e + 2] ?? 0),
      );
      if (!neighbour) continue;
      const stud = cells[c + 3] ?? NO_STUD;
      const road = cells[c + 4] ?? 0;
      const same =
        neighbour.top === (cells[c + 2] ?? 0) + y &&
        neighbour.stud === (stud === NO_STUD ? NO_STUD : stud + y) &&
        neighbour.road === road;
      if (!same) {
        mismatchedCells++;
        continue;
      }
      joinedCells++;
      if (road !== 0) joinedRoadCells++;
    }
    return { joinedCells, joinedRoadCells, mismatchedCells, overlappingCells };
  }

  private fitCells(candidate: RoadPlacement): RoadFit {
    const cells = placedCells(candidate);
    const own = new CellMap<boolean>();
    for (const cell of cells) own.set(cell.cellX, cell.cellZ, true);
    let joinedCells = 0;
    let joinedRoadCells = 0;
    let mismatchedCells = 0;
    let overlappingCells = 0;
    for (const cell of cells) {
      if (this.cells.has(cell.cellX, cell.cellZ)) overlappingCells++;
      for (const [, dx, dz] of SIDES) {
        if (own.has(cell.cellX + dx, cell.cellZ + dz)) continue;
        const neighbour = this.cells.get(cell.cellX + dx, cell.cellZ + dz);
        if (!neighbour) continue;
        if (!sameSurface(cell, neighbour)) {
          mismatchedCells++;
          continue;
        }
        joinedCells++;
        if (cell.road !== 0) joinedRoadCells++;
      }
    }
    return { joinedCells, joinedRoadCells, mismatchedCells, overlappingCells };
  }

  seams(candidate: RoadPlacement): ReadonlyArray<RoadEdgeSegment> {
    const cells = placedCells(candidate);
    const own = new CellMap<boolean>();
    for (const cell of cells) own.set(cell.cellX, cell.cellZ, true);
    const edgeCells: EdgeCell[] = [];
    for (const cell of cells) {
      for (const [side, dx, dz] of SIDES) {
        if (own.has(cell.cellX + dx, cell.cellZ + dz)) continue;
        const neighbour = this.cells.get(cell.cellX + dx, cell.cellZ + dz);
        if (!neighbour) continue;
        edgeCells.push({
          placement: candidate.id,
          side,
          line: edgeLine(side, cell.cellX, cell.cellZ),
          along: alongEdge(side, cell.cellX, cell.cellZ),
          topLdu: Math.max(cell.top, neighbour.top),
          status: sameSurface(cell, neighbour) ? "joined" : "mismatch",
        });
      }
    }
    return mergeSegments(edgeCells);
  }
}

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

function mergeSegments(cells: ReadonlyArray<EdgeCell>): ReadonlyArray<RoadEdgeSegment> {
  const sorted = cells.toSorted(
    (a, b) =>
      a.placement - b.placement ||
      a.side.localeCompare(b.side) ||
      a.line - b.line ||
      a.status.localeCompare(b.status) ||
      a.topLdu - b.topLdu ||
      a.along - b.along,
  );
  const segments: RoadEdgeSegment[] = [];
  let run: { first: EdgeCell; last: number } | null = null;
  const close = (): void => {
    if (!run) return;
    const { first, last } = run;
    segments.push({
      placement: first.placement,
      side: first.side,
      line: first.line,
      from: first.along * STUD_LDU,
      to: (last + 1) * STUD_LDU,
      topLdu: first.topLdu,
      status: first.status,
    });
  };
  for (const cell of sorted) {
    const continues =
      run !== null &&
      run.first.placement === cell.placement &&
      run.first.side === cell.side &&
      run.first.line === cell.line &&
      run.first.status === cell.status &&
      run.first.topLdu === cell.topLdu &&
      run.last + 1 === cell.along;
    if (continues && run) {
      run.last = cell.along;
      continue;
    }
    close();
    run = { first: cell, last: cell.along };
  }
  close();
  return segments;
}

export class RoadNetwork {
  private readonly cells = new CellMap<Cell>();
  private readonly placed: ReadonlyArray<ReadonlyArray<PlacedCell>>;
  private readonly overlapPairs = new Set<string>();

  constructor(placements: ReadonlyArray<RoadPlacement>) {
    this.placed = placements.map(placedCells);
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
    const cells = placedCells(candidate);
    const own = new CellMap<boolean>();
    for (const cell of cells) own.set(cell.cellX, cell.cellZ, true);
    let joinedCells = 0;
    let mismatchedCells = 0;
    let overlappingCells = 0;
    for (const cell of cells) {
      if (this.cells.has(cell.cellX, cell.cellZ)) overlappingCells++;
      for (const [, dx, dz] of SIDES) {
        if (own.has(cell.cellX + dx, cell.cellZ + dz)) continue;
        const neighbour = this.cells.get(cell.cellX + dx, cell.cellZ + dz);
        if (!neighbour) continue;
        if (sameSurface(cell, neighbour)) joinedCells++;
        else mismatchedCells++;
      }
    }
    return { joinedCells, mismatchedCells, overlappingCells };
  }
}

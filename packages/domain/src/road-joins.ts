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
export type RoadCellStatus = "joined" | "open" | "step" | "mismatch";

export interface RoadEdgeSegment {
  readonly placement: number;
  readonly side: RoadSide;
  readonly line: number;
  readonly from: number;
  readonly to: number;
  readonly topLdu: number;
  readonly ownTopLdu: number;
  readonly neighbourTopLdu: number | null;
  readonly status: RoadCellStatus;
}

export interface RoadJoinReport {
  readonly placements: number;
  readonly joinedCells: number;
  readonly openCells: number;
  readonly steppedCells: number;
  readonly mismatchedCells: number;
  readonly overlaps: ReadonlyArray<readonly [number, number]>;
  readonly segments: ReadonlyArray<RoadEdgeSegment>;
}

export interface RoadFit {
  readonly joinedCells: number;
  readonly joinedRoadCells: number;
  readonly steppedCells: number;
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

function contact(cell: Cell, neighbour: Cell, roadsMeet: boolean): RoadCellStatus {
  if (sameSurface(cell, neighbour)) return "joined";
  if (roadsMeet) return "mismatch";
  return cell.road !== 0 ? "open" : "step";
}

function pairKey(from: number, to: number): string {
  return `${from}|${to}`;
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
  readonly ownTopLdu: number;
  readonly neighbourTopLdu: number | null;
  readonly status: RoadCellStatus;
}

interface EdgeRun {
  readonly first: EdgeCell;
  readonly along: Set<number>;
  min: number;
  max: number;
}

function runKey(cell: EdgeCell): string {
  return `${cell.placement}|${cell.side}|${cell.line}|${cell.status}|${cell.ownTopLdu}|${cell.neighbourTopLdu}`;
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
        ownTopLdu: first.ownTopLdu,
        neighbourTopLdu: first.neighbourTopLdu,
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
    let steppedCells = 0;
    let mismatchedCells = 0;
    const roadFacing = new Set<string>();
    for (const cells of this.placed) {
      for (const cell of cells) {
        if (cell.road === 0) continue;
        for (const [, dx, dz] of SIDES) {
          const neighbour = this.cells.get(cell.cellX + dx, cell.cellZ + dz);
          if (neighbour && neighbour.placement !== cell.placement) {
            roadFacing.add(pairKey(cell.placement, neighbour.placement));
          }
        }
      }
    }
    const roadsMeet = (a: number, b: number): boolean =>
      roadFacing.has(pairKey(a, b)) && roadFacing.has(pairKey(b, a));
    for (const cells of this.placed) {
      for (const cell of cells) {
        for (const [side, dx, dz] of SIDES) {
          const neighbour = this.cells.get(cell.cellX + dx, cell.cellZ + dz);
          if (neighbour?.placement === cell.placement) continue;
          if (!neighbour && cell.road === 0) continue;
          const status: RoadCellStatus = neighbour
            ? contact(cell, neighbour, roadsMeet(cell.placement, neighbour.placement))
            : "open";
          const firstOfPair = !neighbour || cell.placement < neighbour.placement;
          switch (status) {
            case "joined":
              if (firstOfPair) joinedCells++;
              break;
            case "mismatch":
              if (firstOfPair) mismatchedCells++;
              break;
            case "open":
              openCells++;
              break;
            case "step":
              if (firstOfPair || neighbour?.road !== 0) steppedCells++;
              break;
            default: {
              const unhandled: never = status;
              throw new Error(`unhandled road cell status ${String(unhandled)}`);
            }
          }
          edgeCells.push({
            placement: cell.placement,
            side,
            line: edgeLine(side, cell.cellX, cell.cellZ),
            along: alongEdge(side, cell.cellX, cell.cellZ),
            topLdu: Math.max(cell.top, neighbour?.top ?? cell.top),
            ownTopLdu: cell.top,
            neighbourTopLdu: neighbour?.top ?? null,
            status,
          });
        }
      }
    }
    return {
      placements: this.placed.length,
      joinedCells,
      openCells,
      steppedCells,
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
    let steppedCells = 0;
    let mismatchedCells = 0;
    const neighbourAt = (e: number): Cell | undefined => {
      const c = (edges[e] ?? 0) * STAMP_CELL_INTS;
      return this.cells.get(
        (cells[c] ?? 0) + offsetX + (edges[e + 1] ?? 0),
        (cells[c + 1] ?? 0) + offsetZ + (edges[e + 2] ?? 0),
      );
    };
    const ownRoadFacing = new Set<number>();
    const roadFacingOwn = new Set<number>();
    for (let e = 0; e < edges.length; e += STAMP_EDGE_INTS) {
      const neighbour = neighbourAt(e);
      if (!neighbour) continue;
      if ((cells[(edges[e] ?? 0) * STAMP_CELL_INTS + 4] ?? 0) !== 0) {
        ownRoadFacing.add(neighbour.placement);
      }
      if (neighbour.road !== 0) roadFacingOwn.add(neighbour.placement);
    }
    for (let e = 0; e < edges.length; e += STAMP_EDGE_INTS) {
      const c = (edges[e] ?? 0) * STAMP_CELL_INTS;
      const neighbour = neighbourAt(e);
      if (!neighbour) continue;
      const stud = cells[c + 3] ?? NO_STUD;
      const road = cells[c + 4] ?? 0;
      const same =
        neighbour.top === (cells[c + 2] ?? 0) + y &&
        neighbour.stud === (stud === NO_STUD ? NO_STUD : stud + y) &&
        neighbour.road === road;
      const roadsMeet =
        ownRoadFacing.has(neighbour.placement) && roadFacingOwn.has(neighbour.placement);
      if (same) {
        joinedCells++;
        if (road !== 0) joinedRoadCells++;
      } else if (roadsMeet) mismatchedCells++;
      else steppedCells++;
    }
    return { joinedCells, joinedRoadCells, steppedCells, mismatchedCells, overlappingCells };
  }

  private fitCells(candidate: RoadPlacement): RoadFit {
    const cells = placedCells(candidate);
    const own = new CellMap<boolean>();
    for (const cell of cells) own.set(cell.cellX, cell.cellZ, true);
    let overlappingCells = 0;
    const contacts: Array<readonly [PlacedCell, Cell]> = [];
    for (const cell of cells) {
      if (this.cells.has(cell.cellX, cell.cellZ)) overlappingCells++;
      for (const [, dx, dz] of SIDES) {
        if (own.has(cell.cellX + dx, cell.cellZ + dz)) continue;
        const neighbour = this.cells.get(cell.cellX + dx, cell.cellZ + dz);
        if (neighbour) contacts.push([cell, neighbour]);
      }
    }
    const ownRoadFacing = new Set(
      contacts.filter(([c]) => c.road !== 0).map(([, n]) => n.placement),
    );
    const roadFacingOwn = new Set(
      contacts.filter(([, n]) => n.road !== 0).map(([, n]) => n.placement),
    );
    let joinedCells = 0;
    let joinedRoadCells = 0;
    let steppedCells = 0;
    let mismatchedCells = 0;
    for (const [cell, neighbour] of contacts) {
      const roadsMeet =
        ownRoadFacing.has(neighbour.placement) && roadFacingOwn.has(neighbour.placement);
      const status = contact(cell, neighbour, roadsMeet);
      switch (status) {
        case "joined":
          joinedCells++;
          if (cell.road !== 0) joinedRoadCells++;
          break;
        case "mismatch":
          mismatchedCells++;
          break;
        case "open":
        case "step":
          steppedCells++;
          break;
        default: {
          const unhandled: never = status;
          throw new Error(`unhandled road cell status ${String(unhandled)}`);
        }
      }
    }
    return { joinedCells, joinedRoadCells, steppedCells, mismatchedCells, overlappingCells };
  }
}

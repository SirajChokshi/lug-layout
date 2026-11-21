import { STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import type { LduRect } from "./plan/plan-region.ts";

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

export const PLACEMENT_JOINED = 0;
export const PLACEMENT_MISMATCHED = 1;
export const PLACEMENT_CELL_INTS = 2;

export interface RoadJoinReport {
  readonly placements: number;
  readonly joinedCells: number;
  readonly openCells: number;
  readonly mismatchedCells: number;
  readonly placementCells: Int32Array;
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

export function roadwayCells(placement: RoadPlacement): ReadonlyArray<LduRect> {
  const roadway: LduRect[] = [];
  for (const cell of placedCells(placement)) {
    if (cell.road === 0) continue;
    roadway.push({
      minX: cell.cellX * STUD_LDU,
      minZ: cell.cellZ * STUD_LDU,
      maxX: (cell.cellX + 1) * STUD_LDU,
      maxZ: (cell.cellZ + 1) * STUD_LDU,
    });
  }
  return roadway;
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
  readonly along: number[];
}

function continuesRun(run: EdgeRun, cell: EdgeCell): boolean {
  const first = run.first;
  return (
    first.side === cell.side &&
    first.line === cell.line &&
    first.status === cell.status &&
    first.topLdu === cell.topLdu
  );
}

function runOf(placementRuns: EdgeRun[], cell: EdgeCell): EdgeRun | null {
  for (let r = 0; r < placementRuns.length; r++) {
    const run = placementRuns[r];
    if (run && continuesRun(run, cell)) return run;
  }
  return null;
}

function mergeSegments(cells: ReadonlyArray<EdgeCell>): ReadonlyArray<RoadEdgeSegment> {
  const runs: EdgeRun[] = [];
  const byPlacement = new Map<number, EdgeRun[]>();
  for (const cell of cells) {
    let placementRuns = byPlacement.get(cell.placement);
    if (!placementRuns) {
      placementRuns = [];
      byPlacement.set(cell.placement, placementRuns);
    }
    let run = runOf(placementRuns, cell);
    if (!run) {
      run = { first: cell, along: [] };
      placementRuns.push(run);
      runs.push(run);
    }
    run.along.push(cell.along);
  }
  const segments: RoadEdgeSegment[] = [];
  for (const { first, along } of runs) {
    along.sort((a, b) => a - b);
    let from = along[0] ?? 0;
    for (let i = 1; i <= along.length; i++) {
      const previous = along[i - 1] ?? 0;
      const next = along[i];
      if (next === previous) continue;
      if (next === previous + 1) continue;
      segments.push({
        placement: first.placement,
        side: first.side,
        line: first.line,
        from: from * STUD_LDU,
        to: (previous + 1) * STUD_LDU,
        topLdu: first.topLdu,
        status: first.status,
      });
      from = next ?? 0;
    }
  }
  return segments;
}

const STAMP_CELL_INTS = 5;
const STAMP_EDGE_INTS = 4;
const BLOCK_SHIFT = 5;
const BLOCK_SIZE = 1 << BLOCK_SHIFT;
const BLOCK_MASK = BLOCK_SIZE - 1;
const NO_OWNER = -1;

interface RoadStamp {
  readonly cells: Float64Array;
  readonly edges: Int32Array;
  readonly rect: CellRect | null;
}

interface CellRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

interface PlacedStamp {
  readonly stamp: RoadStamp;
  readonly offsetX: number;
  readonly offsetZ: number;
  readonly yLdu: number;
}

const stamps = new WeakMap<RoadSurface, Array<RoadStamp | undefined>>();

function filledRect(cells: ReadonlyArray<PlacedCell>, distinct: number): CellRect | null {
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
  const area = (maxX - minX + 1) * (maxZ - minZ + 1);
  return cells.length > 0 && distinct === cells.length && area === distinct
    ? { minX, minZ, maxX, maxZ }
    : null;
}

function stampFrom(cells: ReadonlyArray<PlacedCell>): RoadStamp {
  const own = new CellMap<boolean>();
  let distinct = 0;
  for (const cell of cells) {
    if (!own.has(cell.cellX, cell.cellZ)) distinct++;
    own.set(cell.cellX, cell.cellZ, true);
  }
  const packed = new Float64Array(cells.length * STAMP_CELL_INTS);
  const edges: number[] = [];
  cells.forEach((cell, index) => {
    packed.set([cell.cellX, cell.cellZ, cell.top, cell.stud, cell.road], index * STAMP_CELL_INTS);
    SIDES.forEach(([, dx, dz], side) => {
      if (!own.has(cell.cellX + dx, cell.cellZ + dz)) edges.push(index, dx, dz, side);
    });
  });
  return { cells: packed, edges: Int32Array.from(edges), rect: filledRect(cells, distinct) };
}

function stampOf(surface: RoadSurface, rot: number): RoadStamp {
  let byRot = stamps.get(surface);
  if (!byRot) {
    byRot = [];
    stamps.set(surface, byRot);
  }
  const cached = byRot[rot];
  if (cached) return cached;
  const stamp = stampFrom(placedCells({ id: -1, x: 0, z: 0, yLdu: 0, rot, surface }));
  byRot[rot] = stamp;
  return stamp;
}

function onLattice(placement: RoadPlacement): boolean {
  return placement.x % STUD_LDU === 0 && placement.z % STUD_LDU === 0 && isRot90(placement.rot);
}

function placedStamp(placement: RoadPlacement): PlacedStamp {
  if (!onLattice(placement)) {
    return { stamp: stampFrom(placedCells(placement)), offsetX: 0, offsetZ: 0, yLdu: 0 };
  }
  return {
    stamp: stampOf(placement.surface, placement.rot),
    offsetX: placement.x / STUD_LDU,
    offsetZ: placement.z / STUD_LDU,
    yLdu: placement.yLdu,
  };
}

function raisedStud(stud: number, yLdu: number): number {
  return stud === NO_STUD ? NO_STUD : stud + yLdu;
}

class CellBlock {
  claimed = 0;
  readonly owner = new Int32Array(BLOCK_SIZE * BLOCK_SIZE).fill(NO_OWNER);
  readonly top = new Float64Array(BLOCK_SIZE * BLOCK_SIZE);
  readonly stud = new Float64Array(BLOCK_SIZE * BLOCK_SIZE);
  readonly road = new Uint8Array(BLOCK_SIZE * BLOCK_SIZE);
}

class CellGrid {
  private readonly blocks = new Map<number, Map<number, CellBlock>>();
  private cachedX = 0;
  private cachedZ = 0;
  private cached: CellBlock | undefined = undefined;
  private cacheValid = false;
  top = 0;
  stud = 0;
  road = 0;

  private blockAt(blockX: number, blockZ: number): CellBlock | undefined {
    if (!this.cacheValid || blockX !== this.cachedX || blockZ !== this.cachedZ) {
      this.cached = this.blocks.get(blockX)?.get(blockZ);
      this.cachedX = blockX;
      this.cachedZ = blockZ;
      this.cacheValid = true;
    }
    return this.cached;
  }

  find(cellX: number, cellZ: number): number {
    const block = this.blockAt(cellX >> BLOCK_SHIFT, cellZ >> BLOCK_SHIFT);
    if (!block) return NO_OWNER;
    const slot = ((cellZ & BLOCK_MASK) << BLOCK_SHIFT) | (cellX & BLOCK_MASK);
    const owner = block.owner[slot] ?? NO_OWNER;
    if (owner === NO_OWNER) return NO_OWNER;
    this.top = block.top[slot] ?? 0;
    this.stud = block.stud[slot] ?? 0;
    this.road = block.road[slot] ?? 0;
    return owner;
  }

  claimedIn(minX: number, minZ: number, maxX: number, maxZ: number, stopAtFirst: boolean): number {
    let claimed = 0;
    for (let blockZ = minZ >> BLOCK_SHIFT; blockZ <= maxZ >> BLOCK_SHIFT; blockZ++) {
      for (let blockX = minX >> BLOCK_SHIFT; blockX <= maxX >> BLOCK_SHIFT; blockX++) {
        const block = this.blockAt(blockX, blockZ);
        if (!block || block.claimed === 0) continue;
        const fromX = Math.max(minX, blockX << BLOCK_SHIFT) & BLOCK_MASK;
        const toX = Math.min(maxX, (blockX << BLOCK_SHIFT) | BLOCK_MASK) & BLOCK_MASK;
        const fromZ = Math.max(minZ, blockZ << BLOCK_SHIFT) & BLOCK_MASK;
        const toZ = Math.min(maxZ, (blockZ << BLOCK_SHIFT) | BLOCK_MASK) & BLOCK_MASK;
        const owner = block.owner;
        for (let z = fromZ; z <= toZ; z++) {
          const row = z << BLOCK_SHIFT;
          for (let x = fromX; x <= toX; x++) {
            if (owner[row | x] === NO_OWNER) continue;
            claimed++;
            if (stopAtFirst) return claimed;
          }
        }
      }
    }
    return claimed;
  }

  clear(): void {
    for (const row of this.blocks.values()) {
      for (const block of row.values()) {
        if (block.claimed === 0) continue;
        block.owner.fill(NO_OWNER);
        block.claimed = 0;
      }
    }
  }

  claim(cellX: number, cellZ: number, owner: number, top: number, stud: number, road: number) {
    const blockX = cellX >> BLOCK_SHIFT;
    const blockZ = cellZ >> BLOCK_SHIFT;
    let block = this.blockAt(blockX, blockZ);
    if (!block) {
      let row = this.blocks.get(blockX);
      if (!row) {
        row = new Map();
        this.blocks.set(blockX, row);
      }
      block = new CellBlock();
      row.set(blockZ, block);
      this.cached = block;
    }
    const slot = ((cellZ & BLOCK_MASK) << BLOCK_SHIFT) | (cellX & BLOCK_MASK);
    if (block.owner[slot] === NO_OWNER) block.claimed++;
    block.owner[slot] = owner;
    block.top[slot] = top;
    block.stud[slot] = stud;
    block.road[slot] = road;
  }
}

interface EdgeFit {
  joinedCells: number;
  joinedRoadCells: number;
  mismatchedCells: number;
}

class EdgeTally {
  readonly edgeCells: EdgeCell[] = [];
  joinedCells = 0;
  openCells = 0;
  mismatchedCells = 0;

  constructor(readonly placementCells: Int32Array) {}

  countPlacement(placement: number, column: number): void {
    const at = placement * PLACEMENT_CELL_INTS + column;
    this.placementCells[at] = (this.placementCells[at] ?? 0) + 1;
  }
}

export class RoadNetwork {
  private readonly grid = new CellGrid();
  private readonly ids: number[];
  private readonly placed: PlacedStamp[];
  private lostCells: Uint8Array;
  private readonly overlapPairs = new Set<string>();
  private readonly scratchFit: EdgeFit = { joinedCells: 0, joinedRoadCells: 0, mismatchedCells: 0 };

  constructor(placements: ReadonlyArray<RoadPlacement>) {
    this.ids = placements.map((placement) => placement.id);
    this.placed = placements.map(placedStamp);
    this.lostCells = new Uint8Array(placements.length);
    for (let p = 0; p < this.placed.length; p++) this.claimCells(p);
  }

  add(placement: RoadPlacement): void {
    const p = this.placed.length;
    this.ids.push(placement.id);
    this.placed.push(placedStamp(placement));
    if (p >= this.lostCells.length) {
      const grown = new Uint8Array(Math.max(1, 2 * this.lostCells.length));
      grown.set(this.lostCells);
      this.lostCells = grown;
    }
    this.claimCells(p);
  }

  clear(): void {
    this.ids.length = 0;
    this.placed.length = 0;
    this.lostCells.fill(0);
    this.overlapPairs.clear();
    this.grid.clear();
  }

  private claimCells(p: number): void {
    const placed = this.placed[p];
    if (!placed) return;
    const { stamp, offsetX, offsetZ, yLdu } = placed;
    const id = this.ids[p] ?? 0;
    const cells = stamp.cells;
    for (let c = 0; c < cells.length; c += STAMP_CELL_INTS) {
      const cellX = (cells[c] ?? 0) + offsetX;
      const cellZ = (cells[c + 1] ?? 0) + offsetZ;
      const existing = this.grid.find(cellX, cellZ);
      if (existing !== NO_OWNER && this.ids[existing] !== id) {
        const other = this.ids[existing] ?? 0;
        this.overlapPairs.add(`${Math.min(other, id)},${Math.max(other, id)}`);
        this.lostCells[p] = 1;
        continue;
      }
      this.grid.claim(
        cellX,
        cellZ,
        p,
        (cells[c + 2] ?? 0) + yLdu,
        raisedStud(cells[c + 3] ?? NO_STUD, yLdu),
        cells[c + 4] ?? 0,
      );
    }
  }

  report(): RoadJoinReport {
    const tally = new EdgeTally(new Int32Array(this.placed.length * PLACEMENT_CELL_INTS));
    for (let p = 0; p < this.placed.length; p++) {
      const placed = this.placed[p];
      if (!placed) continue;
      if (this.lostCells[p] === 1) this.tallyEverySide(p, placed, tally);
      else this.tallyBoundary(p, placed, tally);
    }
    return {
      placements: this.placed.length,
      joinedCells: tally.joinedCells,
      openCells: tally.openCells,
      mismatchedCells: tally.mismatchedCells,
      placementCells: tally.placementCells,
      overlaps: [...this.overlapPairs].map((pair) => {
        const [a = 0, b = 0] = pair.split(",").map(Number);
        return [a, b] as const;
      }),
      segments: mergeSegments(tally.edgeCells),
    };
  }

  private tallyBoundary(p: number, placed: PlacedStamp, tally: EdgeTally): void {
    const { cells, edges } = placed.stamp;
    for (let e = 0; e < edges.length; e += STAMP_EDGE_INTS) {
      this.tallySide(p, placed, (edges[e] ?? 0) * STAMP_CELL_INTS, edges[e + 3] ?? 0, cells, tally);
    }
  }

  private tallyEverySide(p: number, placed: PlacedStamp, tally: EdgeTally): void {
    const { cells } = placed.stamp;
    for (let c = 0; c < cells.length; c += STAMP_CELL_INTS) {
      for (let side = 0; side < SIDES.length; side++) {
        this.tallySide(p, placed, c, side, cells, tally);
      }
    }
  }

  private tallySide(
    p: number,
    placed: PlacedStamp,
    c: number,
    sideIndex: number,
    cells: Float64Array,
    tally: EdgeTally,
  ): void {
    const [side, dx, dz] = SIDES[sideIndex] ?? ["minX", -1, 0];
    const id = this.ids[p] ?? 0;
    const cellX = (cells[c] ?? 0) + placed.offsetX;
    const cellZ = (cells[c + 1] ?? 0) + placed.offsetZ;
    const top = (cells[c + 2] ?? 0) + placed.yLdu;
    const stud = raisedStud(cells[c + 3] ?? NO_STUD, placed.yLdu);
    const road = cells[c + 4] ?? 0;
    const neighbour = this.grid.find(cellX + dx, cellZ + dz);
    const neighbourId = neighbour === NO_OWNER ? null : (this.ids[neighbour] ?? 0);
    if (neighbourId === id) return;
    let status: RoadCellStatus;
    let topLdu = top;
    if (neighbourId === null) {
      if (road === 0) return;
      status = "open";
      tally.openCells++;
    } else {
      const grid = this.grid;
      topLdu = Math.max(top, grid.top);
      if (grid.top === top && grid.stud === stud && grid.road === road) {
        status = "joined";
        if (id < neighbourId) {
          tally.joinedCells++;
          tally.countPlacement(p, PLACEMENT_JOINED);
        }
      } else {
        status = "mismatch";
        if (id < neighbourId) tally.mismatchedCells++;
        tally.countPlacement(p, PLACEMENT_MISMATCHED);
      }
    }
    tally.edgeCells.push({
      placement: id,
      side,
      line: edgeLine(side, cellX, cellZ),
      along: alongEdge(side, cellX, cellZ),
      topLdu,
      status,
    });
  }

  fit(candidate: RoadPlacement): RoadFit {
    if (!onLattice(candidate)) return this.fitCells(candidate);
    const stamp = stampOf(candidate.surface, candidate.rot);
    const offsetX = candidate.x / STUD_LDU;
    const offsetZ = candidate.z / STUD_LDU;
    const edges = this.edgeFit(stamp, offsetX, offsetZ, candidate.yLdu, false);
    return {
      joinedCells: edges.joinedCells,
      joinedRoadCells: edges.joinedRoadCells,
      mismatchedCells: edges.mismatchedCells,
      overlappingCells: this.overlappingCells(stamp, offsetX, offsetZ, false),
    };
  }

  cleanFit(candidate: RoadPlacement): RoadFit | null {
    if (!onLattice(candidate)) {
      const fit = this.fitCells(candidate);
      const clean = fit.joinedCells > 0 && fit.mismatchedCells === 0 && fit.overlappingCells === 0;
      return clean ? fit : null;
    }
    const stamp = stampOf(candidate.surface, candidate.rot);
    const offsetX = candidate.x / STUD_LDU;
    const offsetZ = candidate.z / STUD_LDU;
    if (this.overlappingCells(stamp, offsetX, offsetZ, true) > 0) return null;
    const edges = this.edgeFit(stamp, offsetX, offsetZ, candidate.yLdu, true);
    if (edges.joinedCells === 0 || edges.mismatchedCells > 0) return null;
    return {
      joinedCells: edges.joinedCells,
      joinedRoadCells: edges.joinedRoadCells,
      mismatchedCells: 0,
      overlappingCells: 0,
    };
  }

  private overlappingCells(
    stamp: RoadStamp,
    offsetX: number,
    offsetZ: number,
    stopAtFirst: boolean,
  ): number {
    const { cells, rect } = stamp;
    const grid = this.grid;
    if (rect) {
      return grid.claimedIn(
        rect.minX + offsetX,
        rect.minZ + offsetZ,
        rect.maxX + offsetX,
        rect.maxZ + offsetZ,
        stopAtFirst,
      );
    }
    let overlapping = 0;
    for (let c = 0; c < cells.length; c += STAMP_CELL_INTS) {
      if (grid.find((cells[c] ?? 0) + offsetX, (cells[c + 1] ?? 0) + offsetZ) === NO_OWNER) {
        continue;
      }
      overlapping++;
      if (stopAtFirst) break;
    }
    return overlapping;
  }

  private edgeFit(
    stamp: RoadStamp,
    offsetX: number,
    offsetZ: number,
    y: number,
    stopAtMismatch: boolean,
  ): EdgeFit {
    const { cells, edges } = stamp;
    const grid = this.grid;
    const fit = this.scratchFit;
    fit.joinedCells = 0;
    fit.joinedRoadCells = 0;
    fit.mismatchedCells = 0;
    for (let e = 0; e < edges.length; e += STAMP_EDGE_INTS) {
      const c = (edges[e] ?? 0) * STAMP_CELL_INTS;
      const neighbour = grid.find(
        (cells[c] ?? 0) + offsetX + (edges[e + 1] ?? 0),
        (cells[c + 1] ?? 0) + offsetZ + (edges[e + 2] ?? 0),
      );
      if (neighbour === NO_OWNER) continue;
      const road = cells[c + 4] ?? 0;
      const same =
        grid.top === (cells[c + 2] ?? 0) + y &&
        grid.stud === raisedStud(cells[c + 3] ?? NO_STUD, y) &&
        grid.road === road;
      if (!same) {
        fit.mismatchedCells++;
        if (stopAtMismatch) break;
        continue;
      }
      fit.joinedCells++;
      if (road !== 0) fit.joinedRoadCells++;
    }
    return fit;
  }

  private fitCells(candidate: RoadPlacement): RoadFit {
    const cells = placedCells(candidate);
    const own = new CellMap<boolean>();
    for (const cell of cells) own.set(cell.cellX, cell.cellZ, true);
    const grid = this.grid;
    let joinedCells = 0;
    let joinedRoadCells = 0;
    let mismatchedCells = 0;
    let overlappingCells = 0;
    for (const cell of cells) {
      if (grid.find(cell.cellX, cell.cellZ) !== NO_OWNER) overlappingCells++;
      for (const [, dx, dz] of SIDES) {
        if (own.has(cell.cellX + dx, cell.cellZ + dz)) continue;
        if (grid.find(cell.cellX + dx, cell.cellZ + dz) === NO_OWNER) continue;
        if (grid.top !== cell.top || grid.stud !== cell.stud || grid.road !== cell.road) {
          mismatchedCells++;
          continue;
        }
        joinedCells++;
        if (cell.road !== 0) joinedRoadCells++;
      }
    }
    return { joinedCells, joinedRoadCells, mismatchedCells, overlappingCells };
  }
}

import {
  SIXTEENTHS_PER_LDU,
  STUD_LDU,
  isLatticePose,
  isRot90,
  rot90Cos,
  rot90Sin,
} from "@brr/math";
import type { LduRect } from "./plan/plan-region.ts";
import { RoadCellGrid, int32, type RoadCellRect } from "./road-cell-grid.ts";
import { CLASHED_FIT, COMPLETE_FIT, RoadFitMemo, type FitKey, type RoadFit } from "./road-fit.ts";

export const NO_STUD = -0x4000_0000;
export const NO_TOP = -0x4000_0000;

export interface RoadSurface {
  readonly minX: number;
  readonly minZ: number;
  readonly columns: number;
  readonly rows: number;
  readonly topSixteenths: Int32Array;
  readonly studSixteenths: Int32Array;
  readonly road: Uint8Array;
  readonly occupied: Uint8Array;
}

export function closesRoadEdge(
  top: number,
  besideTop: number,
  besideStud: number,
  besideOccupied: boolean,
): boolean {
  if (!besideOccupied) return false;
  return besideTop === NO_TOP || besideTop > top || besideStud === NO_STUD;
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

export interface RoadPlacementJoin {
  readonly mismatched: boolean;
  readonly overlapPartner: number | null;
}

interface PlacedCell {
  readonly placement: number;
  readonly centreX: number;
  readonly centreZ: number;
  readonly cellX: number;
  readonly cellZ: number;
  readonly topSixteenths: number;
  readonly studSixteenths: number;
  readonly road: number;
}

const SIDE_NAMES: ReadonlyArray<RoadSide> = ["minX", "maxX", "minZ", "maxZ"];
const SIDE_DX = Int8Array.of(-1, 1, 0, 0);
const SIDE_DZ = Int8Array.of(0, 0, -1, 1);
const SIDE_LINE_OFFSET = Int8Array.of(0, 1, 0, 1);
const HALF_STUD = STUD_LDU / 2;

const NO_PARTNER = -1;
const OWN_ROAD = 1;
const PARTNER_ROAD = 2;
const BOTH_ROAD = OWN_ROAD | PARTNER_ROAD;
const UNEQUAL = 4;
const CERTAIN_MISMATCH = BOTH_ROAD | UNEQUAL;
const NO_STATUS = 0;
const JOINED = 1;
const MISMATCHED = 2;
const OPEN = 3;
const FIRST_SEAM_CAPACITY = 64;

function raisedStud(stud: number, ySixteenths: number): number {
  return stud === NO_STUD ? NO_STUD : stud + ySixteenths;
}

function sixteenthsOf(yLdu: number): number {
  return yLdu * SIXTEENTHS_PER_LDU;
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
      const top = surface.topSixteenths[index] ?? NO_TOP;
      if (top === NO_TOP) continue;
      const localX = surface.minX + column * STUD_LDU + HALF_STUD;
      const localZ = surface.minZ + row * STUD_LDU + HALF_STUD;
      const centreX = placement.x + cos * localX + sin * localZ;
      const centreZ = placement.z - sin * localX + cos * localZ;
      cells.push({
        placement: placement.id,
        centreX,
        centreZ,
        cellX: Math.floor(centreX / STUD_LDU),
        cellZ: Math.floor(centreZ / STUD_LDU),
        topSixteenths: top + sixteenthsOf(placement.yLdu),
        studSixteenths: raisedStud(
          surface.studSixteenths[index] ?? NO_STUD,
          sixteenthsOf(placement.yLdu),
        ),
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
      minX: cell.centreX - HALF_STUD,
      minZ: cell.centreZ - HALF_STUD,
      maxX: cell.centreX + HALF_STUD,
      maxZ: cell.centreZ + HALF_STUD,
    });
  }
  return roadway;
}

function acrossX(side: number): boolean {
  return side < 2;
}

function isInt32(value: number): boolean {
  return (value | 0) === value;
}

function latticeCell(ldu: number): number {
  return Math.floor(ldu / STUD_LDU);
}

interface StampCell {
  readonly column: number;
  readonly row: number;
  readonly top: number;
  readonly present: boolean;
  readonly occupied: boolean;
  readonly stud: number;
  readonly road: number;
}

interface SeamEdge {
  readonly cell: number;
  readonly side: number;
  readonly line: number;
  readonly along: number;
  readonly closed: boolean;
}

function closesEdge(cell: StampCell, beside: StampCell | undefined): boolean {
  return beside !== undefined && closesRoadEdge(cell.top, beside.top, beside.stud, beside.occupied);
}

class RoadStamp implements RoadCellRect {
  readonly anchorX: number;
  readonly anchorZ: number;
  readonly width: number;
  readonly depth: number;
  readonly column: Int32Array;
  readonly row: Int32Array;
  readonly top: Float64Array;
  readonly present: Uint8Array;
  readonly stud: Float64Array;
  readonly road: Uint8Array;
  readonly levels: Float64Array;
  readonly seamCell: Int32Array;
  readonly seamSide: Uint8Array;
  readonly seamClosed: Uint8Array;
  readonly seamLineEnd: Int32Array;

  constructor(
    surface: RoadSurface,
    readonly turn: number,
  ) {
    if (!isRot90(turn)) throw new Error(`rotation ${turn} is not a quarter turn 0-3`);
    if (!Number.isInteger(surface.minX) || !Number.isInteger(surface.minZ)) {
      throw new RangeError(`surface origin ${surface.minX}, ${surface.minZ} is not whole LDU`);
    }
    const cos = rot90Cos(turn);
    const sin = rot90Sin(turn);
    const cornersX: number[] = [];
    const cornersZ: number[] = [];
    for (let row = 0; row < surface.rows; row++) {
      for (let column = 0; column < surface.columns; column++) {
        const localX = surface.minX + column * STUD_LDU + HALF_STUD;
        const localZ = surface.minZ + row * STUD_LDU + HALF_STUD;
        cornersX.push(cos * localX + sin * localZ - HALF_STUD);
        cornersZ.push(-sin * localX + cos * localZ - HALF_STUD);
      }
    }
    this.anchorX = cornersX.reduce((low, corner) => Math.min(low, corner), cornersX[0] ?? 0);
    this.anchorZ = cornersZ.reduce((low, corner) => Math.min(low, corner), cornersZ[0] ?? 0);
    const cells = cornersX
      .map((cornerX, index): StampCell => {
        const top = surface.topSixteenths[index] ?? NO_TOP;
        return {
          column: (cornerX - this.anchorX) / STUD_LDU,
          row: ((cornersZ[index] ?? 0) - this.anchorZ) / STUD_LDU,
          top,
          present: top !== NO_TOP,
          occupied: (surface.occupied[index] ?? 0) !== 0,
          stud: surface.studSixteenths[index] ?? NO_STUD,
          road: surface.road[index] ?? 0,
        };
      })
      .toSorted((a, b) => a.row - b.row || a.column - b.column);
    this.width = turn % 2 === 0 ? surface.columns : surface.rows;
    this.depth = turn % 2 === 0 ? surface.rows : surface.columns;
    this.column = Int32Array.from(cells, (cell) => cell.column);
    this.row = Int32Array.from(cells, (cell) => cell.row);
    this.top = Float64Array.from(cells, (cell) => cell.top);
    this.present = Uint8Array.from(cells, (cell) => (cell.present ? 1 : 0));
    this.stud = Float64Array.from(cells, (cell) => cell.stud);
    this.road = Uint8Array.from(cells, (cell) => cell.road);
    this.levels = Float64Array.from(new Set(cells.filter((c) => c.present).map((c) => c.top)));
    const edges = this.seamEdges(cells);
    this.seamCell = Int32Array.from(edges, (edge) => edge.cell);
    this.seamSide = Uint8Array.from(edges, (edge) => edge.side);
    this.seamClosed = Uint8Array.from(edges, (edge) => (edge.closed ? 1 : 0));
    this.seamLineEnd = Int32Array.from(
      edges.flatMap((edge, e) => {
        const next = edges[e + 1];
        const sameLine =
          next && acrossX(next.side) === acrossX(edge.side) && next.line === edge.line;
        return sameLine ? [] : [e + 1];
      }),
    );
  }

  private seamEdges(cells: ReadonlyArray<StampCell>): ReadonlyArray<SeamEdge> {
    const at = (column: number, row: number): StampCell | undefined => {
      const inside = column >= 0 && column < this.width && row >= 0 && row < this.depth;
      return inside ? cells[row * this.width + column] : undefined;
    };
    const edges: SeamEdge[] = [];
    cells.forEach((cell, c) => {
      if (!cell.present) return;
      for (let side = 0; side < SIDE_NAMES.length; side++) {
        const beside = at(cell.column + (SIDE_DX[side] ?? 0), cell.row + (SIDE_DZ[side] ?? 0));
        if (beside?.present && beside.top === cell.top) continue;
        const across = acrossX(side);
        edges.push({
          cell: c,
          side,
          line: (across ? cell.column : cell.row) + (SIDE_LINE_OFFSET[side] ?? 0),
          along: across ? cell.row : cell.column,
          closed: closesEdge(cell, beside),
        });
      }
    });
    return edges.toSorted(
      (a, b) =>
        Number(acrossX(b.side)) - Number(acrossX(a.side)) || a.line - b.line || a.along - b.along,
    );
  }
}

const stamps = new WeakMap<RoadSurface, Array<RoadStamp | undefined>>();

function stampOf(surface: RoadSurface, rot: number): RoadStamp {
  let byRot = stamps.get(surface);
  if (!byRot) {
    byRot = [];
    stamps.set(surface, byRot);
  }
  const cached = byRot[rot];
  if (cached) return cached;
  const stamp = new RoadStamp(surface, rot);
  byRot[rot] = stamp;
  return stamp;
}

const NO_SURFACE: RoadSurface = {
  minX: 0,
  minZ: 0,
  columns: 0,
  rows: 0,
  topSixteenths: new Int32Array(0),
  studSixteenths: new Int32Array(0),
  road: new Uint8Array(0),
  occupied: new Uint8Array(0),
};

class PlacedStamp implements FitKey {
  id = NO_PARTNER;
  stamp = stampOf(NO_SURFACE, 0);
  offsetX = 0;
  offsetZ = 0;
  phaseX = 0;
  phaseZ = 0;
  yLdu = 0;
  ySixteenths = 0;
  overlapping = false;

  get turn(): number {
    return this.stamp.turn;
  }

  get phase(): number {
    return this.phaseX * STUD_LDU + this.phaseZ;
  }

  at(placement: RoadPlacement): this {
    const { x, z, yLdu } = placement;
    if (!isLatticePose(x, z, 0) || !isInt32(yLdu)) {
      throw new RangeError(`road pose ${x}, ${yLdu}, ${z} is not whole LDU`);
    }
    if (!isInt32(sixteenthsOf(yLdu))) {
      throw new RangeError(`road height ${yLdu} LDU is beyond what sixteenths of an LDU can hold`);
    }
    this.id = placement.id;
    this.stamp = stampOf(placement.surface, placement.rot);
    const cornerX = x + this.stamp.anchorX;
    const cornerZ = z + this.stamp.anchorZ;
    this.offsetX = int32(latticeCell(cornerX));
    this.offsetZ = int32(latticeCell(cornerZ));
    this.phaseX = int32(cornerX - this.offsetX * STUD_LDU);
    this.phaseZ = int32(cornerZ - this.offsetZ * STUD_LDU);
    this.yLdu = int32(yLdu);
    this.ySixteenths = int32(sixteenthsOf(yLdu));
    this.overlapping = false;
    return this;
  }
}

class SeamLine {
  private pairs = 0;
  private openEdges = 0;
  private open = new Int32Array(FIRST_SEAM_CAPACITY);
  private edge = new Int32Array(FIRST_SEAM_CAPACITY);
  private along = new Int32Array(FIRST_SEAM_CAPACITY);
  private partner = new Int32Array(FIRST_SEAM_CAPACITY);
  private ownRoad = new Uint8Array(FIRST_SEAM_CAPACITY);
  private ownStud = new Float64Array(FIRST_SEAM_CAPACITY);
  private partnerRoad = new Uint8Array(FIRST_SEAM_CAPACITY);
  private partnerStud = new Float64Array(FIRST_SEAM_CAPACITY);
  private equal = new Uint8Array(FIRST_SEAM_CAPACITY);
  private run = new Int32Array(FIRST_SEAM_CAPACITY);
  private carries = new Uint8Array(FIRST_SEAM_CAPACITY);
  private status = new Uint8Array(FIRST_SEAM_CAPACITY);
  private stretchPartner = NO_PARTNER;
  private stretchAlong = 0;
  private stretch = 0;

  get pairCount(): number {
    return this.pairs;
  }

  get openCount(): number {
    return this.openEdges;
  }

  get mismatchCertain(): boolean {
    return this.stretch === CERTAIN_MISMATCH;
  }

  reset(): void {
    this.pairs = 0;
    this.openEdges = 0;
    this.stretchPartner = NO_PARTNER;
    this.stretch = 0;
  }

  pushOpen(edge: number): void {
    if (this.openEdges === this.open.length) {
      this.open = grown(this.open, new Int32Array(2 * this.open.length));
    }
    this.open[this.openEdges++] = edge;
  }

  push(
    edge: number,
    along: number,
    partner: number,
    ownRoad: number,
    ownStud: number,
    partnerRoad: number,
    partnerStud: number,
  ): void {
    if (this.pairs === this.edge.length) this.grow();
    const i = this.pairs++;
    this.edge[i] = edge;
    this.along[i] = along;
    this.partner[i] = partner;
    this.ownRoad[i] = ownRoad;
    this.ownStud[i] = ownStud;
    this.partnerRoad[i] = partnerRoad;
    this.partnerStud[i] = partnerStud;
    const equal = ownRoad === partnerRoad && ownStud === partnerStud;
    this.equal[i] = equal ? 1 : 0;
    if (partner !== this.stretchPartner || along > this.stretchAlong + 1) this.stretch = 0;
    this.stretchPartner = partner;
    this.stretchAlong = along;
    const carried = (ownRoad === 0 ? 0 : OWN_ROAD) | (partnerRoad === 0 ? 0 : PARTNER_ROAD);
    this.stretch |= carried | (equal ? 0 : UNEQUAL);
  }

  classify(): void {
    const runs = this.groupRuns();
    this.carries.fill(0, 0, runs);
    for (let i = 0; i < this.pairs; i++) {
      const run = this.run[i] ?? 0;
      const carried =
        (this.ownRoad[i] === 0 ? 0 : OWN_ROAD) | (this.partnerRoad[i] === 0 ? 0 : PARTNER_ROAD);
      this.carries[run] = (this.carries[run] ?? 0) | carried;
    }
    for (let i = 0; i < this.pairs; i++) {
      if (this.carries[this.run[i] ?? 0] === BOTH_ROAD) {
        this.status[i] = this.equalAt(i) ? JOINED : MISMATCHED;
      } else {
        this.status[i] = this.ownRoad[i] === 0 ? NO_STATUS : OPEN;
      }
    }
  }

  edgeOf(i: number): number {
    return this.edge[i] ?? 0;
  }

  openEdgeOf(i: number): number {
    return this.open[i] ?? 0;
  }

  partnerOf(i: number): number {
    return this.partner[i] ?? NO_PARTNER;
  }

  ownRoadOf(i: number): number {
    return this.ownRoad[i] ?? 0;
  }

  statusOf(i: number): number {
    return this.status[i] ?? NO_STATUS;
  }

  equalAt(i: number): boolean {
    return this.equal[i] === 1;
  }

  private groupRuns(): number {
    const pairs = this.pairs;
    this.run.fill(-1, 0, pairs);
    let runs = 0;
    for (let i = 0; i < pairs; i++) {
      if (this.run[i] !== -1) continue;
      const partner = this.partner[i] ?? NO_PARTNER;
      const run = runs++;
      this.run[i] = run;
      let last = this.along[i] ?? 0;
      for (let j = i + 1; j < pairs && (this.along[j] ?? 0) <= last + 1; j++) {
        if (this.run[j] !== -1 || this.partner[j] !== partner) continue;
        this.run[j] = run;
        last = this.along[j] ?? 0;
      }
    }
    return runs;
  }

  private grow(): void {
    const capacity = 2 * this.edge.length;
    this.edge = grown(this.edge, new Int32Array(capacity));
    this.along = grown(this.along, new Int32Array(capacity));
    this.partner = grown(this.partner, new Int32Array(capacity));
    this.ownRoad = grown(this.ownRoad, new Uint8Array(capacity));
    this.ownStud = grown(this.ownStud, new Float64Array(capacity));
    this.partnerRoad = grown(this.partnerRoad, new Uint8Array(capacity));
    this.partnerStud = grown(this.partnerStud, new Float64Array(capacity));
    this.equal = grown(this.equal, new Uint8Array(capacity));
    this.run = new Int32Array(capacity);
    this.carries = new Uint8Array(capacity);
    this.status = new Uint8Array(capacity);
  }
}

function grown<T extends Int32Array | Uint8Array | Float64Array>(from: T, to: T): T {
  to.set(from);
  return to;
}

interface EdgeCell {
  readonly placement: number;
  readonly side: RoadSide;
  readonly line: number;
  readonly along: number;
  readonly alongPhase: number;
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
    first.alongPhase === cell.alongPhase &&
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
        from: from * STUD_LDU + first.alongPhase,
        to: (previous + 1) * STUD_LDU + first.alongPhase,
        topLdu: first.topLdu,
        status: first.status,
      });
      from = next ?? 0;
    }
  }
  return segments;
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

function edgeCellOf(pose: PlacedStamp, edge: number, status: RoadCellStatus): EdgeCell {
  const stamp = pose.stamp;
  const cell = stamp.seamCell[edge] ?? 0;
  const side = stamp.seamSide[edge] ?? 0;
  const x = (stamp.column[cell] ?? 0) + pose.offsetX;
  const z = (stamp.row[cell] ?? 0) + pose.offsetZ;
  const across = acrossX(side);
  const lineCell = (across ? x : z) + (SIDE_LINE_OFFSET[side] ?? 0);
  return {
    placement: pose.id,
    side: SIDE_NAMES[side] ?? "minX",
    line: lineCell * STUD_LDU + (across ? pose.phaseX : pose.phaseZ),
    along: across ? z : x,
    alongPhase: across ? pose.phaseZ : pose.phaseX,
    topLdu: ((stamp.top[cell] ?? 0) + pose.ySixteenths) / SIXTEENTHS_PER_LDU,
    status,
  };
}

function byPair(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] - b[0] || a[1] - b[1];
}

export class RoadNetwork {
  private readonly grid = new RoadCellGrid();
  private readonly cursor = this.grid.cursor();
  private readonly seams = new SeamLine();
  private readonly probe = new PlacedStamp();
  private readonly poses: PlacedStamp[] = [];
  private readonly overlapPairs = new Map<string, readonly [number, number]>();
  private memo: RoadFitMemo | null = null;

  constructor(placements: ReadonlyArray<RoadPlacement>) {
    for (const placement of placements) this.add(placement);
  }

  add(placement: RoadPlacement): void {
    this.memo?.forget();
    const owner = this.poses.length;
    const pose = new PlacedStamp().at(placement);
    this.poses.push(pose);
    const stamp = pose.stamp;
    const phase = pose.phase;
    for (let c = 0; c < stamp.column.length; c++) {
      if (stamp.present[c] === 0) continue;
      const x = (stamp.column[c] ?? 0) + pose.offsetX;
      const z = (stamp.row[c] ?? 0) + pose.offsetZ;
      const top = (stamp.top[c] ?? 0) + pose.ySixteenths;
      for (let found = this.cursor.seek(x, z, top, phase); found; found = this.cursor.advance()) {
        this.recordOverlap(this.cursor.owner, pose);
      }
      const stud = raisedStud(stamp.stud[c] ?? NO_STUD, pose.ySixteenths);
      this.grid.claim(x, z, owner, top, phase, stud, stamp.road[c] ?? 0);
    }
  }

  clear(): void {
    this.memo?.forget();
    this.poses.length = 0;
    this.overlapPairs.clear();
    this.grid.clear();
  }

  report(): RoadJoinReport {
    const tally = new EdgeTally(new Int32Array(this.poses.length * PLACEMENT_CELL_INTS));
    for (let owner = 0; owner < this.poses.length; owner++) this.tallyPlacement(owner, tally);
    return {
      placements: this.poses.length,
      joinedCells: tally.joinedCells,
      openCells: tally.openCells,
      mismatchedCells: tally.mismatchedCells,
      placementCells: tally.placementCells,
      overlaps: [...this.overlapPairs.values()].toSorted(byPair),
      segments: mergeSegments(tally.edgeCells),
    };
  }

  placementJoin(id: number): RoadPlacementJoin {
    let mismatched = false;
    for (let owner = 0; owner < this.poses.length && !mismatched; owner++) {
      if (this.poses[owner]?.id === id) mismatched = this.mismatchesAt(owner);
    }
    let first: readonly [number, number] | null = null;
    for (const pair of this.overlapPairs.values()) {
      if (pair[0] !== id && pair[1] !== id) continue;
      if (first === null || byPair(pair, first) < 0) first = pair;
    }
    const overlapPartner = first === null ? null : first[0] === id ? first[1] : first[0];
    return { mismatched, overlapPartner };
  }

  private mismatchesAt(owner: number): boolean {
    const pose = this.poses[owner];
    if (!pose) return false;
    const seams = this.seams;
    for (let line = 0; line < pose.stamp.seamLineEnd.length; line++) {
      this.collectLine(pose, line, false);
      seams.classify();
      for (let i = 0; i < seams.pairCount; i++) {
        if (seams.statusOf(i) === MISMATCHED) return true;
      }
    }
    return false;
  }

  fit(candidate: RoadPlacement, into: RoadFit): RoadFit {
    const pose = this.probe.at(candidate);
    const memo = this.memoed();
    if (memo.recall(pose, into) === COMPLETE_FIT) return into;
    into.reset();
    if (this.reaches(pose)) {
      into.overlappingCells = this.occupiedCells(pose, false);
      pose.overlapping = into.overlappingCells > 0;
      this.countSeams(pose, into, false);
    }
    memo.remember(pose, COMPLETE_FIT, into);
    return into;
  }

  cleanFit(candidate: RoadPlacement, into: RoadFit): RoadFit | null {
    if (this.fitsCleanly(candidate, into) && into.joinedCells > 0) return into;
    into.reset();
    return null;
  }

  cleanContact(candidate: RoadPlacement, into: RoadFit): RoadFit | null {
    const clean = this.fitsCleanly(candidate, into);
    if (clean && into.metCells > 0 && into.equalCells === into.metCells) return into;
    into.reset();
    return null;
  }

  private fitsCleanly(candidate: RoadPlacement, into: RoadFit): boolean {
    const pose = this.probe.at(candidate);
    const memo = this.memoed();
    const known = memo.recall(pose, into);
    if (known === COMPLETE_FIT) return into.mismatchedCells === 0 && into.overlappingCells === 0;
    if (known === CLASHED_FIT) return false;
    into.reset();
    const clean = this.judgeCleanly(pose, into);
    memo.remember(pose, clean ? COMPLETE_FIT : CLASHED_FIT, into);
    return clean;
  }

  private judgeCleanly(pose: PlacedStamp, into: RoadFit): boolean {
    if (!this.reaches(pose)) return true;
    into.overlappingCells = this.occupiedCells(pose, true);
    if (into.overlappingCells > 0) return false;
    return this.countSeams(pose, into, true);
  }

  private memoed(): RoadFitMemo {
    this.memo ??= new RoadFitMemo();
    return this.memo;
  }

  private reaches(pose: PlacedStamp): boolean {
    return this.grid.reachesLevels(pose.stamp, pose.offsetX, pose.offsetZ, pose.ySixteenths);
  }

  private occupiedCells(pose: PlacedStamp, stopAtFirst: boolean): number {
    const { stamp, offsetX, offsetZ, ySixteenths } = pose;
    return this.grid.occupiedCells(stamp, offsetX, offsetZ, ySixteenths, pose.phase, stopAtFirst);
  }

  private countsPair(owner: number, partner: number): boolean {
    const own = this.poses[owner];
    const other = this.poses[partner];
    if (!own || !other) throw new Error(`road pair ${owner}, ${partner} has no placement`);
    return own.id < other.id || (own.id === other.id && owner < partner);
  }

  private recordOverlap(owner: number, pose: PlacedStamp): void {
    const other = this.poses[owner];
    if (!other) throw new Error(`road cell owner ${owner} has no placement`);
    other.overlapping = true;
    pose.overlapping = true;
    const pair = [Math.min(other.id, pose.id), Math.max(other.id, pose.id)] as const;
    const key = `${pair[0]},${pair[1]}`;
    if (!this.overlapPairs.has(key)) this.overlapPairs.set(key, pair);
  }

  private tallyPlacement(owner: number, tally: EdgeTally): void {
    const pose = this.poses[owner];
    if (!pose) return;
    const seams = this.seams;
    for (let line = 0; line < pose.stamp.seamLineEnd.length; line++) {
      this.collectLine(pose, line, false);
      seams.classify();
      for (let i = 0; i < seams.pairCount; i++) {
        const status = seams.statusOf(i);
        if (status === NO_STATUS) continue;
        if (status === OPEN) {
          tally.openCells++;
          tally.edgeCells.push(edgeCellOf(pose, seams.edgeOf(i), "open"));
          continue;
        }
        const joined = status === JOINED;
        const counted = this.countsPair(owner, seams.partnerOf(i));
        if (joined && counted) {
          tally.joinedCells++;
          tally.countPlacement(owner, PLACEMENT_JOINED);
        }
        if (!joined) {
          if (counted) tally.mismatchedCells++;
          tally.countPlacement(owner, PLACEMENT_MISMATCHED);
        }
        tally.edgeCells.push(edgeCellOf(pose, seams.edgeOf(i), joined ? "joined" : "mismatch"));
      }
      for (let i = 0; i < seams.openCount; i++) {
        tally.openCells++;
        tally.edgeCells.push(edgeCellOf(pose, seams.openEdgeOf(i), "open"));
      }
    }
  }

  private countSeams(pose: PlacedStamp, into: RoadFit, stopAtMismatch: boolean): boolean {
    const seams = this.seams;
    for (let line = 0; line < pose.stamp.seamLineEnd.length; line++) {
      this.collectLine(pose, line, stopAtMismatch);
      if (stopAtMismatch && seams.mismatchCertain) return false;
      seams.classify();
      into.metCells += seams.pairCount;
      for (let i = 0; i < seams.pairCount; i++) {
        if (seams.equalAt(i)) into.equalCells++;
        const status = seams.statusOf(i);
        if (status === MISMATCHED) into.mismatchedCells++;
        if (status !== JOINED) continue;
        into.joinedCells++;
        if (seams.ownRoadOf(i) !== 0) into.joinedRoadCells++;
      }
      if (stopAtMismatch && into.mismatchedCells > 0) return false;
    }
    return into.mismatchedCells === 0;
  }

  private collectLine(pose: PlacedStamp, line: number, stopAtMismatch: boolean): void {
    const stamp = pose.stamp;
    const offsetX = pose.offsetX;
    const offsetZ = pose.offsetZ;
    const ySixteenths = pose.ySixteenths;
    const phase = pose.phase;
    const seams = this.seams;
    const cursor = this.cursor;
    const from = line === 0 ? 0 : (stamp.seamLineEnd[line - 1] ?? 0);
    const to = stamp.seamLineEnd[line] ?? from;
    seams.reset();
    for (let e = from; e < to; e++) {
      const cell = stamp.seamCell[e] ?? 0;
      const side = stamp.seamSide[e] ?? 0;
      const x = (stamp.column[cell] ?? 0) + offsetX;
      const z = (stamp.row[cell] ?? 0) + offsetZ;
      const top = (stamp.top[cell] ?? 0) + ySixteenths;
      const road = stamp.road[cell] ?? 0;
      const along = acrossX(side) ? z : x;
      const neighbourX = x + (SIDE_DX[side] ?? 0);
      const neighbourZ = z + (SIDE_DZ[side] ?? 0);
      let met = false;
      for (
        let found = cursor.seek(neighbourX, neighbourZ, top, phase);
        found;
        found = cursor.advance()
      ) {
        const partner = cursor.owner;
        if (pose.overlapping && this.grid.holds(x, z, top, partner)) continue;
        const stud = raisedStud(stamp.stud[cell] ?? NO_STUD, ySixteenths);
        seams.push(e, along, partner, road, stud, cursor.road, cursor.stud);
        if (stopAtMismatch && seams.mismatchCertain) return;
        met = true;
      }
      if (!met && road !== 0 && stamp.seamClosed[e] === 0) seams.pushOpen(e);
    }
  }
}

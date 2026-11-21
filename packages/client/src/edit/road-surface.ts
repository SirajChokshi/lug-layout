import type { PartShapeAsset } from "@brr/catalog";
import {
  ALL_COORDINATES,
  AXIS_NEG_X,
  AXIS_NEG_Z,
  AXIS_POS_X,
  AXIS_POS_Y,
  AXIS_POS_Z,
  BOX_MAX_X,
  BOX_MAX_Y,
  BOX_MAX_Z,
  BOX_MIN_X,
  BOX_MIN_Z,
  IdentifiedPoint,
  NO_STUD,
  NO_TOP,
  TRANSFORM_FLOATS,
  coordinatesAcross,
  identifyDirection,
  identifyPoint,
  type PartInstances,
  type RoadSurface,
} from "@brr/domain";
import { IDENTIFICATION_ACCEPTED_DEVIATION_LDU, SIXTEENTHS_PER_LDU, STUD_LDU } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import type { PartTopSurface } from "@brr/schema/bundle";
import { BOX_FLOATS } from "./local-box.ts";

const CELL_SIXTEENTHS = STUD_LDU * SIXTEENTHS_PER_LDU;
const HALF_CELL_SIXTEENTHS = CELL_SIXTEENTHS / 2;
const IDENTIFIED_SIXTEENTHS = IDENTIFICATION_ACCEPTED_DEVIATION_LDU * SIXTEENTHS_PER_LDU;
const HEIGHT_ONLY = ALL_COORDINATES & ~coordinatesAcross(AXIS_POS_Y);
const OWN_TOP_ONLY = 1;
const SHARED_TOP = 2;
const FLAT_CELL = "f";
const POCKET_CELL = "p";
const NOT_ROAD = 0;
const FLAT_TOP = 1;
const POCKET = 2;
const Y_COLUMN = 1;
const STUD_X = 3;
const STUD_Y = 7;
const STUD_Z = 11;

const Z_AXIS_OF_QUARTER_TURN: ReadonlyMap<number, number> = new Map([
  [AXIS_POS_X, AXIS_POS_Z],
  [AXIS_NEG_Z, AXIS_POS_X],
  [AXIS_NEG_X, AXIS_NEG_Z],
  [AXIS_POS_Z, AXIS_NEG_X],
]);

export interface SurfaceGrid {
  readonly cellX0: number;
  readonly cellZ0: number;
  readonly width: number;
  readonly depth: number;
}

export interface RoadCells {
  readonly road: RoadSurface | null;
  readonly flatTopSixteenths: number | null;
}

function identifiedSixteenths(ldu: number): number | null {
  const sixteenths = ldu * SIXTEENTHS_PER_LDU;
  const whole = Math.round(sixteenths);
  return Math.abs(sixteenths - whole) <= IDENTIFIED_SIXTEENTHS ? whole + 0 : null;
}

function edgeSixteenths(ldu: number, outward: number): number {
  const identified = identifiedSixteenths(ldu);
  if (identified !== null) return identified;
  const sixteenths = ldu * SIXTEENTHS_PER_LDU;
  return outward < 0 ? Math.floor(sixteenths) : Math.ceil(sixteenths);
}

function transformOf(instances: PartInstances, instance: number): Float64Array {
  const at = instance * TRANSFORM_FLOATS;
  return instances.matrices.subarray(at, at + TRANSFORM_FLOATS);
}

function columnDirection(transform: Float64Array, matrix: ArrayLike<number>, column: number) {
  const x = matrix[column] ?? 0;
  const y = matrix[column + 4] ?? 0;
  const z = matrix[column + 8] ?? 0;
  const length = Math.hypot(x, y, z);
  return length === 0 ? null : identifyDirection(transform, x / length, y / length, z / length);
}

function uprightQuarterTurn(transform: Float64Array): boolean {
  if (identifyDirection(transform, 0, 1, 0) !== AXIS_POS_Y) return false;
  const x = identifyDirection(transform, 1, 0, 0);
  const z = identifyDirection(transform, 0, 0, 1);
  return Z_AXIS_OF_QUARTER_TURN.get(x) === z;
}

class SurfaceBuilder {
  private readonly minX: number;
  private readonly minZ: number;
  private readonly columns: number;
  private readonly rows: number;
  private readonly originX: number;
  private readonly originZ: number;
  private readonly top: Int32Array;
  private readonly stud: Int32Array;
  private readonly kind: Uint8Array;
  private readonly flat: Uint8Array;
  private readonly covered: Uint8Array;
  private readonly highest: Float64Array;
  private readonly below: Int32Array;
  private readonly reachingTop: Uint8Array;
  private readonly instanceTop: Int32Array;
  private readonly point = new IdentifiedPoint();

  constructor(grid: SurfaceGrid, instances: number) {
    this.minX = grid.cellX0 * STUD_LDU;
    this.minZ = grid.cellZ0 * STUD_LDU;
    this.originX = this.minX * SIXTEENTHS_PER_LDU;
    this.originZ = this.minZ * SIXTEENTHS_PER_LDU;
    this.columns = grid.width;
    this.rows = grid.depth;
    const cells = this.columns * this.rows;
    this.top = new Int32Array(cells).fill(NO_TOP);
    this.stud = new Int32Array(cells).fill(NO_STUD);
    this.kind = new Uint8Array(cells);
    this.flat = new Uint8Array(cells);
    this.covered = new Uint8Array(cells);
    this.highest = new Float64Array(cells).fill(Number.NEGATIVE_INFINITY);
    this.below = new Int32Array(cells).fill(NO_TOP);
    this.reachingTop = new Uint8Array(cells);
    this.instanceTop = new Int32Array(instances).fill(NO_TOP);
  }

  claimByBoxes(count: number, partBoxes: Float32Array): void {
    for (let i = 0; i < count; i++) {
      const boxTop = partBoxes[i * BOX_FLOATS + BOX_MAX_Y] ?? 0;
      this.instanceTop[i] = identifiedSixteenths(boxTop) ?? NO_TOP;
      this.forCellsUnder(partBoxes, i, (cell) => {
        this.covered[cell] = 1;
        this.highest[cell] = Math.max(this.highest[cell] ?? boxTop, boxTop);
      });
    }
    for (let cell = 0; cell < this.top.length; cell++) {
      if (this.covered[cell] === 0) continue;
      this.top[cell] = identifiedSixteenths(this.highest[cell] ?? 0) ?? NO_TOP;
    }
    for (let i = 0; i < count; i++) {
      const identified = this.instanceTop[i] ?? NO_TOP;
      const reach =
        identified === NO_TOP
          ? Math.ceil((partBoxes[i * BOX_FLOATS + BOX_MAX_Y] ?? 0) * SIXTEENTHS_PER_LDU)
          : identified;
      this.forCellsUnder(partBoxes, i, (cell) => {
        const cellTop = this.top[cell] ?? NO_TOP;
        if (cellTop === NO_TOP) return;
        if (reach < cellTop) this.below[cell] = Math.max(this.below[cell] ?? NO_TOP, reach);
        else this.reachingTop[cell] = Math.min(SHARED_TOP, (this.reachingTop[cell] ?? 0) + 1);
      });
    }
  }

  private forCellsUnder(partBoxes: Float32Array, instance: number, visit: (cell: number) => void) {
    const b = instance * BOX_FLOATS;
    const minX = edgeSixteenths(partBoxes[b + BOX_MIN_X] ?? 0, -1) - this.originX;
    const maxX = edgeSixteenths(partBoxes[b + BOX_MAX_X] ?? 0, 1) - this.originX;
    const minZ = edgeSixteenths(partBoxes[b + BOX_MIN_Z] ?? 0, -1) - this.originZ;
    const maxZ = edgeSixteenths(partBoxes[b + BOX_MAX_Z] ?? 0, 1) - this.originZ;
    const fromColumn = Math.max(0, Math.ceil((minX - HALF_CELL_SIXTEENTHS) / CELL_SIXTEENTHS));
    const toColumn = Math.min(
      this.columns - 1,
      Math.floor((maxX - HALF_CELL_SIXTEENTHS) / CELL_SIXTEENTHS),
    );
    const fromRow = Math.max(0, Math.ceil((minZ - HALF_CELL_SIXTEENTHS) / CELL_SIXTEENTHS));
    const toRow = Math.min(
      this.rows - 1,
      Math.floor((maxZ - HALF_CELL_SIXTEENTHS) / CELL_SIXTEENTHS),
    );
    for (let row = fromRow; row <= toRow; row++) {
      for (let column = fromColumn; column <= toColumn; column++) {
        visit(row * this.columns + column);
      }
    }
  }

  private cellAtSixteenths(x: number, z: number): number | null {
    const column = (x - this.originX - HALF_CELL_SIXTEENTHS) / CELL_SIXTEENTHS;
    const row = (z - this.originZ - HALF_CELL_SIXTEENTHS) / CELL_SIXTEENTHS;
    if (!Number.isInteger(column) || !Number.isInteger(row)) return null;
    if (column < 0 || row < 0 || column >= this.columns || row >= this.rows) return null;
    return row * this.columns + column;
  }

  readTopSurface(instance: number, transform: Float64Array, surface: PartTopSurface): void {
    if (!uprightQuarterTurn(transform)) return;
    const instanceTop = this.instanceTop[instance] ?? NO_TOP;
    if (instanceTop === NO_TOP) return;
    const [columns, rows] = surface.size;
    const y = surface.top / SIXTEENTHS_PER_LDU;
    for (let row = 0; row < rows; row++) {
      const codes = surface.cells[row] ?? "";
      for (let column = 0; column < columns; column++) {
        const code = codes[column];
        if (code !== FLAT_CELL && code !== POCKET_CELL) continue;
        const x =
          (surface.origin[0] + column * CELL_SIXTEENTHS + HALF_CELL_SIXTEENTHS) /
          SIXTEENTHS_PER_LDU;
        const z =
          (surface.origin[1] + row * CELL_SIXTEENTHS + HALF_CELL_SIXTEENTHS) / SIXTEENTHS_PER_LDU;
        if (!identifyPoint(transform, x, y, z, ALL_COORDINATES, this.point)) continue;
        const wx = this.point.sixteenths[0] ?? 0;
        const wy = this.point.sixteenths[1] ?? 0;
        const wz = this.point.sixteenths[2] ?? 0;
        const cell = this.cellAtSixteenths(wx, wz);
        if (cell === null || wy !== instanceTop || wy !== this.top[cell]) continue;
        if (code === FLAT_CELL) this.kind[cell] = FLAT_TOP;
        else if (this.kind[cell] !== FLAT_TOP) this.kind[cell] = POCKET;
      }
    }
  }

  closeTops(): void {
    for (let cell = 0; cell < this.kind.length; cell++) {
      this.flat[cell] = this.kind[cell] === FLAT_TOP ? 1 : 0;
    }
  }

  readStuds(instance: number, transform: Float64Array, part: PartShapeAsset): void {
    const m = part.studMatrices;
    const instanceTop = this.instanceTop[instance] ?? NO_TOP;
    for (let o = 0; o < m.length; o += INSTANCE_MATRIX_FLOATS) {
      if (columnDirection(transform, m, o + Y_COLUMN) !== AXIS_POS_Y) continue;
      const sx = m[o + STUD_X] ?? 0;
      const sy = m[o + STUD_Y] ?? 0;
      const sz = m[o + STUD_Z] ?? 0;
      if (identifyPoint(transform, sx, sy, sz, ALL_COORDINATES, this.point)) {
        this.placeStud(
          instanceTop,
          this.point.sixteenths[0] ?? 0,
          this.point.sixteenths[1] ?? 0,
          this.point.sixteenths[2] ?? 0,
        );
      } else {
        this.blockAround(transform, sx, sy, sz);
      }
    }
  }

  private nearCells(
    x: number,
    z: number,
    reach: number,
    visit: (cell: number, dx: number, dz: number) => void,
  ) {
    const nearColumn = Math.floor((x - this.originX) / CELL_SIXTEENTHS);
    const nearRow = Math.floor((z - this.originZ) / CELL_SIXTEENTHS);
    for (let row = Math.max(0, nearRow - 1); row <= Math.min(this.rows - 1, nearRow + 1); row++) {
      for (
        let column = Math.max(0, nearColumn - 1);
        column <= Math.min(this.columns - 1, nearColumn + 1);
        column++
      ) {
        const dx = x - (this.originX + column * CELL_SIXTEENTHS + HALF_CELL_SIXTEENTHS);
        const dz = z - (this.originZ + row * CELL_SIXTEENTHS + HALF_CELL_SIXTEENTHS);
        if (Math.abs(dx) >= reach || Math.abs(dz) >= reach) continue;
        visit(row * this.columns + column, dx, dz);
      }
    }
  }

  private placeStud(instanceTop: number, x: number, y: number, z: number): void {
    this.nearCells(x, z, CELL_SIXTEENTHS, (cell, dx, dz) => {
      const top = this.top[cell] ?? NO_TOP;
      if (top === NO_TOP) return;
      const centred = dx === 0 && dz === 0;
      if (y === top) {
        this.kind[cell] = NOT_ROAD;
        if (centred) this.stud[cell] = top;
        return;
      }
      const sunk =
        centred &&
        y < top &&
        instanceTop === top &&
        this.kind[cell] === POCKET &&
        this.reachingTop[cell] === OWN_TOP_ONLY &&
        (this.below[cell] ?? NO_TOP) <= y;
      if (sunk) this.stud[cell] = Math.max(this.stud[cell] ?? NO_STUD, y);
    });
  }

  private blockAround(transform: Float64Array, sx: number, sy: number, sz: number): void {
    const t = transform;
    const x = (t[0] ?? 0) * sx + (t[1] ?? 0) * sy + (t[2] ?? 0) * sz + (t[3] ?? 0);
    const y = (t[4] ?? 0) * sx + (t[5] ?? 0) * sy + (t[6] ?? 0) * sz + (t[7] ?? 0);
    const z = (t[8] ?? 0) * sx + (t[9] ?? 0) * sy + (t[10] ?? 0) * sz + (t[11] ?? 0);
    const height = identifyPoint(t, sx, sy, sz, HEIGHT_ONLY, this.point)
      ? (this.point.sixteenths[1] ?? 0)
      : null;
    this.nearCells(
      x * SIXTEENTHS_PER_LDU,
      z * SIXTEENTHS_PER_LDU,
      CELL_SIXTEENTHS + IDENTIFIED_SIXTEENTHS,
      (cell) => {
        const top = this.top[cell] ?? NO_TOP;
        if (top === NO_TOP) return;
        const atTop =
          height === null
            ? Math.abs(y * SIXTEENTHS_PER_LDU - top) <= IDENTIFIED_SIXTEENTHS
            : height === top;
        if (atTop) this.kind[cell] = NOT_ROAD;
      },
    );
  }

  private isPlanCorner(cell: number): boolean {
    const column = cell % this.columns;
    const row = Math.floor(cell / this.columns);
    return (column === 0 || column === this.columns - 1) && (row === 0 || row === this.rows - 1);
  }

  flatTop(): number | null {
    const first = this.top[0] ?? NO_TOP;
    if (first === NO_TOP || !this.flat.includes(1)) return null;
    for (let cell = 0; cell < this.top.length; cell++) {
      if (this.top[cell] !== first || this.covered[cell] === 0) return null;
      if (this.flat[cell] !== 1 && !this.isPlanCorner(cell)) return null;
    }
    return first;
  }

  surface(): RoadSurface | null {
    const road = new Uint8Array(this.kind.length);
    let roadCount = 0;
    for (let cell = 0; cell < road.length; cell++) {
      const kind = this.kind[cell];
      const isRoad =
        kind === FLAT_TOP || (kind === POCKET && (this.stud[cell] ?? NO_STUD) !== NO_STUD);
      if (!isRoad) continue;
      road[cell] = 1;
      roadCount++;
    }
    if (roadCount === 0) return null;
    return {
      minX: this.minX,
      minZ: this.minZ,
      columns: this.columns,
      rows: this.rows,
      topSixteenths: this.top,
      studSixteenths: this.stud,
      road,
    };
  }
}

export function roadCells(
  instances: PartInstances,
  partBoxes: Float32Array,
  grid: SurfaceGrid,
  parts: ReadonlyArray<PartShapeAsset>,
): RoadCells {
  const builder = new SurfaceBuilder(grid, instances.count);
  builder.claimByBoxes(instances.count, partBoxes);
  for (let i = 0; i < instances.count; i++) {
    const surface = parts[instances.partIndex[i] ?? 0]?.topSurface;
    if (surface) builder.readTopSurface(i, transformOf(instances, i), surface);
  }
  builder.closeTops();
  for (let i = 0; i < instances.count; i++) {
    const part = parts[instances.partIndex[i] ?? 0];
    if (part) builder.readStuds(i, transformOf(instances, i), part);
  }
  return { road: builder.surface(), flatTopSixteenths: builder.flatTop() };
}

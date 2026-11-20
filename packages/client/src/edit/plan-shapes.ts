import { EMPTY_COLUMN } from "@brr/catalog";
import { RECT_FLOATS, type PlanShape } from "@brr/domain";
import { STUD_LDU, isRot90, rot90Cos, rot90Sin, type Rot90 } from "@brr/math";
import { BOX_FLOATS } from "./local-box.ts";
import type { PlaceableCells } from "./placeable.ts";

const QUARTER_TURNS = 4;
const NO_CELL = -1;

export interface ShapeSource {
  readonly cells: PlaceableCells;
  readonly slabBoxes: Float32Array;
}

const cache = new WeakMap<ShapeSource, Array<PlanShape | null | undefined>>();

function occupied(cells: PlaceableCells, cell: number): boolean {
  return (cells.columnTop[cell] ?? EMPTY_COLUMN) !== EMPTY_COLUMN;
}

function meetsSlab(cells: PlaceableCells, slab: Float32Array, i: number, j: number): boolean {
  const minX = (cells.cellX0 + i) * STUD_LDU;
  const minZ = (cells.cellZ0 + j) * STUD_LDU;
  for (let b = 0; b < slab.length; b += BOX_FLOATS) {
    if (
      (slab[b] ?? 0) < minX + STUD_LDU &&
      minX < (slab[b + 3] ?? 0) &&
      (slab[b + 2] ?? 0) < minZ + STUD_LDU &&
      minZ < (slab[b + 5] ?? 0)
    ) {
      return true;
    }
  }
  return false;
}

function footingCells(source: ShapeSource): Uint8Array {
  const { cells, slabBoxes } = source;
  const chosen = new Uint8Array(cells.width * cells.depth);
  let lowest = Number.POSITIVE_INFINITY;
  let slabLevel = Number.POSITIVE_INFINITY;
  for (let j = 0; j < cells.depth; j++) {
    for (let i = 0; i < cells.width; i++) {
      const cell = j * cells.width + i;
      if (!occupied(cells, cell)) continue;
      const bottom = cells.columnBottom[cell] ?? 0;
      lowest = Math.min(lowest, bottom);
      if (!meetsSlab(cells, slabBoxes, i, j)) continue;
      chosen[cell] = 1;
      slabLevel = Math.min(slabLevel, bottom);
    }
  }
  for (let cell = 0; cell < chosen.length; cell++) {
    if (!occupied(cells, cell)) continue;
    const bottom = cells.columnBottom[cell];
    if (bottom === lowest || bottom === slabLevel) chosen[cell] = 1;
  }
  return chosen;
}

function occupancyCells(cells: PlaceableCells): Uint8Array {
  const chosen = new Uint8Array(cells.width * cells.depth);
  for (let cell = 0; cell < chosen.length; cell++) chosen[cell] = occupied(cells, cell) ? 1 : 0;
  return chosen;
}

function coverRects(cells: PlaceableCells, chosen: Uint8Array): number[] {
  const rects: number[] = [];
  const open = new Map<string, number>();
  for (let j = 0; j <= cells.depth; j++) {
    const continued = new Map<string, number>();
    for (let i = 0; j < cells.depth && i < cells.width; i++) {
      if (chosen[j * cells.width + i] !== 1) continue;
      let end = i;
      while (end + 1 < cells.width && chosen[j * cells.width + end + 1] === 1) end++;
      const key = `${i}:${end}`;
      const rect = open.get(key) ?? NO_CELL;
      if (rect === NO_CELL) {
        continued.set(key, rects.length);
        rects.push(i, j, end + 1, j + 1);
      } else {
        rects[rect + 3] = j + 1;
        continued.set(key, rect);
      }
      i = end;
    }
    open.clear();
    for (const [key, rect] of continued) open.set(key, rect);
  }
  return rects;
}

function turnedRects(
  cells: PlaceableCells,
  rects: ReadonlyArray<number>,
  rot: Rot90,
): Float64Array {
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const out = new Float64Array(rects.length);
  for (let r = 0; r < rects.length; r += RECT_FLOATS) {
    const loX = (cells.cellX0 + (rects[r] ?? 0)) * STUD_LDU;
    const loZ = (cells.cellZ0 + (rects[r + 1] ?? 0)) * STUD_LDU;
    const hiX = (cells.cellX0 + (rects[r + 2] ?? 0)) * STUD_LDU;
    const hiZ = (cells.cellZ0 + (rects[r + 3] ?? 0)) * STUD_LDU;
    const ax = cos * loX + sin * loZ + 0;
    const az = -sin * loX + cos * loZ + 0;
    const bx = cos * hiX + sin * hiZ + 0;
    const bz = -sin * hiX + cos * hiZ + 0;
    out[r] = Math.min(ax, bx);
    out[r + 1] = Math.min(az, bz);
    out[r + 2] = Math.max(ax, bx);
    out[r + 3] = Math.max(az, bz);
  }
  return out;
}

function buildShape(source: ShapeSource, rot: Rot90): PlanShape | null {
  const { cells } = source;
  const occupancy = coverRects(cells, occupancyCells(cells));
  if (occupancy.length === 0) return null;
  return {
    footing: turnedRects(cells, coverRects(cells, footingCells(source)), rot),
    occupancy: turnedRects(cells, occupancy, rot),
  };
}

export function planShapeOf(source: ShapeSource, rot: number): PlanShape | null {
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  let byTurn = cache.get(source);
  if (!byTurn) {
    byTurn = Array.from<PlanShape | null | undefined>({ length: QUARTER_TURNS });
    cache.set(source, byTurn);
  }
  const known = byTurn[rot];
  if (known !== undefined) return known;
  const shape = buildShape(source, rot);
  byTurn[rot] = shape;
  return shape;
}

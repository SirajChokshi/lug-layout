import type { LatticePose } from "@brr/domain";
import {
  CERTIFIED_RESIDUAL_LIMIT_LDU,
  PLATE_LDU,
  STUD_LDU,
  isRot90,
  rot90Cos,
  rot90Sin,
} from "@brr/math";

export const PART_BOX_FLOATS = 6;
export const RANGE_INTS = 4;
const X = 0;
const Y = 1;
const Z = 2;
const MAX = 3;
const FROM_X = 0;
const FROM_Z = 1;
const TO_X = 2;
const TO_Z = 3;

export interface CellGrid {
  readonly cellX0: number;
  readonly cellZ0: number;
  readonly width: number;
  readonly depth: number;
}

export interface PartBoxes extends CellGrid {
  readonly boxes: Float64Array;
  readonly cellStart: Int32Array;
  readonly cellInstance: Int32Array;
}

function identified(value: number): number {
  const whole = Math.round(value);
  return Math.abs(value - whole) <= CERTIFIED_RESIDUAL_LIMIT_LDU ? whole : value;
}

function firstCell(lo: number): number {
  return Math.floor(lo / STUD_LDU);
}

function endCell(hi: number): number {
  return Math.ceil(hi / STUD_LDU);
}

function cosOf(pose: LatticePose): number {
  return isRot90(pose.rot) ? rot90Cos(pose.rot) : 1;
}

function sinOf(pose: LatticePose): number {
  return isRot90(pose.rot) ? rot90Sin(pose.rot) : 0;
}

export function posedBox(
  boxes: Float64Array,
  instance: number,
  pose: LatticePose,
  out: Float64Array,
  at = 0,
): void {
  const b = instance * PART_BOX_FLOATS;
  const cos = cosOf(pose);
  const sin = sinOf(pose);
  const loX = boxes[b + X] ?? 0;
  const loZ = boxes[b + Z] ?? 0;
  const hiX = boxes[b + MAX + X] ?? 0;
  const hiZ = boxes[b + MAX + Z] ?? 0;
  const yLdu = pose.yPlates * PLATE_LDU;
  out[at + X] = Math.min(cos * loX, cos * hiX) + Math.min(sin * loZ, sin * hiZ) + pose.x;
  out[at + MAX + X] = Math.max(cos * loX, cos * hiX) + Math.max(sin * loZ, sin * hiZ) + pose.x;
  out[at + Z] = Math.min(-sin * loX, -sin * hiX) + Math.min(cos * loZ, cos * hiZ) + pose.z;
  out[at + MAX + Z] = Math.max(-sin * loX, -sin * hiX) + Math.max(cos * loZ, cos * hiZ) + pose.z;
  out[at + Y] = (boxes[b + Y] ?? 0) + yLdu;
  out[at + MAX + Y] = (boxes[b + MAX + Y] ?? 0) + yLdu;
}

export function localCellRange(
  grid: CellGrid,
  pose: LatticePose,
  cellX: number,
  cellZ: number,
  out: Int32Array,
): Int32Array {
  const cos = cosOf(pose);
  const sin = sinOf(pose);
  const x0 = cellX * STUD_LDU - pose.x;
  const z0 = cellZ * STUD_LDU - pose.z;
  const x1 = x0 + STUD_LDU;
  const z1 = z0 + STUD_LDU;
  const loX = Math.min(cos * x0, cos * x1) + Math.min(-sin * z0, -sin * z1);
  const hiX = Math.max(cos * x0, cos * x1) + Math.max(-sin * z0, -sin * z1);
  const loZ = Math.min(sin * x0, sin * x1) + Math.min(cos * z0, cos * z1);
  const hiZ = Math.max(sin * x0, sin * x1) + Math.max(cos * z0, cos * z1);
  out[FROM_X] = Math.max(grid.cellX0, Math.floor(loX / STUD_LDU));
  out[FROM_Z] = Math.max(grid.cellZ0, Math.floor(loZ / STUD_LDU));
  out[TO_X] = Math.min(grid.cellX0 + grid.width, Math.ceil(hiX / STUD_LDU));
  out[TO_Z] = Math.min(grid.cellZ0 + grid.depth, Math.ceil(hiZ / STUD_LDU));
  return out;
}

export function partBoxes(measured: ArrayLike<number>): PartBoxes {
  const count = Math.floor(measured.length / PART_BOX_FLOATS);
  const boxes = new Float64Array(count * PART_BOX_FLOATS);
  for (let k = 0; k < boxes.length; k++) boxes[k] = identified(measured[k] ?? 0);
  let x0 = 0;
  let z0 = 0;
  let x1 = 0;
  let z1 = 0;
  let any = false;
  for (let i = 0; i < count; i++) {
    const b = i * PART_BOX_FLOATS;
    const fromX = firstCell(boxes[b + X] ?? 0);
    const fromZ = firstCell(boxes[b + Z] ?? 0);
    const toX = endCell(boxes[b + MAX + X] ?? 0);
    const toZ = endCell(boxes[b + MAX + Z] ?? 0);
    if (toX <= fromX || toZ <= fromZ) continue;
    x0 = any ? Math.min(x0, fromX) : fromX;
    z0 = any ? Math.min(z0, fromZ) : fromZ;
    x1 = any ? Math.max(x1, toX) : toX;
    z1 = any ? Math.max(z1, toZ) : toZ;
    any = true;
  }
  const width = x1 - x0;
  const depth = z1 - z0;
  const cells = width * depth;
  const each = (visit: (cell: number, instance: number) => void): void => {
    for (let i = 0; i < count; i++) {
      const b = i * PART_BOX_FLOATS;
      const toX = endCell(boxes[b + MAX + X] ?? 0);
      const toZ = endCell(boxes[b + MAX + Z] ?? 0);
      for (let z = firstCell(boxes[b + Z] ?? 0); z < toZ; z++) {
        for (let x = firstCell(boxes[b + X] ?? 0); x < toX; x++) {
          visit((z - z0) * width + (x - x0), i);
        }
      }
    }
  };
  const cellStart = new Int32Array(cells + 1);
  each((cell) => {
    cellStart[cell + 1] = (cellStart[cell + 1] ?? 0) + 1;
  });
  for (let c = 0; c < cells; c++) cellStart[c + 1] = (cellStart[c + 1] ?? 0) + (cellStart[c] ?? 0);
  const cellInstance = new Int32Array(cellStart[cells] ?? 0);
  const filled = cellStart.slice(0, cells);
  each((cell, instance) => {
    cellInstance[filled[cell] ?? 0] = instance;
    filled[cell] = (filled[cell] ?? 0) + 1;
  });
  return { boxes, cellX0: x0, cellZ0: z0, width, depth, cellStart, cellInstance };
}

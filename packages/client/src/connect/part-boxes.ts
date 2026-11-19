import { CERTIFIED_RESIDUAL_LIMIT_LDU, STUD_LDU } from "@brr/math";

export const PART_BOX_FLOATS = 6;
const X = 0;
const Z = 2;
const MAX = 3;

export interface PartBoxes {
  readonly boxes: Float64Array;
  readonly cellX0: number;
  readonly cellZ0: number;
  readonly width: number;
  readonly depth: number;
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

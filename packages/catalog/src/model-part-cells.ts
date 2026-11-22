import { PART_CELL_BOX_INTS } from "@brr/schema/bundle";

const BAKED_X0 = 0;
const BAKED_Z0 = 1;
const BAKED_BOTTOM = 2;
const BAKED_X1 = 3;
const BAKED_Z1 = 4;
const BAKED_TOP = 5;
export const PART_CELL_PLAN_INTS = 4;
export const PART_CELL_HEIGHT_INTS = 2;

export interface ModelPartCells {
  readonly start: Int32Array;
  readonly instance: Uint32Array;
  readonly cellBox: Int16Array;
  readonly heightBox: Int32Array;
}

export function modelPartCells(
  cell: ArrayLike<number>,
  instance: ArrayLike<number>,
  boxes: ArrayLike<number>,
  cells: number,
  label: string,
): ModelPartCells {
  const count = cell.length;
  const start = new Int32Array(cells + 1);
  const instances = new Uint32Array(count);
  const cellBox = new Int16Array(count * PART_CELL_PLAN_INTS);
  const heightBox = new Int32Array(count * PART_CELL_HEIGHT_INTS);
  for (let k = 0; k < count; k++) {
    const at = cell[k] ?? 0;
    if (at >= cells || (k > 0 && at < (cell[k - 1] ?? 0))) {
      throw new Error(`${label} part cell ${k} is outside its grid or out of cell order`);
    }
    start[at + 1] = (start[at + 1] ?? 0) + 1;
    instances[k] = instance[k] ?? 0;
    const baked = k * PART_CELL_BOX_INTS;
    const plan = k * PART_CELL_PLAN_INTS;
    cellBox[plan] = boxes[baked + BAKED_X0] ?? 0;
    cellBox[plan + 1] = boxes[baked + BAKED_Z0] ?? 0;
    cellBox[plan + 2] = boxes[baked + BAKED_X1] ?? 0;
    cellBox[plan + 3] = boxes[baked + BAKED_Z1] ?? 0;
    heightBox[k * PART_CELL_HEIGHT_INTS] = boxes[baked + BAKED_BOTTOM] ?? 0;
    heightBox[k * PART_CELL_HEIGHT_INTS + 1] = boxes[baked + BAKED_TOP] ?? 0;
  }
  for (let c = 0; c < cells; c++) start[c + 1] = (start[c + 1] ?? 0) + (start[c] ?? 0);
  return { start, instance: instances, cellBox, heightBox };
}

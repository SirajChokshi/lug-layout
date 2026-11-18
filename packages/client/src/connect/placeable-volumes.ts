import { EMPTY_COLUMN } from "@brr/catalog";
import type { CellVolumes } from "@brr/domain";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import { BOX_FLOATS } from "../edit/local-box.ts";
import type { Placeable, PlaceableCells } from "../edit/placeable.ts";

function slabBottoms(cells: PlaceableCells, slabBoxes: Float32Array): Float64Array {
  const bottoms = new Float64Array(cells.width * cells.depth);
  for (let b = 0; b < slabBoxes.length; b += BOX_FLOATS) {
    const i0 = Math.max(0, Math.floor((slabBoxes[b] ?? 0) / STUD_LDU) - cells.cellX0);
    const i1 = Math.min(cells.width, Math.ceil((slabBoxes[b + 3] ?? 0) / STUD_LDU) - cells.cellX0);
    const j0 = Math.max(0, Math.floor((slabBoxes[b + 2] ?? 0) / STUD_LDU) - cells.cellZ0);
    const j1 = Math.min(cells.depth, Math.ceil((slabBoxes[b + 5] ?? 0) / STUD_LDU) - cells.cellZ0);
    const bottom = slabBoxes[b + 1] ?? 0;
    for (let j = j0; j < j1; j++) {
      for (let i = i0; i < i1; i++) {
        const c = j * cells.width + i;
        bottoms[c] = Math.min(bottoms[c] ?? 0, bottom);
      }
    }
  }
  return bottoms;
}

function copied(values: ArrayLike<number>, count: number): Int32Array {
  return Int32Array.from({ length: count }, (_, c) => values[c] ?? 0);
}

export class FrozenVolumes implements CellVolumes {
  private constructor(
    readonly count: number,
    readonly cellX: ArrayLike<number>,
    readonly cellZ: ArrayLike<number>,
    readonly bottomLdu: ArrayLike<number>,
    readonly topLdu: ArrayLike<number>,
  ) {}

  static copyOf(cells: CellVolumes): FrozenVolumes {
    return new FrozenVolumes(
      cells.count,
      copied(cells.cellX, cells.count),
      copied(cells.cellZ, cells.count),
      copied(cells.bottomLdu, cells.count),
      copied(cells.topLdu, cells.count),
    );
  }
}

export function placeableVolumes(placeable: Placeable): FrozenVolumes {
  const { cells, slabBoxes } = placeable;
  const slab = slabBottoms(cells, slabBoxes);
  let count = 0;
  for (let c = 0; c < cells.width * cells.depth; c++) {
    if ((cells.columnTop[c] ?? EMPTY_COLUMN) !== EMPTY_COLUMN) count++;
  }
  const cellX = new Int32Array(count);
  const cellZ = new Int32Array(count);
  const bottomLdu = new Int32Array(count);
  const topLdu = new Int32Array(count);
  let n = 0;
  for (let j = 0; j < cells.depth; j++) {
    for (let i = 0; i < cells.width; i++) {
      const c = j * cells.width + i;
      const top = cells.columnTop[c] ?? EMPTY_COLUMN;
      if (top === EMPTY_COLUMN) continue;
      const bottom = (cells.columnBottom[c] ?? 0) * PLATE_LDU;
      cellX[n] = cells.cellX0 + i;
      cellZ[n] = cells.cellZ0 + j;
      bottomLdu[n] = bottom === 0 ? Math.floor(slab[c] ?? 0) : bottom;
      topLdu[n] = top * PLATE_LDU;
      n++;
    }
  }
  return FrozenVolumes.copyOf({ count, cellX, cellZ, bottomLdu, topLdu });
}

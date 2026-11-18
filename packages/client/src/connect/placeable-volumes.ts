import { EMPTY_COLUMN } from "@brr/catalog";
import type { CellVolumes } from "@brr/domain";
import { PLATE_LDU } from "@brr/math";
import type { Placeable } from "../edit/placeable.ts";

export function placeableVolumes(placeable: Placeable): CellVolumes {
  const { cells, slabDepthLdu } = placeable;
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
      bottomLdu[n] = bottom === 0 ? -slabDepthLdu : bottom;
      topLdu[n] = top * PLATE_LDU;
      n++;
    }
  }
  return { count, cellX, cellZ, bottomLdu, topLdu };
}

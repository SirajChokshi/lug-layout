import { STUD_LDU } from "@brr/math";
import { BOX_FLOATS } from "./local-box.ts";
import type { PlacedModel } from "./placed-chunks.ts";

const CELL_KEY_STRIDE = 2 ** 26;
const CELL_KEY_OFFSET = 2 ** 25;
const ON_LATTICE = 1;

function cellKey(cellX: number, cellZ: number): number {
  return (cellX + CELL_KEY_OFFSET) * CELL_KEY_STRIDE + (cellZ + CELL_KEY_OFFSET);
}

function seatsAt(models: ReadonlyArray<PlacedModel>, baseLdu: number): Set<number> {
  const seats = new Set<number>();
  for (const model of models) {
    const onLattice = model.placeable.studLattice.onLattice;
    for (let i = 0; i < model.placeable.studs.count; i++) {
      if (onLattice[i] !== ON_LATTICE || model.studBaseLdu(i) !== baseLdu) continue;
      seats.add(cellKey(model.studCellX(i), model.studCellZ(i)));
    }
  }
  return seats;
}

function pushUnseated(
  rects: number[],
  seats: ReadonlySet<number>,
  minX: number,
  minZ: number,
  maxX: number,
  maxZ: number,
): void {
  const cellX0 = Math.floor(minX / STUD_LDU);
  const cellX1 = Math.ceil(maxX / STUD_LDU);
  const cellZ0 = Math.floor(minZ / STUD_LDU);
  const cellZ1 = Math.ceil(maxZ / STUD_LDU);
  for (let cellZ = cellZ0; cellZ < cellZ1; cellZ++) {
    let runStart: number | null = null;
    for (let cellX = cellX0; cellX <= cellX1; cellX++) {
      const unseated = cellX < cellX1 && !seats.has(cellKey(cellX, cellZ));
      if (unseated && runStart === null) runStart = cellX;
      if (!unseated && runStart !== null) {
        rects.push(
          Math.max(minX, runStart * STUD_LDU),
          Math.max(minZ, cellZ * STUD_LDU),
          Math.min(maxX, cellX * STUD_LDU),
          Math.min(maxZ, (cellZ + 1) * STUD_LDU),
        );
        runStart = null;
      }
    }
  }
}

export function trackObstacleRects(
  models: ReadonlyArray<PlacedModel>,
  trackRange: readonly [number, number],
): Float64Array {
  const [bottom, top] = trackRange;
  const seats = seatsAt(models, bottom);
  const rects: number[] = [];
  for (const model of models) {
    const boxes = model.worldPartBoxes();
    for (let b = 0; b < boxes.length; b += BOX_FLOATS) {
      const minX = boxes[b] ?? 0;
      const minY = boxes[b + 1] ?? 0;
      const minZ = boxes[b + 2] ?? 0;
      const maxX = boxes[b + 3] ?? 0;
      const maxY = boxes[b + 4] ?? 0;
      const maxZ = boxes[b + 5] ?? 0;
      if (minY < top && maxY > bottom) rects.push(minX, minZ, maxX, maxZ);
      else if (maxY === bottom) pushUnseated(rects, seats, minX, minZ, maxX, maxZ);
    }
  }
  return Float64Array.from(rects);
}

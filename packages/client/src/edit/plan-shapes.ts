import { RECT_FLOATS, type CellVolumes, type PlanShape } from "@brr/domain";
import { STUD_LDU, isRot90, rot90Cos, rot90Sin, type Rot90 } from "@brr/math";
import { FrozenVolumes, type PlaceableColumns } from "../connect/placeable-volumes.ts";
import type { PlaceableCells } from "./placeable.ts";

const QUARTER_TURNS = 4;
const NO_CELL = -1;
const NO_INSTANCES: ReadonlySet<number> = new Set();

export interface ShapeSource extends PlaceableColumns {
  readonly id: string;
  readonly cells: PlaceableColumns["cells"] & Pick<PlaceableCells, "footing">;
}

interface CellGrid {
  readonly cellX0: number;
  readonly cellZ0: number;
  readonly width: number;
  readonly depth: number;
}

interface CachedShapes {
  readonly volumes: CellVolumes;
  readonly without: ReadonlySet<number>;
  readonly byTurn: Array<PlanShape | null | undefined>;
}

function gridOf(volumes: CellVolumes): CellGrid {
  let x0 = Number.POSITIVE_INFINITY;
  let z0 = Number.POSITIVE_INFINITY;
  let x1 = Number.NEGATIVE_INFINITY;
  let z1 = Number.NEGATIVE_INFINITY;
  for (let c = 0; c < volumes.count; c++) {
    const x = volumes.cellX[c] ?? 0;
    const z = volumes.cellZ[c] ?? 0;
    x0 = Math.min(x0, x);
    z0 = Math.min(z0, z);
    x1 = Math.max(x1, x);
    z1 = Math.max(z1, z);
  }
  return { cellX0: x0, cellZ0: z0, width: x1 - x0 + 1, depth: z1 - z0 + 1 };
}

function chosenCells(
  volumes: CellVolumes,
  grid: CellGrid,
  keep: (cell: number) => boolean,
): Uint8Array {
  const chosen = new Uint8Array(grid.width * grid.depth);
  for (let c = 0; c < volumes.count; c++) {
    if (!keep(c)) continue;
    const i = (volumes.cellX[c] ?? 0) - grid.cellX0;
    const j = (volumes.cellZ[c] ?? 0) - grid.cellZ0;
    chosen[j * grid.width + i] = 1;
  }
  return chosen;
}

function footingCells(
  source: ShapeSource,
  grid: CellGrid,
  without: ReadonlySet<number>,
): Uint8Array {
  const { cells } = source;
  const { instance, cell } = cells.footing;
  const chosen = new Uint8Array(grid.width * grid.depth);
  for (let k = 0; k < cell.length; k++) {
    if (without.has(instance[k] ?? -1)) continue;
    const c = cell[k] ?? 0;
    const i = cells.cellX0 + (c % cells.width) - grid.cellX0;
    const j = cells.cellZ0 + Math.floor(c / cells.width) - grid.cellZ0;
    chosen[j * grid.width + i] = 1;
  }
  return chosen;
}

function coverRects(grid: CellGrid, chosen: Uint8Array): number[] {
  const rects: number[] = [];
  const open = new Map<string, number>();
  for (let j = 0; j <= grid.depth; j++) {
    const continued = new Map<string, number>();
    for (let i = 0; j < grid.depth && i < grid.width; i++) {
      if (chosen[j * grid.width + i] !== 1) continue;
      let end = i;
      while (end + 1 < grid.width && chosen[j * grid.width + end + 1] === 1) end++;
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

function turnedRects(grid: CellGrid, rects: ReadonlyArray<number>, rot: Rot90): Float64Array {
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const out = new Float64Array(rects.length);
  for (let r = 0; r < rects.length; r += RECT_FLOATS) {
    const loX = (grid.cellX0 + (rects[r] ?? 0)) * STUD_LDU;
    const loZ = (grid.cellZ0 + (rects[r + 1] ?? 0)) * STUD_LDU;
    const hiX = (grid.cellX0 + (rects[r + 2] ?? 0)) * STUD_LDU;
    const hiZ = (grid.cellZ0 + (rects[r + 3] ?? 0)) * STUD_LDU;
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

function buildShape(
  source: ShapeSource,
  volumes: CellVolumes,
  without: ReadonlySet<number>,
  rot: Rot90,
): PlanShape | null {
  if (volumes.count === 0) return null;
  const grid = gridOf(volumes);
  const occupancy = coverRects(
    grid,
    chosenCells(volumes, grid, () => true),
  );
  return {
    footing: turnedRects(grid, coverRects(grid, footingCells(source, grid, without)), rot),
    occupancy: turnedRects(grid, occupancy, rot),
  };
}

export class PlanShapes {
  private readonly byPlaceable = new Map<string, CachedShapes>();

  of(
    source: ShapeSource,
    rot: number,
    without: ReadonlySet<number> = NO_INSTANCES,
  ): PlanShape | null {
    if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
    let cached = this.byPlaceable.get(source.id);
    if (!cached || cached.without !== without) {
      cached = {
        volumes: FrozenVolumes.ofPlaceable(source),
        without,
        byTurn: Array.from<PlanShape | null | undefined>({ length: QUARTER_TURNS }),
      };
      this.byPlaceable.set(source.id, cached);
    }
    const known = cached.byTurn[rot];
    if (known !== undefined) return known;
    const shape = buildShape(source, cached.volumes, without, rot);
    cached.byTurn[rot] = shape;
    return shape;
  }
}

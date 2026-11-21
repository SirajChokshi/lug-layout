import { FootprintGrid, type CellVolumes, type LatticePose } from "@brr/domain";
import { PLATE_LDU, STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";

const HALF_STUD_LDU = STUD_LDU / 2;
const TURNS = 4;

export class CellBounds {
  cellX0 = 0;
  cellZ0 = 0;
  width = 0;
  depth = 0;

  measure(world: CellVolumes): this {
    let x0 = 0;
    let z0 = 0;
    let x1 = -1;
    let z1 = -1;
    for (let c = 0; c < world.count; c++) {
      const x = world.cellX[c] ?? 0;
      const z = world.cellZ[c] ?? 0;
      if (c === 0 || x < x0) x0 = x;
      if (c === 0 || z < z0) z0 = z;
      if (c === 0 || x > x1) x1 = x;
      if (c === 0 || z > z1) z1 = z;
    }
    this.cellX0 = x0;
    this.cellZ0 = z0;
    this.width = x1 - x0 + 1;
    this.depth = z1 - z0 + 1;
    return this;
  }
}

export class PosedCells implements CellVolumes {
  count = 0;
  cellX: Int32Array;
  cellZ: Int32Array;
  bottomLdu: Int32Array;
  topLdu: Int32Array;

  constructor(capacity: number) {
    this.cellX = new Int32Array(capacity);
    this.cellZ = new Int32Array(capacity);
    this.bottomLdu = new Int32Array(capacity);
    this.topLdu = new Int32Array(capacity);
  }

  place(local: CellVolumes, pose: LatticePose): this {
    if (this.cellX.length < local.count) {
      this.cellX = new Int32Array(local.count);
      this.cellZ = new Int32Array(local.count);
      this.bottomLdu = new Int32Array(local.count);
      this.topLdu = new Int32Array(local.count);
    }
    for (let c = 0; c < local.count; c++) placeCell(local, pose, c, this, c);
    this.count = local.count;
    return this;
  }
}

export function placeCell(
  local: CellVolumes,
  pose: LatticePose,
  c: number,
  out: PosedCells,
  at: number,
): void {
  const rot = isRot90(pose.rot) ? pose.rot : 0;
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const yLdu = pose.yPlates * PLATE_LDU;
  const cx = (local.cellX[c] ?? 0) * STUD_LDU + HALF_STUD_LDU;
  const cz = (local.cellZ[c] ?? 0) * STUD_LDU + HALF_STUD_LDU;
  out.cellX[at] = Math.floor((cos * cx + sin * cz + pose.x) / STUD_LDU);
  out.cellZ[at] = Math.floor((-sin * cx + cos * cz + pose.z) / STUD_LDU);
  out.bottomLdu[at] = (local.bottomLdu[c] ?? 0) + yLdu;
  out.topLdu[at] = (local.topLdu[c] ?? 0) + yLdu;
}

export class TurnedGrids<Key extends object> {
  private readonly grids = new Map<Key, Array<FootprintGrid | undefined>>();
  private readonly uses = new Map<FootprintGrid, number>();

  take(key: Key, rot: number, world: CellVolumes, bounds: CellBounds, yLdu: number): FootprintGrid {
    const turn = isRot90(rot) ? rot : 0;
    let byTurn = this.grids.get(key);
    if (!byTurn) {
      byTurn = Array.from<FootprintGrid | undefined>({ length: TURNS });
      this.grids.set(key, byTurn);
    }
    const { cellX0, cellZ0, width, depth } = bounds;
    let grid = byTurn[turn];
    if (!grid) {
      grid = FootprintGrid.of(world, cellX0, cellZ0, width, depth, yLdu);
      byTurn[turn] = grid;
    } else if (grid.width !== width || grid.depth !== depth) {
      throw new RangeError(`a placed footprint changed shape under translation`);
    }
    this.uses.set(grid, (this.uses.get(grid) ?? 0) + 1);
    return grid;
  }

  release(key: Key, rot: number, grid: FootprintGrid): void {
    const uses = (this.uses.get(grid) ?? 0) - 1;
    if (uses > 0) {
      this.uses.set(grid, uses);
      return;
    }
    this.uses.delete(grid);
    const byTurn = this.grids.get(key);
    if (!byTurn) return;
    byTurn[isRot90(rot) ? rot : 0] = undefined;
    for (let turn = 0; turn < TURNS; turn++) {
      if (byTurn[turn] !== undefined) return;
    }
    this.grids.delete(key);
  }
}

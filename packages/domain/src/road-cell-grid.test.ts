import { describe, expect, it } from "vitest";
import { RoadCellGrid } from "./road-cell-grid.ts";

const TOP = 128;
const PHASE = 0;
const STUD = 0;
const ROAD = 1;
const BLOCK_CELLS = 32;

function ownersAt(grid: RoadCellGrid, cellX: number, cellZ: number): ReadonlyArray<number> {
  const cursor = grid.cursor();
  const owners: number[] = [];
  for (let found = cursor.seek(cellX, cellZ, TOP, PHASE); found; found = cursor.advance()) {
    owners.push(cursor.owner);
  }
  return owners;
}

function claimed(owners: ReadonlyArray<number>): RoadCellGrid {
  const grid = new RoadCellGrid();
  for (const owner of owners) grid.claim(3, 5, owner, TOP, PHASE, STUD, ROAD);
  return grid;
}

describe("road cell grid", () => {
  it("keeps a cell's remaining claims in the order a grid given only those claims holds them, whichever claim goes", () => {
    const owners = [0, 1, 2, 3, 4];
    for (const gone of owners) {
      const grid = claimed(owners);
      grid.unclaim(3, 5, gone);
      expect(ownersAt(grid, 3, 5)).toEqual(
        ownersAt(claimed(owners.filter((o) => o !== gone)), 3, 5),
      );
    }
  });

  it("shows a cursor nothing on a block whose last claim went, even once that block holds claims somewhere else", () => {
    const grid = new RoadCellGrid();
    grid.claim(3, 5, 0, TOP, PHASE, STUD, ROAD);
    grid.claim(3 + BLOCK_CELLS, 5, 1, TOP, PHASE, STUD, ROAD);
    const cursor = grid.cursor();
    expect(cursor.seek(3, 5, TOP, PHASE)).toBe(true);
    grid.unclaim(3 + BLOCK_CELLS, 5, 1);
    grid.unclaim(3, 5, 0);
    grid.claim(3 + 4 * BLOCK_CELLS, 5, 2, TOP, PHASE, STUD, ROAD);
    expect(cursor.seek(3, 5, TOP, PHASE)).toBe(false);
    expect(ownersAt(grid, 3 + 4 * BLOCK_CELLS, 5)).toEqual([2]);
  });
});

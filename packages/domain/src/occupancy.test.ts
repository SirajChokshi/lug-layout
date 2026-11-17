import { describe, expect, it } from "vitest";
import { OccupancyGrid, cellChunkKey } from "./occupancy.ts";

describe("OccupancyGrid", () => {
  it("keeps the highest column top per cell and addresses cells on both sides of zero", () => {
    const grid = new OccupancyGrid();
    grid.raise(-1, -1, 12);
    grid.raise(-1, -1, 5);
    grid.raise(0, 0, 3);

    expect(grid.topAt(-1, -1)).toBe(12);
    expect(grid.topAt(0, 0)).toBe(3);
    expect(grid.topAt(-33, -1)).toBe(0);
    expect(cellChunkKey(-1, -1)).not.toBe(cellChunkKey(0, 0));
  });

  it("forgets only the cleared chunk", () => {
    const grid = new OccupancyGrid();
    grid.raise(31, 0, 7);
    grid.raise(32, 0, 9);
    grid.clearChunk(cellChunkKey(31, 0));

    expect(grid.topAt(31, 0)).toBe(0);
    expect(grid.topAt(32, 0)).toBe(9);
  });

  it("refuses a column top that does not fit the grid", () => {
    const grid = new OccupancyGrid();
    expect(() => grid.raise(0, 0, -1)).toThrow(RangeError);
    expect(() => grid.raise(0, 0, 1.5)).toThrow(RangeError);
  });
});

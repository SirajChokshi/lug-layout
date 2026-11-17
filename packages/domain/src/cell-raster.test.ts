import { describe, expect, it } from "vitest";
import { STUD_LDU } from "@brr/math";
import { placedPlanCells, planTriangleCells } from "./cell-raster.ts";

function cellList(triangles: ReadonlyArray<number>): string[] {
  const cells = planTriangleCells(Float64Array.from(triangles));
  return Array.from(cells.cellX, (x, i) => `${x},${cells.cellZ[i]}`);
}

function square(x0: number, z0: number, x1: number, z1: number): number[] {
  return [x0, z0, x1, z0, x1, z1, x0, z0, x1, z1, x0, z1];
}

describe("planTriangleCells", () => {
  it("covers a square lying exactly on cell edges and none of its neighbours", () => {
    expect(cellList(square(0, 0, 2 * STUD_LDU, STUD_LDU))).toEqual(["0,0", "1,0"]);
    expect(cellList(square(-STUD_LDU, -STUD_LDU, 0, 0))).toEqual(["-1,-1"]);
  });

  it("only counts overlap beyond the representation epsilon", () => {
    expect(cellList(square(0, 0, STUD_LDU + 1e-7, STUD_LDU))).toEqual(["0,0"]);
    expect(cellList(square(0, 0, STUD_LDU + 1e-3, STUD_LDU))).toEqual(["0,0", "1,0"]);
  });

  it("covers the four cells a diamond on a cell corner reaches, and no zero-area face", () => {
    const h = STUD_LDU / 2;
    const diamond = [0, -h, h, 0, 0, h, 0, -h, 0, h, -h, 0];
    expect(cellList(diamond)).toEqual(["-1,-1", "-1,0", "0,-1", "0,0"]);
    expect(cellList([0, 0, 3 * STUD_LDU, 0, 6 * STUD_LDU, 0])).toEqual([]);
  });

  it("keeps only the part inside the clip half-planes, with the same epsilon at the clip line", () => {
    const strip = Float64Array.from(square(0, 0, 2 * STUD_LDU, STUD_LDU));
    const at = { cos: 1, sin: 0, x: 0, z: 0 };
    const clipped = (limit: number): string[] => {
      const cells = placedPlanCells(strip, at, Float64Array.of(1, 0, limit));
      return Array.from(cells.cellX, (x, i) => `${x},${cells.cellZ[i]}`);
    };
    expect(clipped(STUD_LDU)).toEqual(["0,0"]);
    expect(clipped(STUD_LDU + 1e-7)).toEqual(["0,0"]);
    expect(clipped(STUD_LDU + 1)).toEqual(["0,0", "1,0"]);
  });
});

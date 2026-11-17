import { describe, expect, it } from "vitest";
import { OccupancyGrid } from "./occupancy.ts";
import {
  SupportGrid,
  firstLayerSupport,
  trackSupport,
  upperSupport,
  type BaseCells,
} from "./support.ts";

function cells(list: ReadonlyArray<readonly [number, number, 0 | 1]>): BaseCells {
  return {
    count: list.length,
    cellX: Int32Array.from(list.map(([x]) => x)),
    cellZ: Int32Array.from(list.map(([, z]) => z)),
    flat: Uint8Array.from(list.map(([, , flat]) => flat)),
  };
}

function baseplate(support: SupportGrid, x0: number, z0: number, size: number): void {
  for (let z = z0; z < z0 + size; z++) {
    for (let x = x0; x < x0 + size; x++) {
      support.markBaseplate(x, z);
      support.raiseStud(x, z, 0);
    }
  }
}

describe("upperSupport", () => {
  const occupancy = new OccupancyGrid();
  const support = new SupportGrid();
  baseplate(support, 0, 0, 4);
  occupancy.raise(10, 0, 3);
  support.cover(10, 0);
  support.cover(-5, 0);

  it.each([
    ["an anti-stud over a baseplate stud", [[1, 1, 0]], 0, "studs"],
    ["a solid bottom over baseplate studs", [[1, 1, 1]], 0, "flat-on-studs"],
    [
      "a footprint half on the baseplate, half over the table",
      [
        [3, 0, 0],
        [4, 0, 0],
      ],
      0,
      "studs",
    ],
    [
      "a footprint entirely over the bare table",
      [
        [20, 20, 0],
        [21, 20, 0],
      ],
      0,
      "on-table",
    ],
    ["a footprint on a stud-free top at its height", [[10, 0, 0]], 3, "flat"],
    ["a footprint floating above the baseplate studs", [[1, 1, 0]], 1, "no-studs-engaged"],
    ["a model with no base at all", [], 0, "no-base"],
  ] as const)("%s", (_name, list, yPlates, kind) => {
    expect(upperSupport(cells(list), yPlates, occupancy, support).kind).toBe(kind);
  });
});

describe("firstLayerSupport", () => {
  it("is blocked only where something already stands above the datum on a cell it rises into", () => {
    const occupancy = new OccupancyGrid();
    occupancy.raise(2, 2, 0);
    const plate = cells([
      [1, 1, 0],
      [2, 2, 0],
    ]);
    expect(firstLayerSupport(plate, occupancy).kind).toBe("on-table");
    occupancy.raise(2, 2, 2);
    expect(firstLayerSupport(plate, occupancy)).toEqual({
      kind: "blocked",
      cellX: 2,
      cellZ: 2,
      topPlates: 2,
    });
  });
});

describe("trackSupport", () => {
  it("lists exactly the cells with no baseplate under them, never a covered non-baseplate cell", () => {
    const support = new SupportGrid();
    baseplate(support, -2, -2, 2);
    support.cover(1, -1);
    const run = cells([
      [-1, -1, 0],
      [0, -1, 0],
      [1, -1, 0],
    ]);
    const verdict = trackSupport(run, support);
    expect(verdict.kind).toBe("off-baseplate");
    if (verdict.kind !== "off-baseplate") return;
    expect([...verdict.missing.cellX]).toEqual([0, 1]);
    expect(trackSupport(cells([[-1, -2, 0]]), support).kind).toBe("on-baseplate");
  });
});

import { Container } from "inversify";
import { describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { SHEET_TILER } from "../tokens.ts";
import type { Box, Point } from "./draw-list.ts";
import { columnName, type TileGrid } from "./tile-grid.ts";

const container = new Container();
container.load(
  ...mainThreadModules({
    bundleBaseUrl: "unused",
    disclaimer: "unused",
    startSimWorker: () => new MessageChannel().port1,
  }),
);
const tiler = container.get(SHEET_TILER);

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const EXACT = 1e-9;
const REACH = 0.45;

function inside(point: Point, box: Box, margin: number): boolean {
  return (
    point[0] - margin >= box.x - EXACT &&
    point[0] + margin <= box.x + box.width + EXACT &&
    point[1] - margin >= box.y - EXACT &&
    point[1] + margin <= box.y + box.height + EXACT
  );
}

function windows(grid: TileGrid): Box[] {
  const all: Box[] = [];
  for (let row = 0; row < grid.rows; row++) {
    for (let column = 0; column < grid.columns; column++) all.push(grid.window(column, row));
  }
  return all;
}

const random = seeded(48_117);
const CASES = Array.from({ length: 300 }, () => {
  const window = { widthMm: 100 + random() * 300, heightMm: 100 + random() * 300 };
  return {
    extent: {
      x: random() * 400 - 200,
      y: random() * 400 - 200,
      width: random() < 0.1 ? window.widthMm * random() : 1 + random() * 3000,
      height: random() < 0.1 ? window.heightMm * random() : 1 + random() * 3000,
    },
    window,
    overlapMm: 5 + random() * 25,
  };
});

describe("SheetTiler", () => {
  it("covers the drawing with the fewest pages, centred, each overlapping its neighbour by exactly the overlap", () => {
    for (const { extent, window, overlapMm } of CASES) {
      const grid = tiler.tile(extent, window, overlapMm);
      const covered = grid.covered;
      const step = window.widthMm - overlapMm;
      const stepY = window.heightMm - overlapMm;
      expect(covered.x).toBeLessThanOrEqual(extent.x + EXACT);
      expect(covered.y).toBeLessThanOrEqual(extent.y + EXACT);
      expect(covered.x + covered.width).toBeGreaterThanOrEqual(extent.x + extent.width - EXACT);
      expect(covered.y + covered.height).toBeGreaterThanOrEqual(extent.y + extent.height - EXACT);
      expect(covered.x - extent.x).toBeCloseTo(
        extent.x + extent.width - (covered.x + covered.width),
        9,
      );
      expect(grid.columns === 1 || (grid.columns - 2) * step + window.widthMm < extent.width).toBe(
        true,
      );
      expect(grid.rows === 1 || (grid.rows - 2) * stepY + window.heightMm < extent.height).toBe(
        true,
      );
      for (let column = 0; column + 1 < grid.columns; column++) {
        const left = grid.window(column, 0);
        const right = grid.window(column + 1, 0);
        expect(left.x + left.width - right.x).toBeCloseTo(overlapMm, 9);
      }
      for (let row = 0; row + 1 < grid.rows; row++) {
        const top = grid.window(0, row);
        const below = grid.window(0, row + 1);
        expect(top.y + top.height - below.y).toBeCloseTo(overlapMm, 9);
      }
    }
  });

  it("gives every page a cell that partitions the covered area along the seams, inside its own window", () => {
    for (const { extent, window, overlapMm } of CASES.slice(0, 60)) {
      const grid = tiler.tile(extent, window, overlapMm);
      let area = 0;
      for (let row = 0; row < grid.rows; row++) {
        for (let column = 0; column < grid.columns; column++) {
          const cell = grid.cell(column, row);
          const own = grid.window(column, row);
          area += cell.width * cell.height;
          expect(inside([cell.x, cell.y], own, 0)).toBe(true);
          expect(inside([cell.x + cell.width, cell.y + cell.height], own, 0)).toBe(true);
          const next = column + 1 < grid.columns ? grid.cell(column + 1, row) : null;
          expect(next === null || Math.abs(next.x - (cell.x + cell.width)) < EXACT).toBe(true);
        }
      }
      expect(area).toBeCloseTo(grid.covered.width * grid.covered.height, 6);
    }
  });

  it("puts registration marks on the seams where both neighbours print them whole, at least two on every shared edge", () => {
    for (const { extent, window, overlapMm } of CASES) {
      const grid = tiler.tile(extent, window, overlapMm);
      const reach = overlapMm * REACH;
      const all = windows(grid);
      const seamsX = grid.seamsX();
      const seamsY = grid.seamsY();
      for (const mark of grid.marks()) {
        const onSeam =
          seamsX.some((x) => Math.abs(x - mark[0]) < EXACT) ||
          seamsY.some((y) => Math.abs(y - mark[1]) < EXACT);
        expect(onSeam).toBe(true);
        expect(all.filter((box) => inside(mark, box, reach)).length).toBeGreaterThanOrEqual(2);
      }
      for (let row = 0; row < grid.rows; row++) {
        for (let column = 0; column < grid.columns; column++) {
          const own = grid.window(column, row);
          const neighbours = [
            column + 1 < grid.columns ? grid.window(column + 1, row) : null,
            row + 1 < grid.rows ? grid.window(column, row + 1) : null,
          ];
          for (const other of neighbours.filter((box) => box !== null)) {
            const shared = grid
              .marks()
              .filter((mark) => inside(mark, own, reach) && inside(mark, other, reach));
            expect(shared.length).toBeGreaterThanOrEqual(2);
          }
        }
      }
    }
  });

  it("refuses an overlap that leaves a page no room of its own", () => {
    const extent = { x: 0, y: 0, width: 1000, height: 1000 };
    expect(() => tiler.tile(extent, { widthMm: 190, heightMm: 250 }, 95)).toThrow(RangeError);
    expect(() => tiler.tile(extent, { widthMm: 190, heightMm: 250 }, -1)).toThrow(RangeError);
    expect(tiler.tile(extent, { widthMm: 190, heightMm: 250 }, 94.9).count).toBeGreaterThan(1);
  });

  it("names pages by column letters and row numbers, as a spreadsheet does", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnName)).toEqual([
      "A",
      "B",
      "Z",
      "AA",
      "AB",
      "AZ",
      "BA",
      "ZZ",
      "AAA",
    ]);
  });
});

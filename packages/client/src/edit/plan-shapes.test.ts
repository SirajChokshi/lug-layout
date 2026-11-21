import { EMPTY_COLUMN } from "@brr/catalog";
import { STUD_LDU } from "@brr/math";
import { describe, expect, it } from "vitest";
import type { PlaceableCells } from "./placeable.ts";
import type { PlaceableColumns } from "../connect/placeable-volumes.ts";
import { planShapeOf } from "./plan-shapes.ts";

const _ = EMPTY_COLUMN;

function source(
  width: number,
  rows: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
): PlaceableColumns {
  const flat = rows.flat();
  const cells: PlaceableCells = {
    cellX0: -1,
    cellZ0: 0,
    width,
    depth: rows.length,
    footprint: Uint8Array.from(flat, ([, top]) => (top === _ ? 0 : 1)),
    columnBottom: Int16Array.from(flat, ([bottom]) => bottom),
    columnTop: Int16Array.from(flat, ([, top]) => top),
    parts: {
      start: new Int32Array(flat.length + 1),
      instance: new Uint32Array(0),
      cellBox: new Int16Array(0),
      heightBox: new Int32Array(0),
    },
    footprintCells: flat.filter(([, top]) => top !== _).length,
    flatCells: 0,
    heightPlates: 3,
  };
  return { cells, slabBoxes: new Float32Array(0) };
}

function studs(rects: Float64Array | undefined): number[] {
  return Array.from(rects ?? [], (ldu) => ldu / STUD_LDU);
}

describe("planShapeOf", () => {
  it("keeps a U's two feet as its footing and covers the U exactly, never its bounding box", () => {
    const arch = source(3, [
      [
        [0, 3],
        [2, 3],
        [0, 3],
      ],
      [
        [0, 3],
        [0, _],
        [0, 3],
      ],
    ]);
    const shape = planShapeOf(arch, 0);
    expect({ footing: studs(shape?.footing), occupancy: studs(shape?.occupancy) }).toEqual({
      footing: [-1, 0, 0, 2, 1, 0, 2, 2],
      occupancy: [-1, 0, 2, 1, -1, 1, 0, 2, 1, 1, 2, 2],
    });
  });

  it("keeps every occupied cell at or below the rest plane, however deep, leaves out cells that start above it, and falls back to the lowest layer", () => {
    const deep = source(3, [
      [
        [0, 1],
        [-1, 1],
        [-2, 1],
      ],
    ]);
    const overhang = source(3, [
      [
        [0, 3],
        [0, 3],
        [2, 3],
      ],
    ]);
    const raised = source(2, [
      [
        [3, 5],
        [5, 6],
      ],
    ]);
    expect([deep, overhang, raised].map((shape) => studs(planShapeOf(shape, 0)?.footing))).toEqual([
      [-1, 0, 2, 1],
      [-1, 0, 1, 1],
      [-1, 0, 0, 1],
    ]);
  });

  it("turns the rects a quarter about the placement point and shares one shape per turn", () => {
    const bar = source(2, [
      [
        [0, 3],
        [0, 3],
      ],
    ]);
    expect(studs(planShapeOf(bar, 1)?.occupancy)).toEqual([0, -1, 1, 1]);
    expect(planShapeOf(bar, 1)).toBe(planShapeOf(bar, 1));
  });
});

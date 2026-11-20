import { EMPTY_COLUMN } from "@brr/catalog";
import { STUD_LDU } from "@brr/math";
import { describe, expect, it } from "vitest";
import type { PlaceableCells } from "./placeable.ts";
import { planShapeOf, type ShapeSource } from "./plan-shapes.ts";

const _ = EMPTY_COLUMN;

function source(
  width: number,
  rows: ReadonlyArray<ReadonlyArray<readonly [number, number]>>,
  slab: ReadonlyArray<number> = [],
): ShapeSource {
  const flat = rows.flat();
  const cells: PlaceableCells = {
    cellX0: -1,
    cellZ0: 0,
    width,
    depth: rows.length,
    footprint: Uint8Array.from(flat, ([, top]) => (top === _ ? 0 : 1)),
    columnBottom: Int16Array.from(flat, ([bottom]) => bottom),
    columnTop: Int16Array.from(flat, ([, top]) => top),
    footprintCells: flat.filter(([, top]) => top !== _).length,
    flatCells: 0,
    heightPlates: 3,
  };
  return { cells, slabBoxes: Float32Array.from(slab) };
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

  it("keeps a slab in the footing when a protrusion hangs lower, and the lowest layer when the slab box meets only part of it", () => {
    const hanging = source(
      2,
      [
        [
          [0, 1],
          [-2, 1],
        ],
      ],
      [-STUD_LDU, -4, 0, STUD_LDU, 0, STUD_LDU],
    );
    const overshoot = source(
      2,
      [
        [
          [0, 3],
          [0, 3],
        ],
      ],
      [-STUD_LDU, -0.125, 0, 0, 0, STUD_LDU],
    );
    expect([
      studs(planShapeOf(hanging, 0)?.footing),
      studs(planShapeOf(overshoot, 0)?.footing),
    ]).toEqual([
      [-1, 0, 1, 1],
      [-1, 0, 1, 1],
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

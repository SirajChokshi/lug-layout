import { EMPTY_COLUMN } from "@brr/catalog";
import { STUD_LDU } from "@brr/math";
import { describe, expect, it } from "vitest";
import type { PlaceableCells } from "./placeable.ts";
import { PlanShapes, type ShapeSource } from "./plan-shapes.ts";

const _ = EMPTY_COLUMN;

type Footing = ReadonlyArray<readonly [instance: number, i: number, j: number]>;

function source(
  id: string,
  width: number,
  rows: ReadonlyArray<ReadonlyArray<number>>,
  footing: Footing,
): ShapeSource {
  const tops = rows.flat();
  const cells: PlaceableCells = {
    cellX0: -1,
    cellZ0: 0,
    width,
    depth: rows.length,
    footprint: Uint8Array.from(tops, (top) => (top === _ ? 0 : 1)),
    columnBottom: Int16Array.from(tops, () => 0),
    columnTop: Int16Array.from(tops),
    footing: {
      instance: Uint32Array.from(footing, ([instance]) => instance),
      cell: Uint32Array.from(footing, ([, i, j]) => j * width + i),
    },
    parts: {
      start: new Int32Array(tops.length + 1),
      instance: new Uint32Array(0),
      cellBox: new Int16Array(0),
      heightBox: new Int32Array(0),
    },
    footprintCells: tops.filter((top) => top !== _).length,
    flatCells: 0,
    heightPlates: 3,
  };
  return { id, cells, slabBoxes: new Float32Array(0) };
}

function studs(rects: Float64Array | undefined): number[] {
  return Array.from(rects ?? [], (ldu) => ldu / STUD_LDU);
}

describe("PlanShapes", () => {
  it("takes the footing from the cells each instance stands in, and covers the U exactly, never its bounding box", () => {
    const arch = source(
      "arch",
      3,
      [
        [3, 3, 3],
        [3, _, 3],
      ],
      [
        [0, 0, 0],
        [0, 0, 1],
        [1, 2, 0],
        [1, 2, 1],
      ],
    );
    const shape = new PlanShapes().of(arch, 0);
    expect({ footing: studs(shape?.footing), occupancy: studs(shape?.occupancy) }).toEqual({
      footing: [-1, 0, 0, 2, 1, 0, 2, 2],
      occupancy: [-1, 0, 2, 1, -1, 1, 0, 2, 1, 1, 2, 2],
    });
  });

  it("leaves out the cells only the left-out instances stand in, keeping a cell another instance shares", () => {
    const run = source(
      "run",
      4,
      [[1, 1, 1, 3]],
      [
        [0, 0, 0],
        [0, 1, 0],
        [1, 1, 0],
        [1, 2, 0],
        [1, 3, 0],
        [2, 3, 0],
      ],
    );
    const shapes = new PlanShapes();
    const track = new Set([0, 1]);
    expect(studs(shapes.of(run, 0)?.footing)).toEqual([-1, 0, 3, 1]);
    expect(studs(shapes.of(run, 0, track)?.footing)).toEqual([2, 0, 3, 1]);
    expect(studs(shapes.of(run, 0, new Set([0, 1, 2]))?.footing)).toEqual([]);
    expect(studs(shapes.of(run, 0, track)?.occupancy)).toEqual([-1, 0, 3, 1]);
  });

  it("turns the rects a quarter about the placement point and shares one shape per placeable id, turn and left-out set", () => {
    const bar = source(
      "bar",
      2,
      [[3, 3]],
      [
        [0, 0, 0],
        [0, 1, 0],
      ],
    );
    const shapes = new PlanShapes();
    const none = new Set<number>();
    expect(studs(shapes.of(bar, 1)?.occupancy)).toEqual([0, -1, 1, 1]);
    expect(shapes.of(bar, 1)).toBe(shapes.of(bar, 1));
    expect(shapes.of({ ...bar }, 1)).toBe(shapes.of(bar, 1));
    expect(shapes.of(bar, 1, none)).toBe(shapes.of(bar, 1, none));
    expect(shapes.of(bar, 1, none)).not.toBe(shapes.of(bar, 1));
  });
});

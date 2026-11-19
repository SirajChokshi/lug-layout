import { expect, it } from "vitest";
import { StudBasisTable } from "./stud-basis-table.ts";

const BEYOND_FIRST_CAPACITY = 257;

function rows(...matrices: ReadonlyArray<ReadonlyArray<number>>): Float32Array {
  return Float32Array.from(matrices.flat());
}

function bits(values: ArrayLike<number>): number[] {
  return Array.from(new Uint32Array(Float32Array.from(values).buffer));
}

it("gives equal bases one index and every other bit pattern, including -0, its own", () => {
  const table = new StudBasisTable();
  const source = rows(
    [1, 0, 0, 10, 0, 1, 0, 0, 0, 0, 1, 30],
    [1, 0, 0, 50, 0, 1, 0, 8, 0, 0, 1, 70],
    [1, -0, 0, 10, 0, 1, 0, 0, 0, 0, 1, 30],
    [0, 0, 1, 10, 0, 1, 0, 0, -1, 0, 0, 30],
  );

  expect([0, 1, 2, 3].map((row) => table.indexOf(source, row))).toEqual([0, 0, 1, 2]);
  expect(table.count).toBe(3);
  expect(bits(table.columns.subarray(0, 36))).toEqual(
    bits(
      [
        [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
        [1, 0, 0, 0, -0, 1, 0, 0, 0, 0, 1, 0],
        [0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 0],
      ].flat(),
    ),
  );
});

it("keeps earlier indices and columns as it grows past its first capacity", () => {
  const table = new StudBasisTable();
  const source = rows(
    ...Array.from({ length: BEYOND_FIRST_CAPACITY }, (_, k) => [
      k + 1,
      0,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      0,
      1,
      0,
    ]),
  );
  const first = Array.from({ length: BEYOND_FIRST_CAPACITY }, (_, row) =>
    table.indexOf(source, row),
  );
  const again = Array.from({ length: BEYOND_FIRST_CAPACITY }, (_, row) =>
    table.indexOf(source, row),
  );

  expect(first).toEqual(Array.from({ length: BEYOND_FIRST_CAPACITY }, (_, k) => k));
  expect(again).toEqual(first);
  expect(table.count).toBe(BEYOND_FIRST_CAPACITY);
  expect(Array.from(table.columns.subarray(0, 12))).toEqual([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
  expect(Array.from(table.columns.subarray(256 * 12, 257 * 12))).toEqual([
    257, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
  ]);
});

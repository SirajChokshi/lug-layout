import { CHUNK_LDU, STUD_LDU } from "@brr/math";
import { expect, it } from "vitest";
import { placedBox, rulerText } from "./layout-guides.ts";
import type { LocalBox } from "./local-box.ts";

it.each([
  [{ ax: 0, az: 0, bx: CHUNK_LDU, bz: 0 }, "32 studs · 25.6 cm"],
  [{ ax: 0, az: 0, bx: 0, bz: -STUD_LDU }, "1 stud · 0.8 cm"],
  [{ ax: 0, az: 0, bx: 3 * STUD_LDU, bz: 4 * STUD_LDU }, "5 studs · 4 cm (3 × 4)"],
  [{ ax: 0, az: 0, bx: STUD_LDU, bz: STUD_LDU }, "1.4 studs · 1.1 cm (1 × 1)"],
])("reads a ruler in studs and centimetres at 8 mm per stud", (ruler, text) => {
  expect(rulerText(ruler)).toBe(text);
});

it("turns a placeable's box a quarter turn about its pivot", () => {
  const box: LocalBox = { min: [-40, -4, -20], max: [80, 0, 20] };
  expect(placedBox(box, 100, 200, 8, 1)).toEqual({
    minX: 80,
    minY: 4,
    minZ: 120,
    maxX: 120,
    maxY: 8,
    maxZ: 240,
  });
});

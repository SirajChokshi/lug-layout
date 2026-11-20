import { STUD_LDU } from "@brr/math";
import { expect, it } from "vitest";
import { scaleBarStuds } from "./layout-guides.ts";

const MAX_WIDTH_PX = 160;

it.each([
  { studPx: 200, studs: 1 },
  { studPx: 40, studs: 4 },
  { studPx: 10, studs: 16 },
  { studPx: 3, studs: 32 },
  { studPx: 0.04, studs: 2048 },
])(
  "gives a scale bar the longest power-of-two run of studs that fits, never under one stud ($studPx px per stud)",
  ({ studPx, studs }) => {
    expect(scaleBarStuds(studPx / STUD_LDU, MAX_WIDTH_PX)).toBe(studs);
  },
);

import { rectContains, rectsOverlap, type LduRect } from "@brr/domain";
import { CHUNK_LDU, STUD_LDU } from "@brr/math";
import { expect, it } from "vitest";
import { dragFill, fillAnchorLdu, packedFill, type FillPlan } from "./baseplate-fill.ts";
import type { LocalBox } from "./local-box.ts";

const plate32: LocalBox = { min: [-320, -4, -320], max: [320, 0, 320] };
const plate16x32: LocalBox = { min: [-160, -4, -320], max: [160, 0, 320] };
const free = (): boolean => false;

function expectGridded(plan: FillPlan, anchor: number): void {
  for (const tile of plan.tiles) {
    for (const edge of [tile.rect.minX, tile.rect.maxX, tile.rect.minZ, tile.rect.maxZ]) {
      expect(Math.abs(edge % anchor)).toBe(0);
    }
  }
  plan.tiles.forEach((a, i) =>
    plan.tiles.slice(i + 1).forEach((b) => expect(rectsOverlap(a.rect, b.rect)).toBe(false)),
  );
}

it.each<[string, LocalBox, number, number]>([
  ["32 × 32", plate32, 0, CHUNK_LDU],
  ["16 × 32", plate16x32, 0, 16 * STUD_LDU],
  ["16 × 32 turned", plate16x32, 1, 16 * STUD_LDU],
])(
  "fills a dragged area with %s plates on the coarsest grid their size allows",
  (_, box, rot, anchor) => {
    for (const [ax, az, bx, bz] of [
      [130, -70, 1530, 690],
      [130, -70, -1530, -690],
      [-15, 25, -15, 25],
    ] as const) {
      const plan = dragFill({ box, rot, taken: free }, ax, az, bx, bz);
      expect(plan.tiles.length).toBe(plan.columns * plan.rows);
      expectGridded(plan, anchor);
      expect(plan.rect.minX <= Math.min(ax, bx) + anchor / 2).toBe(true);
      expect(plan.rect.maxZ >= Math.max(az, bz) - anchor / 2).toBe(true);
    }
  },
);

it("puts each placement pivot where its tile lands", () => {
  const plan = dragFill({ box: plate32, rot: 0, taken: free }, 0, 0, 1000, 10);
  expect(plan.tiles.map((t) => [t.x, t.z])).toEqual([
    [320, 320],
    [960, 320],
  ]);
});

it("packs a table with whole plates on the grid around what is already there", () => {
  const table: LduRect = { minX: -160, minZ: 330, maxX: 2840, maxZ: 1820 };
  const station: LduRect = { minX: 700, minZ: 700, maxX: 800, maxZ: 800 };
  const tiles = packedFill(
    { box: plate32, rot: 0, taken: (rect) => rectsOverlap(rect, station) },
    table,
  );
  expect(tiles.map((t) => [t.rect.minX, t.rect.minZ])).toEqual([
    [0, 640],
    [1280, 640],
    [1920, 640],
  ]);
  for (const tile of tiles) expect(rectContains(table, tile.rect)).toBe(true);

  const strip: LduRect = { minX: 0, minZ: 0, maxX: 1280, maxZ: 320 };
  const around = packedFill(
    { box: plate16x32, rot: 1, taken: (rect) => rectsOverlap(rect, { ...strip, maxX: 160 }) },
    strip,
  );
  expect(around.map((t) => [t.rect.minX, t.rect.maxX])).toEqual([[320, 960]]);
});

it("never anchors below one stud", () => {
  expect(fillAnchorLdu(50 * STUD_LDU, 50 * STUD_LDU)).toBe(2 * STUD_LDU);
  expect(fillAnchorLdu(24 * STUD_LDU, 32 * STUD_LDU)).toBe(8 * STUD_LDU);
  expect(fillAnchorLdu(STUD_LDU * 3, STUD_LDU * 5)).toBe(STUD_LDU);
});

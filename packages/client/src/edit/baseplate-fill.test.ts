import { rectContains, rectsOverlap, type LduRect } from "@brr/domain";
import { CHUNK_LDU, STUD_LDU } from "@brr/math";
import { expect, it } from "vitest";
import { baseplateGridLdu, dragFill, packedFill, type FillPlan } from "./baseplate-fill.ts";
import type { LocalBox } from "./local-box.ts";

const GRID = 8 * STUD_LDU;
const plate32: LocalBox = { min: [-320, -4, -320], max: [320, 0, 320] };
const plate16x32: LocalBox = { min: [-160, -4, -320], max: [160, 0, 320] };
const free = (): boolean => false;
const overlapping = (taken: LduRect) => (rect: LduRect) => rectsOverlap(rect, taken);
const studs = (...sides: number[]) => sides.map((side) => side * STUD_LDU);

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

it.each<[string, LocalBox, number]>([
  ["32 × 32", plate32, 0],
  ["16 × 32", plate16x32, 0],
  ["16 × 32 turned", plate16x32, 1],
])("fills a dragged area with %s plates on the baseplate grid", (_, box, rot) => {
  for (const [ax, az, bx, bz] of [
    [130, -70, 1530, 690],
    [130, -70, -1530, -690],
    [-15, 25, -15, 25],
  ] as const) {
    const plan = dragFill({ box, rot, gridLdu: GRID, taken: free }, ax, az, bx, bz);
    expect(plan.tiles.length).toBe(plan.columns * plan.rows);
    expectGridded(plan, GRID);
    expect(plan.rect.minX <= Math.min(ax, bx) + GRID / 2).toBe(true);
    expect(plan.rect.maxZ >= Math.max(az, bz) - GRID / 2).toBe(true);
  }
});

it("puts each placement pivot where its tile lands", () => {
  const plan = dragFill({ box: plate32, rot: 0, gridLdu: GRID, taken: free }, 0, 0, 1000, 10);
  expect(plan.tiles.map((t) => [t.x, t.z])).toEqual([
    [320, 320],
    [960, 320],
  ]);
});

it("tiles flush against a 32 × 32 plate seated 8 studs off the chunk lines, by drag and by table", () => {
  const offset: LduRect = { minX: GRID, minZ: 0, maxX: GRID + CHUNK_LDU, maxZ: CHUNK_LDU };
  const options = { box: plate32, rot: 0, gridLdu: GRID, taken: overlapping(offset) };

  const dragged = dragFill(options, offset.maxX + 5, 10, offset.maxX + 2 * CHUNK_LDU - 5, 600);
  expect(dragged.tiles.map((t) => [t.rect.minX, t.rect.maxX, t.taken])).toEqual([
    [offset.maxX, offset.maxX + CHUNK_LDU, false],
    [offset.maxX + CHUNK_LDU, offset.maxX + 2 * CHUNK_LDU, false],
  ]);

  const table: LduRect = { minX: 0, minZ: 0, maxX: 4 * CHUNK_LDU, maxZ: CHUNK_LDU };
  const packed = packedFill(options, table);
  expect(packed.map((t) => t.rect.minX)).toEqual([offset.maxX, offset.maxX + CHUNK_LDU]);
});

it("packs a table with whole plates on the grid around what is already there", () => {
  const table: LduRect = { minX: -160, minZ: 330, maxX: 2840, maxZ: 1820 };
  const station: LduRect = { minX: 700, minZ: 700, maxX: 800, maxZ: 800 };
  const tiles = packedFill(
    { box: plate32, rot: 0, gridLdu: GRID, taken: overlapping(station) },
    table,
  );
  expectGridded({ rect: table, columns: 0, rows: 0, tiles }, GRID);
  for (const tile of tiles) {
    expect(rectContains(table, tile.rect)).toBe(true);
    expect(rectsOverlap(tile.rect, station)).toBe(false);
  }
  expect(tiles).toHaveLength(8);
});

it("takes the coarsest grid that every baseplate side and the chunk share, never below a stud", () => {
  expect(baseplateGridLdu(studs(32, 32, 48, 48, 16, 32))).toBe(16 * STUD_LDU);
  expect(baseplateGridLdu(studs(32, 32, 24, 16, 8, 24))).toBe(8 * STUD_LDU);
  expect(baseplateGridLdu(studs(32, 32))).toBe(CHUNK_LDU);
  expect(baseplateGridLdu(studs(3, 5))).toBe(STUD_LDU);
});

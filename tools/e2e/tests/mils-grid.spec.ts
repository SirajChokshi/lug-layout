import { expect, test } from "@playwright/test";
import {
  EditorPage,
  STUD,
  byPosition,
  isStudAligned,
  type Box,
  type LatticePoint,
} from "./editor-page.ts";

const CROSSROADS = "generated:mils-road-crossroads";

function planRect(box: Box): ReadonlyArray<number> {
  return [box.minX, box.minZ, box.maxX, box.maxZ];
}

function byCorner(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  return (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0);
}

function onStudLattice(box: Box): boolean {
  return [box.minX, box.maxX, box.minZ, box.maxZ].every(isStudAligned);
}

test("a 2×2 grid of MILS crossroads tiles edge to edge on the stud lattice", async ({ page }) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(400);
  const { wide, deep } = await editor.itemStuds(CROSSROADS);
  expect(wide).toBe(deep);
  const side = wide * STUD;
  const half = side / 2;
  const cells: ReadonlyArray<LatticePoint & { readonly rot: number }> = [
    { x: -half, z: -half, rot: 0 },
    { x: half, z: -half, rot: 0 },
    { x: -half, z: half, rot: 0 },
    { x: half, z: half, rot: 1 },
  ];

  for (const cell of cells) await editor.placeAt(CROSSROADS, cell, cell.rot);

  expect(await editor.poses()).toEqual(
    cells
      .map(({ x, z, rot }) => ({ item: CROSSROADS, x, z, yPlates: 0, rot }))
      .toSorted(byPosition),
  );

  const boxes = (await editor.footprints()).map(({ box }) => box);
  for (const box of boxes) expect(onStudLattice(box)).toBe(true);
  expect(boxes.map(planRect).toSorted(byCorner)).toEqual(
    cells.map(({ x, z }) => [x - half, z - half, x + half, z + half]).toSorted(byCorner),
  );
  expect(await editor.counter("refused")).toBe(0);

  await page.screenshot({ path: test.info().outputPath("mils-2x2.png") });
});

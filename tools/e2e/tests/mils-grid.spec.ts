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

function onStudLattice(box: Box): boolean {
  return [box.minX, box.maxX, box.minZ, box.maxZ].every(isStudAligned);
}

test("a 2×2 grid of MILS crossroads tiles edge to edge and every road edge joins", async ({
  page,
}) => {
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

  await editor.placeAt(CROSSROADS, cells[0] ?? { x: 0, z: 0 });
  const edgeCellsPerModule = await editor.counter("road-open");
  expect(edgeCellsPerModule).toBeGreaterThan(0);
  expect(await editor.counter("road-joined")).toBe(0);

  for (const cell of cells.slice(1)) await editor.placeAt(CROSSROADS, cell, cell.rot);

  expect(await editor.poses()).toEqual(
    cells
      .map(({ x, z, rot }) => ({ item: CROSSROADS, x, z, yPlates: 0, rot }))
      .toSorted(byPosition),
  );

  const boxes = (await editor.footprints()).map((footprint) => footprint.box);
  expect(boxes).toHaveLength(4);
  for (const box of boxes) {
    expect(onStudLattice(box)).toBe(true);
    expect(box.maxX - box.minX).toBe(side);
    expect(box.maxZ - box.minZ).toBe(side);
  }
  expect(Math.min(...boxes.map((b) => b.minX))).toBe(-side);
  expect(Math.max(...boxes.map((b) => b.maxX))).toBe(side);
  expect(Math.min(...boxes.map((b) => b.minZ))).toBe(-side);
  expect(Math.max(...boxes.map((b) => b.maxZ))).toBe(side);

  const joined = await editor.counter("road-joined");
  const open = await editor.counter("road-open");
  expect(await editor.counter("road-mismatch")).toBe(0);
  expect(await editor.counter("refused")).toBe(0);
  expect(joined).toBeGreaterThan(0);
  expect(joined + open).toBe(4 * edgeCellsPerModule);
  expect(open).toBe(joined);

  await page.screenshot({ path: test.info().outputPath("mils-2x2.png") });
});

import { expect, test } from "@playwright/test";
import { EditorPage, STUD, byPosition, type Box, type PlanFootprint } from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const GROCER = "omr:10185-1";
const FIRE_BRIGADE = "omr:10190-1";
const CABOOSE = "omr:10014-1";
const FIRE_BRIGADE_OVERHANG_STUDS = 1;

function boxOf(footprints: ReadonlyArray<PlanFootprint>, ref: string): Box {
  const footprint = footprints.find((f) => f.ref === ref);
  if (!footprint) throw new Error(`${ref} has no footprint`);
  return footprint.box;
}

test("sets seat one baseplate apart on the stud lattice and a caboose sits on the baseplate", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(500);
  const { wide } = await editor.itemStuds(BASEPLATE);
  const side = wide * STUD;

  await editor.placeAt(BASEPLATE, { x: 0, z: 0 });
  await editor.placeAt(GROCER, { x: side, z: 0 });
  await editor.placeAt(FIRE_BRIGADE, { x: -side, z: 0 });
  await editor.placeAt(CABOOSE, { x: 0, z: 0 });

  const poses = await editor.poses();
  expect(poses).toEqual(
    [
      { item: FIRE_BRIGADE, x: -side, z: 0, yPlates: 0, rot: 0 },
      { item: BASEPLATE, x: 0, z: 0, yPlates: 0, rot: 0 },
      { item: CABOOSE, x: 0, z: 0, yPlates: 0, rot: 0 },
      { item: GROCER, x: side, z: 0, yPlates: 0, rot: 0 },
    ].toSorted(byPosition),
  );

  const footprints = await editor.footprints();
  const baseplate = boxOf(footprints, BASEPLATE);
  expect(baseplate).toMatchObject({ minX: -side / 2, maxX: side / 2, maxY: 0 });
  expect(boxOf(footprints, GROCER).minX, "10185-1 sits flush east of the baseplate").toBe(
    baseplate.maxX,
  );
  expect(
    boxOf(footprints, FIRE_BRIGADE).maxX,
    "10190-1's baseplate sits flush west of it, with its one-stud overhang over the 3811",
  ).toBe(baseplate.minX + FIRE_BRIGADE_OVERHANG_STUDS * STUD);

  const tableTop = await editor.tableTopY();
  expect(baseplate.minY, "the baseplate lies on the table").toBe(tableTop);
  const caboose = boxOf(footprints, CABOOSE);
  expect(caboose.minY, "the caboose sits on the baseplate's top face").toBe(baseplate.maxY);
  expect(caboose.minY - tableTop, "raised off the table by the baseplate").toBe(
    baseplate.maxY - baseplate.minY,
  );
  expect(caboose.minX).toBeGreaterThanOrEqual(baseplate.minX);
  expect(caboose.maxX).toBeLessThanOrEqual(baseplate.maxX);
  expect(caboose.minZ).toBeGreaterThanOrEqual(baseplate.minZ);
  expect(caboose.maxZ).toBeLessThanOrEqual(baseplate.maxZ);

  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("sets-on-baseplates.png") });
});

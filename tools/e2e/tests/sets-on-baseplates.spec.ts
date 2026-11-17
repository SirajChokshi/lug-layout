import { expect, test } from "@playwright/test";
import { EditorPage, STUD, isStudAligned, type Box, type PlanFootprint } from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const GROCER = "omr:10185-1";
const FIRE_BRIGADE = "omr:10190-1";
const CABOOSE = "omr:10014-1";

function boxOf(footprints: ReadonlyArray<PlanFootprint>, ref: string): Box {
  const footprint = footprints.find((f) => f.ref === ref);
  if (!footprint) throw new Error(`${ref} has no footprint`);
  return footprint.box;
}

test("sets seat on the stud lattice, flush against a baseplate and resting on its top", async ({
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
  expect(poses.map((pose) => pose.item).toSorted()).toEqual(
    [BASEPLATE, CABOOSE, FIRE_BRIGADE, GROCER].toSorted(),
  );
  for (const pose of poses) {
    expect(isStudAligned(pose.x), `${pose.item} x on the stud lattice`).toBe(true);
    expect(isStudAligned(pose.z), `${pose.item} z on the stud lattice`).toBe(true);
    expect(pose.yPlates).toBe(0);
  }

  const footprints = await editor.footprints();
  const baseplate = boxOf(footprints, BASEPLATE);
  expect(baseplate).toMatchObject({ minX: -side / 2, maxX: side / 2, maxY: 0 });
  expect(boxOf(footprints, GROCER).minX).toBe(baseplate.maxX);
  expect(boxOf(footprints, FIRE_BRIGADE).maxX).toBe(baseplate.minX);

  const caboose = boxOf(footprints, CABOOSE);
  expect(caboose.minY).toBe(baseplate.maxY);
  expect(caboose.minX).toBeGreaterThanOrEqual(baseplate.minX);
  expect(caboose.maxX).toBeLessThanOrEqual(baseplate.maxX);
  expect(caboose.minZ).toBeGreaterThanOrEqual(baseplate.minZ);
  expect(caboose.maxZ).toBeLessThanOrEqual(baseplate.maxZ);

  await page.screenshot({ path: test.info().outputPath("sets-on-baseplates.png") });
});

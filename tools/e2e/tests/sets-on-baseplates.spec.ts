import { expect, test } from "@playwright/test";
import { EditorPage, STUD, byPosition, type Box, type PlanFootprint } from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const GROCER = "omr:10185-1";
const FIRE_BRIGADE = "omr:10190-1";
const CABOOSE = "rolling-stock:omr:10014-1";
const FIRE_BRIGADE_OVERHANG_STUDS = 1;

function boxOf(footprints: ReadonlyArray<PlanFootprint>, ref: string): Box {
  const footprint = footprints.find((f) => f.ref === ref);
  if (!footprint) throw new Error(`${ref} has no footprint`);
  return footprint.box;
}

test("sets seat one baseplate apart on the stud lattice, and a caboose is refused on the baseplate because rolling stock stands only on track", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(500);
  const { wide } = await editor.itemStuds(BASEPLATE);
  const side = wide * STUD;

  await editor.placeAt(BASEPLATE, { x: 0, z: 0 });
  await editor.placeAt(GROCER, { x: side, z: 0 });
  await editor.placeAt(FIRE_BRIGADE, { x: -side, z: 0 });
  const seated = [
    { item: FIRE_BRIGADE, x: -side, z: 0, yPlates: 0, rot: 0 },
    { item: BASEPLATE, x: 0, z: 0, yPlates: 0, rot: 0 },
    { item: GROCER, x: side, z: 0, yPlates: 0, rot: 0 },
  ].toSorted(byPosition);
  expect(await editor.poses()).toEqual(seated);

  await editor.placeAt(CABOOSE, { x: 0, z: 0 });
  expect(await editor.poses(), "the refused caboose changes nothing").toEqual(seated);
  expect(await editor.lastRefusal()).toEqual({
    rule: "rolling-stock",
    message: expect.stringContaining("10014-1 rests only on track"),
  });

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

  expect(baseplate.minY, "the baseplate lies on the table").toBe(await editor.tableTopY());

  await page.screenshot({ path: test.info().outputPath("sets-on-baseplates.png") });
});

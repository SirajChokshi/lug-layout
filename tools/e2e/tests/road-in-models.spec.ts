import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, STUD, type LatticePoint } from "./editor-page.ts";

const SIX_STUD_STRAIGHT = "ldraw:44336p04@72";
const QUARTER_TURNS = [0, 1, 2, 3] as const;
const TOGGLE_KEY = "a";

function myCar(): string {
  return [
    "0 A user's own car: a 2 x 4 plate under a 2 x 4 tile roof",
    "0 Name: my-car.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3020.dat",
    "1 15 0 -8 0 1 0 0 0 1 0 0 0 1 87079.dat",
    "",
  ].join("\n");
}

function myStreet(): string {
  return [
    "0 A user's own street: a road plate with a car parked on its roadway and a lamp post",
    "0 Name: my-street.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 72 0 0 0 1 0 0 0 1 0 0 0 1 44336.dat",
    "1 4 0 -8 0 1 0 0 0 1 0 0 0 1 3020.dat",
    "1 15 0 -16 0 1 0 0 0 1 0 0 0 1 87079.dat",
    "1 0 -310 -24 -310 1 0 0 0 1 0 0 0 1 3062b.dat",
    "",
  ].join("\n");
}

test("a road plate inside a user's own street file joins a palette road plate the way the bricks would, with a car parked on it", async ({
  page,
}) => {
  const file = test.info().outputPath("my-street.ldr");
  await writeFile(file, myStreet());
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();

  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  await editor.zoom(300);
  await editor.placeAt(imported.item, { x: 0, z: 0 });
  await editor.escape();
  const street = (await editor.footprints()).find((entry) => entry.ref === imported.item)?.box;
  if (!street) throw new Error("the street has no footprint");
  const { wide } = await editor.itemStuds(SIX_STUD_STRAIGHT);
  const half = (wide * STUD) / 2;
  const centreX = (street.minX + street.maxX) / 2;
  const centreZ = (street.minZ + street.maxZ) / 2;
  const sides: ReadonlyArray<LatticePoint> = [
    { x: street.maxX + half, z: centreZ },
    { x: street.minX - half, z: centreZ },
    { x: centreX, z: street.maxZ + half },
    { x: centreX, z: street.minZ - half },
  ];

  let joining: { readonly at: LatticePoint; readonly rot: number } | null = null;
  for (const at of sides) {
    for (const rot of QUARTER_TURNS) {
      await editor.aim(SIX_STUD_STRAIGHT, at, rot);
      const joinedCells = Number(await editor.root.getAttribute("data-snap"));
      if ((await editor.snapState()) !== "snapped" || joinedCells === 0) continue;
      joining = { at, rot: Number(await editor.root.getAttribute("data-ghost-rot")) };
      break;
    }
    if (joining) break;
  }
  if (!joining) throw new Error("no side of the street takes a 6-stud straight's lanes");
  await editor.placeAt(SIX_STUD_STRAIGHT, joining.at, joining.rot);
  await editor.escape();

  expect(await editor.counter("road-joined")).toBeGreaterThan(0);
  expect(await editor.counter("road-mismatch")).toBe(0);
  expect(await editor.counter("refused")).toBe(0);
  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("my-street-joins-a-palette-road.png") });
});

test("a user's own car with a tile roof parks on a palette road plate with no refusal and no overlap, and a road plate held to rest in that road's cells at the same height is refused", async ({
  page,
}) => {
  const file = test.info().outputPath("my-car.ldr");
  await writeFile(file, myCar());
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const car = await editor.importModel(file);
  expect(car.status, car.text).toBe("placeable");
  await editor.zoom(300);
  await editor.placeAt(SIX_STUD_STRAIGHT, { x: 0, z: 0 });
  await editor.placeAt(car.item, { x: -160, z: 0 });
  await editor.escape();

  expect((await editor.poses()).map((pose) => pose.item).toSorted()).toEqual(
    [car.item, SIX_STUD_STRAIGHT].toSorted(),
  );
  expect(await editor.counter("refused")).toBe(0);
  await expect(page.locator('[data-road="overlap"]')).toHaveText("0");

  await editor.choose(SIX_STUD_STRAIGHT);
  if ((await editor.placementModes()).mode !== "precise") await page.keyboard.press(TOGGLE_KEY);
  await expect.poll(async () => (await editor.placementModes()).mode).toBe("precise");
  const halfOver = await editor.aim(SIX_STUD_STRAIGHT, { x: 320, z: 0 });
  expect(await editor.snapState()).toBe("refused");
  await page.mouse.click(halfOver.sx, halfOver.sy);
  expect(await editor.counter("refused")).toBe(1);
  expect(await editor.poses()).toHaveLength(2);
  await page.screenshot({ path: test.info().outputPath("my-car-parked-on-a-road.png") });
});

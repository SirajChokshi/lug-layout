import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  EditorPage,
  STUD,
  byPosition,
  type Box,
  type LatticePoint,
  type ScreenPoint,
} from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const BRICK_2_X_4 = "3001";
const FENCE_SPINDLED_1_X_4_X_2 = "30055";
const RED = 4;
const BLUE = 1;
const WHITE = 15;
const PLATES_PER_BRICK = 3;
const WALL_BRICKS = 3;
const ORIGIN: LatticePoint = { x: 0, z: 0 };
const IMPORT_REF = /^import:[0-9a-f]{64}$/u;

interface CameraView {
  readonly targetX: number;
  readonly targetY: number;
  readonly targetZ: number;
  readonly distance: number;
  readonly yaw: number;
  readonly pitch: number;
}

async function cameraEye(page: Page): Promise<readonly [number, number, number]> {
  const view: CameraView = JSON.parse((await page.locator("#camera-state").textContent()) ?? "");
  const forwardX = -Math.cos(view.pitch) * Math.cos(view.yaw);
  const forwardY = -Math.sin(view.pitch);
  const forwardZ = -Math.cos(view.pitch) * Math.sin(view.yaw);
  return [
    view.targetX - forwardX * view.distance,
    view.targetY - forwardY * view.distance,
    view.targetZ - forwardZ * view.distance,
  ];
}

async function topFaceCentre(editor: EditorPage, page: Page, box: Box): Promise<ScreenPoint> {
  const [eyeX, eyeY, eyeZ] = await cameraEye(page);
  const toTable = eyeY / (eyeY - box.maxY);
  const tableX = eyeX + ((box.minX + box.maxX) / 2 - eyeX) * toTable;
  const tableZ = eyeZ + ((box.minZ + box.maxZ) / 2 - eyeZ) * toTable;
  const x = Math.round(tableX / STUD) * STUD;
  const nearZ = Math.floor(tableZ / STUD) * STUD;
  const near = await editor.screenOf({ x, z: nearZ });
  const far = await editor.screenOf({ x, z: nearZ + STUD });
  const along = (tableZ - nearZ) / STUD;
  return { sx: near.sx + (far.sx - near.sx) * along, sy: near.sy + (far.sy - near.sy) * along };
}

function customGardenWall(): string {
  return [
    "0 Garden wall built for the library part test",
    "0 Name: custom-garden-wall.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 71 0 0 0 1 0 0 0 1 0 0 0 1 3010.dat",
    "1 71 0 -24 0 1 0 0 0 1 0 0 0 1 3010.dat",
    "1 72 0 -48 0 1 0 0 0 1 0 0 0 1 3010.dat",
    "",
  ].join("\n");
}

test("a 2 x 4 brick from the pinned library is found by its title, stacked on a baseplate in a produced colour, and picked again without a second copy", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  await editor.zoom(500);
  await editor.placeAt(BASEPLATE, ORIGIN);
  await editor.escape();

  await editor.searchPalette("brick 2 x 4");
  expect((await editor.libraryParts())[0]).toBe(BRICK_2_X_4);
  const red = await editor.pickLibraryPart(BRICK_2_X_4, RED);
  expect(red.status, red.text).toBe("placeable");
  expect(red.item).toMatch(IMPORT_REF);
  await editor.clickAt(ORIGIN);
  await editor.clickAt(ORIGIN);
  await editor.escape();

  const redAgain = await editor.pickLibraryPart(BRICK_2_X_4, RED);
  const blue = await editor.pickLibraryPart(BRICK_2_X_4, BLUE);
  await editor.escape();

  expect(redAgain.item).toBe(red.item);
  expect(blue.status, blue.text).toBe("placeable");
  expect((await editor.refs()).filter((ref) => IMPORT_REF.test(ref))).toEqual([
    red.item,
    blue.item,
  ]);
  expect(await editor.poses()).toEqual(
    [
      { item: BASEPLATE, x: 0, z: 0, yPlates: 0, rot: 0 },
      { item: red.item, x: 0, z: 0, yPlates: 0, rot: 0 },
      { item: red.item, x: 0, z: 0, yPlates: PLATES_PER_BRICK, rot: 0 },
    ].toSorted(byPosition),
  );
});

test("a library part seats on top of an imported custom model, on the studs its bricks really have", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  await editor.zoom(500);
  const wallFile = test.info().outputPath("custom-garden-wall.ldr");
  await writeFile(wallFile, customGardenWall());
  await editor.placeAt(BASEPLATE, ORIGIN);
  await editor.escape();
  const wall = await editor.importModel(wallFile);
  expect(wall.status, wall.text).toBe("placeable");
  await editor.clickAt(ORIGIN);
  await editor.escape();

  const wallBox = (await editor.footprints()).find((footprint) => footprint.ref === wall.item)?.box;
  if (!wallBox) throw new Error("the placed wall has no footprint");

  await editor.searchPalette("fence spindled 1 x 4 x 2");
  const fence = await editor.pickLibraryPart(FENCE_SPINDLED_1_X_4_X_2, WHITE);
  expect(fence.status, fence.text).toBe("placeable");
  const onTheWall = await topFaceCentre(editor, page, wallBox);
  await page.mouse.click(onTheWall.sx, onTheWall.sy);
  await editor.escape();

  expect(await editor.poses()).toEqual(
    [
      { item: BASEPLATE, x: 0, z: 0, yPlates: 0, rot: 0 },
      { item: wall.item, x: 0, z: 0, yPlates: 0, rot: 0 },
      { item: fence.item, x: 0, z: 0, yPlates: WALL_BRICKS * PLATES_PER_BRICK, rot: 0 },
    ].toSorted(byPosition),
  );
});

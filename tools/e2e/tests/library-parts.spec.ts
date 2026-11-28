import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  EditorPage,
  STUD,
  byPosition,
  type Box,
  type HoverState,
  type LatticePoint,
  type ScreenPoint,
} from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const BRICK_2_X_4 = "3001";
const FENCE_SPINDLED_1_X_4_X_2 = "30055";
const TILE_1_X_2 = "3069b";
const JUMPER_1_X_2 = "15573";
const TREE_OVAL_4_X_4_X_6 = "3470";
const SIGNAL_MAST = "4168";
const JUMPER_AT: LatticePoint = { x: 80, z: 0 };
const TREE_AT: LatticePoint = { x: -200, z: 160 };
const MAST_AT: LatticePoint = { x: 0, z: -240 };
const RED = 4;
const BLUE = 1;
const GREEN = 2;
const LIGHT_GREY = 7;
const WHITE = 15;
const PLATES_PER_BRICK = 3;
const TREE_ANTI_STUDS = 4;
const MAST_ANTI_STUDS = 16;
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

function customPlanter(): string {
  return [
    "0 Planter built for the library part test: two 2 x 4 bricks, the second tiled over",
    "0 Name: custom-planter.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 4 80 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 15 60 -8 0 1 0 0 0 1 0 0 0 1 3068b.dat",
    "1 15 100 -8 0 1 0 0 0 1 0 0 0 1 3068b.dat",
    "",
  ].join("\n");
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

async function hoverAt(editor: EditorPage, page: Page, target: LatticePoint): Promise<HoverState> {
  const point = await editor.screenOf(target);
  await page.mouse.move(point.sx, point.sy);
  return editor.hoverIn("assist");
}

async function settledHoverAt(
  editor: EditorPage,
  page: Page,
  target: LatticePoint,
): Promise<{ readonly yPlates: number; readonly joints: number }> {
  const { yPlates, placement } = await hoverAt(editor, page, target);
  return { yPlates, joints: placement?.joints ?? 0 };
}

function standing({ placement }: HoverState) {
  return {
    accepted: placement?.accepted,
    pose: placement?.pose,
    joints: placement?.joints,
    restsOn: placement?.restsOn.map((placed) => placed.item),
    hits: placement?.hit?.partLabel ?? null,
  };
}

test("a studless tile and a jumper from the pinned library seat on a baseplate by their own anti-studs, and a second jumper seats on the first one's half-stud stud", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  await editor.zoom(500);
  await editor.placeAt(BASEPLATE, ORIGIN);
  await editor.escape();

  await editor.searchPalette(TILE_1_X_2);
  const tile = await editor.pickLibraryPart(TILE_1_X_2, WHITE);
  expect(tile.status, tile.text).toBe("placeable");
  const tileHover = await settledHoverAt(editor, page, ORIGIN);
  await editor.clickAt(ORIGIN);
  await editor.escape();

  await editor.searchPalette(JUMPER_1_X_2);
  const jumper = await editor.pickLibraryPart(JUMPER_1_X_2, WHITE);
  expect(jumper.status, jumper.text).toBe("placeable");
  const jumperHover = await settledHoverAt(editor, page, JUMPER_AT);
  await editor.clickAt(JUMPER_AT);
  const stackedHover = await settledHoverAt(editor, page, JUMPER_AT);
  await editor.clickAt(JUMPER_AT);
  await editor.escape();

  expect({ tile: tileHover, jumper: jumperHover, stacked: stackedHover }).toEqual({
    tile: { yPlates: 0, joints: 2 },
    jumper: { yPlates: 0, joints: 2 },
    stacked: { yPlates: 1, joints: 1 },
  });
  expect(await editor.poses()).toEqual(
    [
      { item: BASEPLATE, x: 0, z: 0, yPlates: 0, rot: 0 },
      { item: tile.item, x: 0, z: 0, yPlates: 0, rot: 0 },
      { item: jumper.item, x: JUMPER_AT.x, z: JUMPER_AT.z, yPlates: 0, rot: 0 },
      { item: jumper.item, x: JUMPER_AT.x, z: JUMPER_AT.z, yPlates: 1, rot: 0 },
    ].toSorted(byPosition),
  );
});

test("a tree and a signal mast from the pinned library stand on studs by their own anti-studs: on a baseplate and on an imported planter's bricks, never on its tiles", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  await editor.zoom(500);
  const planterFile = test.info().outputPath("custom-planter.ldr");
  await writeFile(planterFile, customPlanter());
  await editor.placeAt(BASEPLATE, ORIGIN);
  await editor.escape();
  const planter = await editor.importModel(planterFile);
  expect(planter.status, planter.text).toBe("placeable");
  await editor.placeAt(planter.item, ORIGIN);
  await editor.escape();
  const box = (await editor.footprints()).find((footprint) => footprint.ref === planter.item)?.box;
  if (!box) throw new Error("the placed planter has no footprint");
  const middleZ = (box.minZ + box.maxZ) / 2;
  const onTheBricks: LatticePoint = { x: box.minX + 2 * STUD, z: middleZ };
  const onTheTiles: LatticePoint = { x: box.maxX - 2 * STUD, z: middleZ };

  await editor.searchPalette(SIGNAL_MAST);
  const mast = await editor.pickLibraryPart(SIGNAL_MAST, LIGHT_GREY);
  expect(mast.status, mast.text).toBe("placeable");
  const mastOnTheBaseplate = standing(await hoverAt(editor, page, MAST_AT));
  await editor.clickAt(MAST_AT);
  await editor.escape();

  await editor.searchPalette(TREE_OVAL_4_X_4_X_6);
  const tree = await editor.pickLibraryPart(TREE_OVAL_4_X_4_X_6, GREEN);
  expect(tree.status, tree.text).toBe("placeable");
  const offTheTiles = standing(await hoverAt(editor, page, onTheTiles));
  const onTheBaseplate = standing(await hoverAt(editor, page, TREE_AT));
  await editor.clickAt(TREE_AT);
  const onThePlanter = standing(await hoverAt(editor, page, onTheBricks));
  await editor.clickAt(onTheBricks);
  await editor.escape();

  const onTheBricksPose = { ...onTheBricks, yPlates: PLATES_PER_BRICK, rot: 0 };
  expect({ mastOnTheBaseplate, onTheBaseplate, onThePlanter, offTheTiles }).toEqual({
    mastOnTheBaseplate: {
      accepted: true,
      pose: { ...MAST_AT, yPlates: 0, rot: 0 },
      joints: MAST_ANTI_STUDS,
      restsOn: [BASEPLATE],
      hits: null,
    },
    onTheBaseplate: {
      accepted: true,
      pose: { ...TREE_AT, yPlates: 0, rot: 0 },
      joints: TREE_ANTI_STUDS,
      restsOn: [BASEPLATE],
      hits: null,
    },
    onThePlanter: {
      accepted: true,
      pose: onTheBricksPose,
      joints: TREE_ANTI_STUDS,
      restsOn: [planter.item],
      hits: null,
    },
    offTheTiles: {
      accepted: false,
      pose: { ...onTheTiles, yPlates: PLATES_PER_BRICK, rot: 0 },
      joints: 0,
      restsOn: [planter.item],
      hits: "Tile 2 x 2 with Groove",
    },
  });
  expect(await editor.poses()).toEqual(
    [
      { item: BASEPLATE, ...ORIGIN, yPlates: 0, rot: 0 },
      { item: planter.item, ...ORIGIN, yPlates: 0, rot: 0 },
      { item: mast.item, ...MAST_AT, yPlates: 0, rot: 0 },
      { item: tree.item, ...TREE_AT, yPlates: 0, rot: 0 },
      { item: tree.item, ...onTheBricksPose },
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

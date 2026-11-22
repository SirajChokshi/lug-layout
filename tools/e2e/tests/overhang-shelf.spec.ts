import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, STUD, type LatticePoint } from "./editor-page.ts";

const SHELF_NAME = "custom-shelf.ldr";
const BRICK_NAME = "custom-brick.ldr";
const FAR: LatticePoint = { x: 800, z: 0 };
const BRICK_STUDS = 2;
const SHELF_HALF_DEPTH = STUD / 2;
const PLATE_PLATES = 1;

function shelf(): string {
  return [
    "0 Custom shelf built for the overhang test: a 1 x 6 plate over a 4 x 8 plate, held up by a two-brick pillar at one end",
    `0 Name: ${SHELF_NAME}`,
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 72 0 0 0 1 0 0 0 1 0 0 0 1 3035.dat",
    "1 4 -40 -24 0 1 0 0 0 1 0 0 0 1 3004.dat",
    "1 4 -40 -48 0 1 0 0 0 1 0 0 0 1 3004.dat",
    "1 1 0 -56 0 1 0 0 0 1 0 0 0 1 3666.dat",
    "",
  ].join("\n");
}

function brick(): string {
  return [
    "0 Custom brick built for the overhang test",
    `0 Name: ${BRICK_NAME}`,
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 14 0 0 0 1 0 0 0 1 0 0 0 1 3003.dat",
    "",
  ].join("\n");
}

async function imported(editor: EditorPage, name: string, text: string): Promise<string> {
  const file = test.info().outputPath(name);
  await writeFile(file, text);
  const outcome = await editor.importModel(file);
  expect(outcome.status, outcome.text).toBe("placeable");
  return outcome.item;
}

async function planView(page: Page): Promise<void> {
  await page.getByRole("button", { name: "2D plan" }).click();
}

test("a custom brick goes on a custom shelf's plate in the gap under its overhang, and is refused where it would cut into the shelf's pillar, naming the brick it hits", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const shelfItem = await imported(editor, SHELF_NAME, shelf());
  const brickItem = await imported(editor, BRICK_NAME, brick());
  await planView(page);
  await editor.placementSwitch().click();

  await editor.placeAt(brickItem, FAR);
  const loose = (await editor.footprints()).find((entry) => entry.ref === brickItem)?.box;
  if (!loose) throw new Error("the brick has no footprint");
  const offset = { x: loose.minX - FAR.x, z: loose.minZ - FAR.z };
  await editor.undo();

  await editor.placeAt(shelfItem, { x: 0, z: 0 });
  const box = (await editor.footprints()).find((entry) => entry.ref === shelfItem)?.box;
  if (!box) throw new Error("the shelf has no footprint");
  const centre = { x: (box.minX + box.maxX) / 2, z: (box.minZ + box.maxZ) / 2 };
  const brickAt = (minX: number, minZ: number): LatticePoint => ({
    x: minX - offset.x,
    z: minZ - offset.z,
  });
  const underTheShelf = brickAt(centre.x, centre.z);
  const intoThePillar = brickAt(centre.x - BRICK_STUDS * STUD, centre.z);
  expect(underTheShelf.z, "the cursor lies off the shelf's own top").toBeGreaterThan(
    centre.z + SHELF_HALF_DEPTH,
  );

  await editor.aim(brickItem, intoThePillar);
  const pillar = await editor.hoverIn("precise");
  await editor.aim(brickItem, underTheShelf);
  const gap = await editor.hoverIn("precise");
  await page.screenshot({ path: test.info().outputPath("brick-under-the-shelf.png") });
  const point = await editor.screenOf(underTheShelf);
  await page.mouse.click(point.sx, point.sy);

  expect({
    pillar: {
      accepted: pillar.placement?.accepted,
      hits: pillar.placement?.hit?.partLabel,
      in: pillar.placement?.hit?.placed.item,
    },
    gap: {
      accepted: gap.placement?.accepted,
      pose: gap.placement?.pose,
      restsOn: gap.placement?.restsOn.map((placed) => placed.item),
      mated: (gap.placement?.mates.length ?? 0) > 0,
    },
  }).toEqual({
    pillar: { accepted: false, hits: "Brick 1 x 2", in: shelfItem },
    gap: {
      accepted: true,
      pose: { ...underTheShelf, yPlates: PLATE_PLATES, rot: 0 },
      restsOn: [shelfItem],
      mated: true,
    },
  });
  expect(await editor.poses()).toContainEqual({
    item: brickItem,
    ...underTheShelf,
    yPlates: PLATE_PLATES,
    rot: 0,
  });
});

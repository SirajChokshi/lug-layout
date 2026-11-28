import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { EditorPage, TRACK_ITEM } from "./editor-page.ts";

const LOCOMOTIVE_SET = "3741-1";
const LOCOMOTIVE_MODEL = "3741-1_Model-B.mpd";
const SET_WITHOUT_MODEL = "60197-1";
const MY_WAGONS = fileURLToPath(
  new URL("../../../packages/import/test-data/my-container-and-tank-wagons.ldr", import.meta.url),
);
const ON_THE_RAILS = { x: 0, z: 0 };
const IMPORT_REF = /^import:[0-9a-f]{64}$/u;

test("a set the palette doesn't carry is found by name, downloaded only at its pinned SHA-256 and set on hand-drawn track, and a set with no model takes the builder's own file", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const mirror = await editor.serveOmrModels();
  await editor.zoom(700);
  await editor.choose(TRACK_ITEM);
  await editor.dragTrack({ x: -400, z: 0 }, { x: 400, z: 0 });
  await editor.escape();

  const sets = await editor.searchSets("large locomotive 2001");
  await expect(sets.locator(`[data-omr-set="${LOCOMOTIVE_SET}"]`)).toHaveCount(1);
  mirror.tamper(LOCOMOTIVE_MODEL);
  expect(await editor.pickOmrModel(LOCOMOTIVE_MODEL)).toContain(
    `the downloaded ${LOCOMOTIVE_MODEL} isn't the file its SHA-256 pins`,
  );
  expect((await editor.refs()).filter((ref) => IMPORT_REF.test(ref))).toEqual([]);

  mirror.untamper(LOCOMOTIVE_MODEL);
  const locomotive = await editor.pickOmrModel(LOCOMOTIVE_MODEL);
  if (typeof locomotive === "string")
    throw new Error(`the pinned model was refused: ${locomotive}`);
  expect(locomotive.status, locomotive.text).toBe("placeable");
  expect(locomotive.item).toMatch(IMPORT_REF);
  expect(await editor.hoverAt(await editor.screenOf(ON_THE_RAILS))).toEqual(ON_THE_RAILS);
  await editor.clickAt(ON_THE_RAILS);
  await editor.escape();
  expect(await editor.trainsOnRails()).toBe(1);

  const withoutModel = (await editor.searchSets(SET_WITHOUT_MODEL)).locator(
    `[data-omr-set="${SET_WITHOUT_MODEL}"]`,
  );
  await expect(withoutModel.locator("[data-omr-model]")).toHaveCount(0);
  await expect(withoutModel.locator("[data-omr-unmodelled]")).toContainText(
    "No LDraw model of this set yet",
  );
  const wagons = await editor.importOwnFileOfSet(SET_WITHOUT_MODEL, MY_WAGONS);
  expect(wagons.status, wagons.text).toBe("placeable");
});

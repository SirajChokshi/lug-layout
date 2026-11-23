import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { readZip } from "@brr/storage/zip";
import { EditorPage, TRACK_ITEM, byPosition, type LatticePoint } from "./editor-page.ts";

const GROCER = "omr:10185-1";
const BASEPLATE = "ldraw:3811@2";
const ROAD_STRAIGHT = "ldraw:44336p04@72";
const CC_BY_4 = "Licensed under CC BY 4.0 : see CAreadme.txt";
const COTTAGE_FILE = "my-cottage.mpd";
const SHED_FILE = "my-shed.mpd";
const PARTS_OF_THEIR_OWN = ["my-chimney.dat", "my-roof.dat"];
const TABLE_ONE: readonly [LatticePoint, LatticePoint] = [
  { x: -1600, z: -640 },
  { x: 0, z: 640 },
];
const TABLE_TWO: readonly [LatticePoint, LatticePoint] = [
  { x: 1440, z: 640 },
  { x: 0, z: -640 },
];

const USER_COTTAGE = [
  `0 FILE ${COTTAGE_FILE}`,
  "0 My cottage, a user's own model with a part of its own",
  `0 Name: ${COTTAGE_FILE}`,
  "0 Author: lug-layout e2e",
  `0 !LICENSE ${CC_BY_4}`,
  "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3867.dat",
  "1 15 -40 -24 -60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 15 40 -24 60 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 4 0 -24 0 1 0 0 0 1 0 0 0 1 my-chimney.dat",
  "0 NOFILE",
  "0 FILE my-chimney.dat",
  "0 My chimney, the cottage's own part",
  "0 Name: my-chimney.dat",
  "0 Author: lug-layout e2e [James Jessiman]",
  "0 !LDRAW_ORG Unofficial_Part",
  `0 !LICENSE ${CC_BY_4}`,
  "1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
  "0 NOFILE",
  "",
].join("\n");

const USER_SHED = [
  `0 FILE ${SHED_FILE}`,
  "0 My shed, a user's own model with a part of its own that has no licence line",
  `0 Name: ${SHED_FILE}`,
  "0 Author: lug-layout e2e",
  `0 !LICENSE ${CC_BY_4}`,
  "1 4 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
  "1 0 0 -24 0 1 0 0 0 1 0 0 0 1 my-roof.dat",
  "0 NOFILE",
  "0 FILE my-roof.dat",
  "0 My roof, the shed's own part",
  "0 Name: my-roof.dat",
  "0 Author: lug-layout e2e",
  "0 !LDRAW_ORG Unofficial_Part",
  "1 16 0 0 0 1 0 0 0 1 0 0 0 1 3001.dat",
  "0 NOFILE",
  "",
].join("\n");

async function snapshot(editor: EditorPage) {
  return {
    poses: (await editor.poses()).toSorted(byPosition),
    track: await editor.laidTrack(),
    plans: (await editor.plans()).map(({ id: _plan, footprint, ...plan }) => ({
      ...plan,
      room: [footprint.roomWidthMm, footprint.roomDepthMm],
      tables: footprint.tables.map(({ id: _table, ...table }) => table),
      obstacles: footprint.obstacles.map(({ id: _obstacle, ...obstacle }) => obstacle),
    })),
    crossings: (await editor.crossings()).length,
  };
}

async function openPlanFile(page: Page, path: string): Promise<void> {
  await page.locator('input[aria-label="Open a .brrplan.zip plan file"]').setInputFiles(path);
}

test("a plan of two tables, a modular, track across a road plate and two user models, one with a part that has no licence line, saves to a .brrplan.zip carrying both files, which a fresh profile reopens exactly, crediting the licensed part", async ({
  page,
  browser,
  baseURL,
  viewport,
  deviceScaleFactor,
}) => {
  const cottageFile = test.info().outputPath(COTTAGE_FILE);
  await writeFile(cottageFile, USER_COTTAGE);
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary({ expectMissing: PARTS_OF_THEIR_OWN });
  const cottage = await editor.importModel(cottageFile);
  expect(cottage.status, cottage.text).toBe("placeable");
  await editor.escape();
  const shedFile = test.info().outputPath(SHED_FILE);
  await writeFile(shedFile, USER_SHED);
  const shed = await editor.importModel(shedFile);
  expect(shed.status, shed.text).toBe("placeable");
  await editor.escape();
  await editor.zoom(500);

  await editor.press("b");
  await editor.dragFrom(...TABLE_ONE);
  await editor.dragFrom(...TABLE_TWO);
  await editor.escape();
  await editor.placeAt(GROCER, { x: -1120, z: 0 });
  await editor.placeAt(BASEPLATE, { x: -480, z: 0 });
  await editor.placeAt(cottage.item, { x: -480, z: 480 });
  await editor.placeAt(shed.item, { x: -1120, z: 480 });
  await editor.placeAt(ROAD_STRAIGHT, { x: 640, z: 0 });
  await editor.choose(TRACK_ITEM);
  expect((await editor.dragTrack({ x: 160, z: 0 }, { x: 1120, z: 0 })).lastCommit).toBe("laid");
  await editor.escape();
  const saved = await snapshot(editor);
  expect(saved.plans).toHaveLength(1);
  expect(saved.plans[0]?.tables).toHaveLength(2);
  expect(saved.crossings).toBe(1);
  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("plan-saved.png") });

  const download = page.waitForEvent("download");
  await page.locator('[data-action="save-plan"]').click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("Plan-1.brrplan.zip");
  const planFile = test.info().outputPath(file.suggestedFilename());
  await file.saveAs(planFile);
  const zip = await readZip(new Uint8Array(await readFile(planFile)));
  const credits = new TextDecoder().decode((zip.ok && zip.value.get("CREDITS.txt")) || undefined);
  expect(credits).toContain("10185-1");
  expect(credits).toContain(
    `my-chimney.dat: My chimney, the cottage's own part, by lug-layout e2e [James Jessiman], ${CC_BY_4}`,
  );
  const carried = new Map(
    [...(zip.ok ? zip.value : [])].flatMap(([name, bytes]) =>
      name.startsWith("imports/")
        ? [[name.slice(name.lastIndexOf("/") + 1), new TextDecoder().decode(bytes)] as const]
        : [],
    ),
  );
  expect(carried).toEqual(
    new Map([
      [COTTAGE_FILE, USER_COTTAGE],
      [SHED_FILE, USER_SHED],
    ]),
  );
  const sheet = new TextDecoder().decode((zip.ok && zip.value.get("plan.svg")) || undefined);
  expect(sheet).toMatch(/<svg [^>]*width="\d+(?:\.\d+)?mm"/u);
  expect(sheet).toContain("Plan 1");
  expect(zip.ok && [...zip.value.keys()]).toEqual(
    expect.arrayContaining(["parts.csv", "bricklink.xml", "rebrickable.csv"]),
  );

  const freshProfile = await browser.newContext({
    ...(baseURL === undefined ? {} : { baseURL }),
    viewport,
    ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
  });
  const freshPage = await freshProfile.newPage();
  const fresh = await EditorPage.open(freshPage);
  await fresh.serveLdrawLibrary({ expectMissing: PARTS_OF_THEIR_OWN });
  expect(await snapshot(fresh)).toMatchObject({ poses: [], track: [], plans: [] });
  await openPlanFile(freshPage, planFile);
  await expect.poll(async () => (await fresh.poses()).length).toBe(saved.poses.length);
  expect(await snapshot(fresh)).toEqual(saved);
  await fresh.waitForFarTierAndMeshesSettled();
  await freshPage.screenshot({ path: test.info().outputPath("plan-reopened.png") });
  await freshProfile.close();
});

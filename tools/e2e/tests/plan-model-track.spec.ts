import { writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { EditorPage, type PlanRow } from "./editor-page.ts";

const SEAM_LDU = 320;
const TABLE_HALF_DEPTH_LDU = 640;
const ROW_LDU = 400;
const STUD_LDU = 20;
const ACROSS_THE_SEAM = `between tables "Table 1" and "Table 2"; a seam must fall between placements.`;
const OUTLINE_RULES: ReadonlySet<string> = new Set(["trackSeam", "trackOffTable", "fit", "seam"]);

function outlineRows(rows: ReadonlyArray<PlanRow>): ReadonlyArray<string> {
  return rows
    .filter((row) => OUTLINE_RULES.has(row.rule))
    .map((row) => `${row.rule}: ${row.message}`);
}

function userFile(name: string, lines: ReadonlyArray<string>): string {
  return [
    `0 ${name}`,
    `0 Name: ${name}`,
    "0 Author: lug-layout e2e (a user's file written at test time from official parts)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    ...lines,
    "",
  ].join("\n");
}

function twoStraights(part: string): ReadonlyArray<string> {
  return [`1 16 -160 0 0 1 0 0 0 1 0 0 0 1 ${part}`, `1 16 160 0 0 1 0 0 0 1 0 0 0 1 ${part}`];
}

async function imported(editor: EditorPage, name: string, text: string): Promise<string> {
  const file = test.info().outputPath(name);
  await writeFile(file, text);
  const outcome = await editor.importModel(file);
  expect(outcome.status, outcome.text).toBe("placeable");
  return outcome.item;
}

async function twoTables(page: Page): Promise<EditorPage> {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  await editor.zoom(900);
  await editor.drawTable(
    { x: -4 * SEAM_LDU, z: -TABLE_HALF_DEPTH_LDU },
    { x: SEAM_LDU, z: TABLE_HALF_DEPTH_LDU },
  );
  await editor.drawTable(
    { x: 5 * SEAM_LDU, z: TABLE_HALF_DEPTH_LDU },
    { x: SEAM_LDU, z: -TABLE_HALF_DEPTH_LDU },
  );
  return editor;
}

async function shot(page: Page, name: string): Promise<void> {
  await page.locator(".plan-unchecked").scrollIntoViewIfNeeded();
  await page
    .locator(".plan-panel")
    .screenshot({ path: test.info().outputPath(`${name}-rows.png`) });
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

test("a user's own track container is judged by its exact track outlines: a run whose end sits on the seam isn't across it, 9V or plastic, while one stud further east or with its body spanning the seam it is", async ({
  page,
}) => {
  const editor = await twoTables(page);
  const nineVolt = await imported(
    editor,
    "my-9V-run.ldr",
    userFile("my-9V-run.ldr", twoStraights("74746.dat")),
  );
  const plastic = await imported(
    editor,
    "my-plastic-run.ldr",
    userFile("my-plastic-run.ldr", twoStraights("53401.dat")),
  );
  await editor.placeAt(nineVolt, { x: STUD_LDU, z: 0 });
  await editor.placeAt(plastic, { x: STUD_LDU, z: -ROW_LDU });
  await editor.escape();
  const oneStudEast = await editor.planRows();
  await editor.undo();
  await editor.undo();
  await editor.placeAt(nineVolt, { x: 0, z: 0 });
  await editor.placeAt(plastic, { x: 0, z: -ROW_LDU });
  await editor.escape();
  const endsOnTheSeam = await editor.planRows();
  await shot(page, "carried-ends-on-the-seam");
  await editor.placeAt(nineVolt, { x: SEAM_LDU / 2, z: ROW_LDU });
  await editor.escape();
  const spanning = await editor.planRows();
  await shot(page, "carried-body-across-the-seam");
  const poses = await editor.poses();
  await editor.undo();
  const undone = await editor.planRows();
  await editor.redo();
  const redone = await editor.planRows();

  expect(poses.map(({ x, z }) => `${x}, ${z}`).toSorted()).toEqual(
    ["0, 0", `0, ${-ROW_LDU}`, `${SEAM_LDU / 2}, ${ROW_LDU}`].toSorted(),
  );
  const across = `trackSeam: Track carried by my-9V-run.ldr at ${SEAM_LDU / 2}, ${ROW_LDU} stands across the seam ${ACROSS_THE_SEAM}`;
  expect(outlineRows(oneStudEast)).toEqual([
    `trackSeam: Track carried by my-9V-run.ldr at ${STUD_LDU}, 0 stands across the seam ${ACROSS_THE_SEAM}`,
    `trackSeam: Track carried by my-plastic-run.ldr at ${STUD_LDU}, ${-ROW_LDU} stands across the seam ${ACROSS_THE_SEAM}`,
  ]);
  expect(outlineRows(endsOnTheSeam)).toEqual([]);
  expect(outlineRows(spanning)).toEqual([across]);
  expect(outlineRows(undone)).toEqual([]);
  expect(outlineRows(redone)).toEqual([across]);
});

test("a wall standing in the cell a user's run's end joiner reaches into keeps its own footing: alone past the seam it isn't across it, one stud further east the run's body is, and with a wall past the other end the model is", async ({
  page,
}) => {
  const editor = await twoTables(page);
  const besideTheEnd = "1 4 330 -16 50 1 0 0 0 1 0 0 0 1 3005.dat";
  const oneWall = await imported(
    editor,
    "my-run-and-wall.ldr",
    userFile("my-run-and-wall.ldr", [...twoStraights("74746.dat"), besideTheEnd]),
  );
  const twoWalls = await imported(
    editor,
    "my-run-and-walls.ldr",
    userFile("my-run-and-walls.ldr", [
      ...twoStraights("74746.dat"),
      besideTheEnd,
      "1 4 -330 -16 -50 1 0 0 0 1 0 0 0 1 3005.dat",
    ]),
  );
  await editor.placeAt(oneWall, { x: STUD_LDU, z: 0 });
  await editor.escape();
  const oneWallRows = await editor.planRows();
  await shot(page, "carried-wall-beside-the-seam");
  await editor.undo();
  await editor.placeAt(oneWall, { x: 2 * STUD_LDU, z: 0 });
  await editor.escape();
  const oneStudEast = await editor.planRows();
  await editor.undo();
  await editor.placeAt(twoWalls, { x: 0, z: 0 });
  await editor.escape();
  const twoWallRows = await editor.planRows();
  await shot(page, "carried-walls-on-both-tables");

  expect((await editor.poses()).map(({ x, z }) => [x, z])).toEqual([[0, 0]]);
  expect(outlineRows(oneWallRows)).toEqual([]);
  expect(outlineRows(oneStudEast)).toEqual([
    `trackSeam: Track carried by my-run-and-wall.ldr at ${2 * STUD_LDU}, 0 stands across the seam ${ACROSS_THE_SEAM}`,
  ]);
  expect(outlineRows(twoWallRows)).toEqual([
    `seam: my-run-and-walls.ldr at 0, 0 stands across the seam ${ACROSS_THE_SEAM}`,
  ]);
});

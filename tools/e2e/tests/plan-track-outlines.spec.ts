import { expect, test, type Page } from "@playwright/test";
import { EditorPage, type PlanRow } from "./editor-page.ts";

const SEAM_LDU = 320;
const TABLE_HALF_DEPTH_LDU = 640;
const STRAIGHT_LDU = 320;
const BEYOND_EDGE_Z_LDU = 600;
const ACROSS_THE_SEAM = `between tables "Table 1" and "Table 2"; a seam must fall between placements.`;
const OUTLINE_RULES: ReadonlySet<string> = new Set(["trackSeam", "trackOffTable", "fit", "seam"]);

function outlineRows(rows: ReadonlyArray<PlanRow>): ReadonlyArray<string> {
  return rows
    .filter((row) => OUTLINE_RULES.has(row.rule))
    .map((row) => `${row.rule}: ${row.message}`);
}

async function planShot(page: Page, name: string): Promise<void> {
  await page.locator(".plan-panel").screenshot({ path: test.info().outputPath(`${name}.png`) });
}

test("a plan lists drawn track whose body spans the seam between two abutting tables, excuses a joint that sits on the seam, and lists a straight drawn past the table's edge by its outline", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(400);
  await editor.drawTable(
    { x: -4 * SEAM_LDU, z: -TABLE_HALF_DEPTH_LDU },
    { x: SEAM_LDU, z: TABLE_HALF_DEPTH_LDU },
  );
  await editor.drawTable(
    { x: 5 * SEAM_LDU, z: TABLE_HALF_DEPTH_LDU },
    { x: SEAM_LDU, z: -TABLE_HALF_DEPTH_LDU },
  );
  await editor.press("t");
  await editor.dragTrack({ x: 0, z: 0 }, { x: 2 * STRAIGHT_LDU, z: 0 });
  const joined = await editor.planRows();
  await editor.dragTrack(
    { x: SEAM_LDU - STRAIGHT_LDU / 2, z: SEAM_LDU },
    { x: SEAM_LDU + STRAIGHT_LDU / 2, z: SEAM_LDU },
  );
  await editor.dragTrack(
    { x: -3 * STRAIGHT_LDU, z: BEYOND_EDGE_Z_LDU },
    { x: -2 * STRAIGHT_LDU, z: BEYOND_EDGE_Z_LDU },
  );
  const drawn = await editor.planRows();
  await planShot(page, "plan-track-across-the-seam-and-off-the-table");
  await page.screenshot({
    path: test.info().outputPath("track-across-the-seam-and-off-the-table.png"),
  });
  const laid = await editor.laidTrack();
  await editor.undo();
  await editor.undo();
  const undone = await editor.planRows();
  await editor.redo();
  const redone = await editor.planRows();

  expect(laid.map((piece) => [piece.position[0], piece.position[4], piece.heading])).toEqual([
    ["0", "0", 0],
    ["16", "0", 0],
    ["8", "16", 0],
    ["-48", "30", 0],
  ]);
  expect(outlineRows(joined)).toEqual([]);
  expect(outlineRows(drawn)).toEqual([
    `trackSeam: Train Track 9V Straight #3 stands across the seam ${ACROSS_THE_SEAM}`,
    "trackOffTable: Train Track 9V Straight #4 overhangs the tables: part of its outline is more than 0 mm past the edge of every table.",
  ]);
  expect(outlineRows(undone)).toEqual([]);
  expect(outlineRows(redone)).toEqual([
    `trackSeam: Train Track 9V Straight #3 stands across the seam ${ACROSS_THE_SEAM}`,
  ]);
});

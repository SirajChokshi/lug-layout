import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { EditorPage, TRACK_ITEM, type LatticePoint } from "./editor-page.ts";

const STRAIGHT_PIECE = "track-piece:ldraw:74746";
const STRAIGHT_LDU = 320;
const RUN_STRAIGHTS = 5;
const TABLE_FROM: LatticePoint = { x: -800, z: -320 };
const TABLE_TO: LatticePoint = { x: 640, z: 320 };
const RUN_START: LatticePoint = { x: 400, z: 0 };
const RUN_END: LatticePoint = { x: RUN_START.x - RUN_STRAIGHTS * STRAIGHT_LDU, z: 0 };
const LAST_PIECE_CENTRE: LatticePoint = { x: RUN_END.x + STRAIGHT_LDU / 2, z: 0 };
const SHED_AT: LatticePoint = { x: -1120, z: -480 };
const BEHIND_THE_VIEW: LatticePoint = { x: 0, z: -8000 };
const ZOOM_IN = 2400;
const SHED = "my-shed.ldr";
const FAILING = 0;
const WARNED = 1;
const PASSING = 2;

function shed(): string {
  return [
    "0 My shed",
    `0 Name: ${SHED}`,
    "0 Author: lug-layout e2e (a user's model written at test time from official parts)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3958.dat",
    "1 4 0 -24 0 1 0 0 0 1 0 0 0 1 3001.dat",
    "",
  ].join("\n");
}

function rankOf({ errors, warnings }: { readonly errors: number; readonly warnings: number }) {
  if (errors > 0) return FAILING;
  return warnings > 0 ? WARNED : PASSING;
}

async function shown(editor: EditorPage, centre: LatticePoint) {
  return {
    item: await editor.root.getAttribute("data-selection"),
    count: await editor.selectionCount(),
    framed: await editor.screenOf(centre).then(
      () => true,
      () => false,
    ),
  };
}

test("each plan issue is a row under its rule, failing rules first, and clicking it selects the parts it names and frames them: a user's own model off the table and the open end of a run that runs off it", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  await editor.zoom(900);
  await editor.drawTable(TABLE_FROM, TABLE_TO);
  const file = test.info().outputPath(SHED);
  await writeFile(file, shed());
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  await editor.placeAt(imported.item, SHED_AT);
  await editor.escape();
  await editor.choose(TRACK_ITEM);
  const laid = await editor.dragTrack(RUN_START, RUN_END);
  await editor.escape();
  await editor.escape();
  const ranks = (
    await page.locator(".plan-checks > li[data-check]").evaluateAll((rows) =>
      rows.map((row) => ({
        errors: Number(row.getAttribute("data-check-errors")),
        warnings: Number(row.getAttribute("data-check-warnings")),
      })),
    )
  ).map(rankOf);

  await editor.goTo(BEHIND_THE_VIEW);
  await editor.zoom(-ZOOM_IN);
  const before = await shown(editor, SHED_AT);
  await editor.showPlanIssue("fit", SHED);
  const shedRow = await shown(editor, SHED_AT);
  await page.screenshot({ path: test.info().outputPath("own-model-off-the-table.png") });
  await editor.goTo(BEHIND_THE_VIEW);
  await editor.showPlanIssue("trackOpenEnd", `#${RUN_STRAIGHTS}:`);
  const openEndRow = await shown(editor, LAST_PIECE_CENTRE);
  await page.screenshot({ path: test.info().outputPath("open-end.png") });

  expect(laid.pieces).toBe(RUN_STRAIGHTS);
  expect(ranks[0]).toBe(FAILING);
  expect(ranks).toEqual(ranks.toSorted((a, b) => a - b));
  expect(before).toEqual({ item: "", count: 0, framed: false });
  expect(shedRow).toEqual({ item: imported.item, count: 1, framed: true });
  expect(openEndRow).toEqual({ item: STRAIGHT_PIECE, count: 1, framed: true });
});

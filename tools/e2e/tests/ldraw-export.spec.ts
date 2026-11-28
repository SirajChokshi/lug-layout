import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { customBricksMpd, studioArchive } from "./custom-files.ts";
import { EditorPage, TRACK_ITEM, type LatticePoint } from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const ORIGIN: LatticePoint = { x: 0, z: 0 };
const BESIDE: LatticePoint = { x: 0, z: 200 };
const RUN_FROM: LatticePoint = { x: 160, z: -800 };
const RUN_TO: LatticePoint = { x: 1120, z: -800 };
const PLACEMENTS = 3;
const CUSTOM_PARTS = ["stud-brick.dat", "own-stud-brick.dat", "unlicensed.dat", "studiobrick.dat"];
const SUBFILE_LINE = /^1\s/u;

function sectionLines(text: string, name: string): ReadonlyArray<string> {
  const lines = text.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `0 FILE ${name}`);
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && /^0\s+FILE\s/iu.test(line.trim()));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

async function exportLdraw(page: Page): Promise<{ readonly name: string; readonly path: string }> {
  const menu = page.locator(".world-menu");
  if ((await menu.getAttribute("open")) === null) await menu.locator("> summary").click();
  const download = page.waitForEvent("download");
  await page.locator('[data-action="export-ldraw"]').click();
  const file = await download;
  const path = test.info().outputPath(file.suggestedFilename());
  await file.saveAs(path);
  return { name: file.suggestedFilename(), path };
}

test("exports a user's MPD and Studio file on a baseplate beside laid track as one LDraw .mpd, every placement a line of the layout, that imports back with the user's own parts", async ({
  page,
}) => {
  const mpd = test.info().outputPath("custom-bricks.mpd");
  const io = test.info().outputPath("custom-brick.io");
  await writeFile(mpd, await customBricksMpd());
  await writeFile(io, await studioArchive());
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const fromMpd = await editor.importModel(mpd);
  const fromStudio = await editor.importModel(io);
  expect(fromMpd.status, fromMpd.text).toBe("placeable");
  expect(fromStudio.status, fromStudio.text).toBe("placeable");

  await editor.zoom(400);
  await editor.placeAt(BASEPLATE, ORIGIN);
  await editor.escape();
  await editor.placeAt(fromMpd.item, BESIDE);
  await editor.escape();
  await editor.placeAt(fromStudio.item, ORIGIN);
  await editor.escape();
  await editor.choose(TRACK_ITEM);
  const laid = await editor.dragTrack(RUN_FROM, RUN_TO);
  await editor.escape();
  expect(laid.lastCommit).toBe("laid");
  expect(await editor.poses()).toHaveLength(PLACEMENTS);
  await page.screenshot({ path: test.info().outputPath("layout-before-export.png") });

  const exported = await exportLdraw(page);
  const text = await readFile(exported.path, "utf8");
  const layoutLines = sectionLines(text, "Layout.ldr").filter((line) => SUBFILE_LINE.test(line));
  const back = await editor.importModel(exported.path);
  const report = page.locator(`.model-import[data-file="${exported.name}"]`);
  await report.locator(".model-import-report summary").click();
  const custom = await report
    .locator('[data-kind="custom"]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-part") ?? ""));
  await report.screenshot({ path: test.info().outputPath("exported-mpd-reimported.png") });

  expect(exported.name).toBe("World-1.mpd");
  expect(sectionLines(text, "custom-bricks.ldr").length).toBeGreaterThan(0);
  expect(layoutLines).toHaveLength(PLACEMENTS + laid.pieces);
  expect(back.status, back.text).toBe("placeable");
  expect(CUSTOM_PARTS.filter((part) => !custom.some((id) => id.endsWith(`/${part}`)))).toEqual([]);
});

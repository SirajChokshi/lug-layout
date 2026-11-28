import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { NON_CA, customBricksMpd, studioArchive } from "./custom-files.ts";
import { EditorPage, byPosition, type LatticePoint } from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const PLATES_PER_BRICK = 3;
const ORIGIN: LatticePoint = { x: 0, z: 0 };
const BESIDE: LatticePoint = { x: 0, z: 200 };

async function openReport(page: Page, file: string) {
  const status = page.locator(`.model-import[data-file="${file}"]`);
  await status.locator(".model-import-report summary").click();
  return status;
}

test("custom parts from an MPD and a Studio file are drawn and badged whatever licence they name, or none, seat on a baseplate and take a copy on their studs", async ({
  page,
}) => {
  const mpd = test.info().outputPath("custom-bricks.mpd");
  const io = test.info().outputPath("custom-brick.io");
  await writeFile(mpd, await customBricksMpd());
  await writeFile(io, await studioArchive());
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();

  const fromMpd = await editor.importModel(mpd);
  expect(fromMpd.status, fromMpd.text).toBe("placeable");
  const report = await openReport(page, "custom-bricks.mpd");
  const custom = report.locator('[data-kind="custom"]');
  await expect(custom).toHaveCount(3);
  await expect(report.locator('[data-kind="custom"][data-part$="/stud-brick.dat"]')).toContainText(
    "Unofficial_Part",
  );
  await expect(report.locator('[data-kind="custom"][data-part$="/unlicensed.dat"]')).toContainText(
    "no licence",
  );
  await expect(custom.locator('[data-badge="custom"]')).toHaveCount(3);
  await expect(report.locator(".not-drawn")).toHaveCount(0);
  await expect(
    page.locator(`.palette [data-item="${fromMpd.item}"] [data-badge="custom"]`),
  ).toBeVisible();
  await report.screenshot({ path: test.info().outputPath("custom-bricks-report.png") });

  const fromStudio = await editor.importModel(io);
  expect(fromStudio.status, fromStudio.text).toBe("placeable");
  const studioReport = await openReport(page, "custom-brick.io");
  await expect(studioReport.locator('[data-kind="custom"]')).toContainText(
    "a Studio CustomParts file",
  );
  await expect(studioReport.locator('[data-kind="custom"]')).toContainText(NON_CA);
  await expect(
    page.locator(`.palette [data-item="${fromStudio.item}"] [data-badge="custom"]`),
  ).toBeVisible();
  await studioReport.screenshot({ path: test.info().outputPath("custom-brick-studio-report.png") });

  await editor.zoom(400);
  await editor.placeAt(BASEPLATE, ORIGIN);
  await editor.escape();
  await editor.placeAt(fromMpd.item, BESIDE);
  await editor.escape();
  await editor.placeAt(fromStudio.item, ORIGIN);
  await editor.placeAt(fromStudio.item, ORIGIN);
  await editor.escape();
  expect(await editor.poses()).toEqual(
    [
      { item: BASEPLATE, ...ORIGIN, yPlates: 0, rot: 0 },
      { item: fromMpd.item, ...BESIDE, yPlates: 0, rot: 0 },
      { item: fromStudio.item, ...ORIGIN, yPlates: 0, rot: 0 },
      { item: fromStudio.item, ...ORIGIN, yPlates: PLATES_PER_BRICK, rot: 0 },
    ].toSorted(byPosition),
  );
  await page.screenshot({ path: test.info().outputPath("custom-bricks-seated.png") });
});

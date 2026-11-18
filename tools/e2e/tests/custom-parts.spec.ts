import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { storedZip } from "../src/stored-zip.ts";
import { EditorPage } from "./editor-page.ts";

const CC_BY_4 = "Licensed under CC BY 4.0 : see CAreadme.txt";
const PINNED_BRICK = new URL("../../../.cache/ldraw/parts/3001.dat", import.meta.url);
const BRICK_PLATES = 3;
const ORIGIN = { x: 0, z: 0 } as const;

async function brickGeometry(): Promise<ReadonlyArray<string>> {
  const text = await readFile(PINNED_BRICK, "utf8");
  return text.split(/\r?\n/u).filter((line) => /^[1-5] /u.test(line));
}

function customBrick(
  name: string,
  license: string | null,
  geometry: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [
    `0 Custom brick ${name} written for the custom parts test`,
    `0 Name: ${name}`,
    "0 Author: lug-layout e2e (generated at test time) [James Jessiman]",
    "0 !LDRAW_ORG Unofficial_Part",
    ...(license === null ? [] : [`0 !LICENSE ${license}`]),
    "0 !HISTORY 2026-11-18 [lug-layout] Modified from LDraw parts/3001.dat: renamed",
    ...geometry,
  ];
}

function mpdText(geometry: ReadonlyArray<string>): string {
  return [
    "0 FILE custom-brick.ldr",
    "0 Custom brick model for the custom parts test",
    "0 Name: custom-brick.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LDRAW_ORG Model",
    `0 !LICENSE ${CC_BY_4}`,
    "1 4 0 0 0 1 0 0 0 1 0 0 0 1 mybrick.dat",
    "1 2 0 0 80 1 0 0 0 1 0 0 0 1 unlicensed.dat",
    "0 NOFILE",
    "0 FILE mybrick.dat",
    ...customBrick("mybrick.dat", CC_BY_4, geometry),
    "0 NOFILE",
    "0 FILE unlicensed.dat",
    ...customBrick("unlicensed.dat", null, geometry),
    "0 NOFILE",
    "",
  ].join("\n");
}

function studioArchive(geometry: ReadonlyArray<string>): Uint8Array {
  return storedZip([
    ["model.ldr", "1 1 0 0 0 1 0 0 0 1 0 0 0 1 studiobrick.dat\n"],
    ["CustomParts/studiobrick.dat", customBrick("studiobrick.dat", CC_BY_4, geometry).join("\n")],
  ]);
}

async function openReport(page: Page, file: string) {
  const status = page.locator(`.model-import[data-file="${file}"]`);
  await status.locator(".model-import-report summary").click();
  return status;
}

test("Unofficial_Part custom parts with a CA licence header are drawn, badged and stacked on, and the same part without one is reported, from an MPD and a Studio file", async ({
  page,
}) => {
  const geometry = await brickGeometry();
  const mpd = test.info().outputPath("custom-brick.mpd");
  const io = test.info().outputPath("custom-brick.io");
  await writeFile(mpd, mpdText(geometry));
  await writeFile(io, studioArchive(geometry));
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();

  const fromMpd = await editor.importModel(mpd);
  expect(fromMpd.status, fromMpd.text).toBe("placeable");
  const mpdReport = await openReport(page, "custom-brick.mpd");
  const custom = mpdReport.locator('[data-kind="custom"]');
  await expect(custom).toHaveCount(1);
  await expect(custom).toContainText("mybrick.dat");
  await expect(custom).toContainText("Unofficial_Part");
  await expect(custom.locator('[data-badge="custom"]')).toBeVisible();
  await expect(custom.locator('[data-kind="inferredConnectors"]')).toContainText("unverified");
  await expect(mpdReport.locator('.not-drawn [data-kind="customRefused"]')).toContainText(
    "no CA licence header",
  );
  await expect(
    page.locator(`.palette [data-item="${fromMpd.item}"] [data-badge="custom"]`),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("custom-brick-mpd-report.png") });

  await editor.zoom(400);
  await editor.placeAt(fromMpd.item, ORIGIN);
  await editor.placeAt(fromMpd.item, ORIGIN);
  await editor.escape();
  expect((await editor.poses()).map((pose) => pose.yPlates)).toEqual([0, BRICK_PLATES]);
  await page.screenshot({ path: test.info().outputPath("custom-brick-stacked.png") });

  const fromStudio = await editor.importModel(io);
  expect(fromStudio.status, fromStudio.text).toBe("placeable");
  const studioReport = await openReport(page, "custom-brick.io");
  await expect(studioReport.locator('[data-kind="custom"]')).toContainText(
    "a Studio CustomParts file",
  );
  await expect(
    page.locator(`.palette [data-item="${fromStudio.item}"] [data-badge="custom"]`),
  ).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("custom-brick-studio-report.png") });
});

import { expect, test, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { writeStoredZip } from "@brr/storage/zip";
import { EditorPage, byPosition, type LatticePoint } from "./editor-page.ts";

const CC_BY_4 = "Licensed under CC BY 4.0 : see CAreadme.txt";
const NON_CA = "Not redistributable : see NonCAreadme.txt";
const PINNED_LIBRARY = new URL("../../../.cache/ldraw/", import.meta.url);
const BASEPLATE = "ldraw:3811@2";
const PLATES_PER_BRICK = 3;
const ORIGIN: LatticePoint = { x: 0, z: 0 };
const BESIDE: LatticePoint = { x: 0, z: 200 };
const GEOMETRY_LINE = /^(?:[1-5] |0 BFC (?!CERTIFY))/u;
const STUD_REFERENCE = / stud\.dat$/u;

async function pinnedGeometry(path: string): Promise<ReadonlyArray<string>> {
  const text = await readFile(new URL(path, PINNED_LIBRARY), "utf8");
  return text.split(/\r?\n/u).filter((line) => GEOMETRY_LINE.test(line));
}

function customPart(
  name: string,
  license: string | null,
  from: string,
  geometry: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return [
    `0 FILE ${name}`,
    `0 Custom part ${name} written for the custom parts test`,
    `0 Name: ${name}`,
    "0 Author: lug-layout e2e (generated at test time) [James Jessiman]",
    "0 !LDRAW_ORG Unofficial_Part",
    ...(license === null ? [] : [`0 !LICENSE ${license}`]),
    `0 !HISTORY 2026-11-20 [lug-layout] Modified from LDraw ${from}: renamed`,
    "0 BFC CERTIFY CCW",
    ...geometry,
    "0 NOFILE",
  ];
}

async function customBricksMpd(): Promise<string> {
  const [brick, lower, stud] = await Promise.all([
    pinnedGeometry("parts/3001.dat"),
    pinnedGeometry("parts/s/3001s01.dat"),
    pinnedGeometry("p/stud.dat"),
  ]);
  const walls = brick.filter((line) => !line.startsWith("1 "));
  const ownStuds = lower.map((line) => line.replace(STUD_REFERENCE, " own-stud.dat"));
  return [
    "0 FILE custom-bricks.ldr",
    "0 Custom bricks for the custom parts test",
    "0 Name: custom-bricks.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LDRAW_ORG Model",
    `0 !LICENSE ${CC_BY_4}`,
    "1 4 -40 0 0 1 0 0 0 1 0 0 0 1 stud-brick.dat",
    "1 1 40 0 0 1 0 0 0 1 0 0 0 1 own-stud-brick.dat",
    "1 2 0 0 80 1 0 0 0 1 0 0 0 1 unlicensed.dat",
    "0 NOFILE",
    ...customPart("stud-brick.dat", CC_BY_4, "parts/3001.dat", brick),
    ...customPart("own-stud-brick.dat", CC_BY_4, "parts/s/3001s01.dat", [...walls, ...ownStuds]),
    ...customPart("own-stud.dat", CC_BY_4, "p/stud.dat", stud),
    ...customPart("unlicensed.dat", null, "parts/3001.dat", brick),
    "",
  ].join("\n");
}

async function studioArchive(): Promise<Uint8Array> {
  const brick = await pinnedGeometry("parts/3001.dat");
  const utf8 = new TextEncoder();
  return writeStoredZip([
    { name: "model.ldr", bytes: utf8.encode("1 1 0 0 0 1 0 0 0 1 0 0 0 1 studiobrick.dat\n") },
    {
      name: "CustomParts/studiobrick.dat",
      bytes: utf8.encode(
        customPart("studiobrick.dat", NON_CA, "parts/3001.dat", brick).slice(1, -1).join("\n"),
      ),
    },
  ]);
}

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

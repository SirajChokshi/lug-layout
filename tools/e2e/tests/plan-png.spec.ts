import { expect, test, type Locator, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { readZip } from "@brr/storage/zip";
import { EditorPage, type LatticePoint } from "./editor-page.ts";

const MODEL_FILE = "my-yard-shed.ldr";
const TABLE_ONE: readonly [LatticePoint, LatticePoint] = [
  { x: -1600, z: -640 },
  { x: 0, z: 640 },
];
const TABLE_TWO: readonly [LatticePoint, LatticePoint] = [
  { x: 1440, z: 640 },
  { x: 0, z: -640 },
];
const ON_TABLE_ONE: LatticePoint = { x: -800, z: 0 };
const PNG_PIXELS_PER_MM = 4;
const MAX_TILE_PX = 4096;
const TABLE_TOP = [234, 217, 189] as const;
const PLACEMENT_INK = [27, 79, 114] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR_WIDTH_OFFSET = 16;
const IHDR_HEIGHT_OFFSET = 20;
const TILE_NAME = /^\d+-sheet-([A-Z]+)(\d+)\.png$/u;
const SVG_SIZE = /<svg [^>]*width="([\d.]+)mm" height="([\d.]+)mm"/u;

function customModel(): string {
  return [
    "0 My yard shed, a user's own model built from official parts",
    `0 Name: ${MODEL_FILE}`,
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
    "1 4 -280 -24 -280 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 1 0 -24 0 1 0 0 0 1 0 0 0 1 3003.dat",
    "1 14 260 -24 290 1 0 0 0 1 0 0 0 1 3700.dat",
    "",
  ].join("\n");
}

interface Downloaded {
  readonly name: string;
  readonly bytes: Uint8Array;
}

async function downloaded(page: Page, button: Locator): Promise<Downloaded> {
  const [file] = await Promise.all([page.waitForEvent("download"), button.click()]);
  return {
    name: file.suggestedFilename(),
    bytes: new Uint8Array(await readFile(await file.path())),
  };
}

function pngSize(bytes: Uint8Array): readonly [number, number] {
  expect([...bytes.subarray(0, PNG_SIGNATURE.length)]).toEqual(PNG_SIGNATURE);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(IHDR_WIDTH_OFFSET), view.getUint32(IHDR_HEIGHT_OFFSET)];
}

function pagePixels(svg: Downloaded): readonly [number, number] {
  const size = SVG_SIZE.exec(new TextDecoder().decode(svg.bytes));
  if (!size) throw new Error(`${svg.name} has no size in millimetres`);
  return [
    Math.ceil(Number(size[1]) * PNG_PIXELS_PER_MM),
    Math.ceil(Number(size[2]) * PNG_PIXELS_PER_MM),
  ];
}

async function decoded(page: Page, png: Uint8Array) {
  return page.evaluate(
    async ({ bytes, wanted }) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(bytes)], { type: "image/png" }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2D canvas to read the PNG back");
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const counts = wanted.map(() => 0);
      for (let i = 0; i < data.length; i += 4) {
        wanted.forEach(([r, g, b], k) => {
          if (data[i] === r && data[i + 1] === g && data[i + 2] === b) {
            counts[k] = (counts[k] ?? 0) + 1;
          }
        });
      }
      return { size: [bitmap.width, bitmap.height], tableTop: counts[0], placement: counts[1] };
    },
    { bytes: [...png], wanted: [TABLE_TOP, PLACEMENT_INK] },
  );
}

test("a plan of two tables holding a user's own model downloads as a PNG at the pixels per stud chosen, 4 px for every millimetre of its sheet, and past 4096 px as tiles named by column and row that cover the sheet", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const modelFile = test.info().outputPath(MODEL_FILE);
  await writeFile(modelFile, customModel());
  const model = await editor.importModel(modelFile);
  expect(model.status, model.text).toBe("placeable");
  await editor.escape();
  await editor.zoom(500);
  await editor.drawTable(...TABLE_ONE);
  await editor.drawTable(...TABLE_TWO);
  await editor.escape();
  await editor.placeAt(model.item, ON_TABLE_ONE);
  await editor.escape();

  await page.locator(".plan-panel > summary").click();
  const sheets = page.getByRole("region", { name: "Print sheets" });
  const download = sheets.getByRole("button", { name: "Download sheet" });
  await sheets.locator('select[name="sheet-layout"]').selectOption("image");
  await expect(sheets.locator('select[name="sheet-format"]')).toHaveValue("png");
  await expect(sheets.locator('input[name="sheet-pixels-per-stud"]')).toHaveValue("8");
  const eight = await downloaded(page, download);
  await sheets.locator('select[name="sheet-format"]').selectOption("svg");
  const eightSvg = await downloaded(page, download);
  await sheets.locator('input[name="sheet-pixels-per-stud"]').fill("32");
  const fullSizeSvg = await downloaded(page, download);
  await sheets.locator('select[name="sheet-format"]').selectOption("png");
  const fullSize = await downloaded(page, download);
  await expect(
    sheets.getByText(/^sheet is split into \d+ columns? and \d+ rows? of /u),
  ).toBeVisible();
  await writeFile(test.info().outputPath(eight.name), eight.bytes);
  await writeFile(test.info().outputPath(fullSize.name), fullSize.bytes);

  expect(eight.name).toBe("Plan-1.main-plan-8px-per-stud.png");
  expect(pngSize(eight.bytes)).toEqual(pagePixels(eightSvg));
  const drawn = await decoded(page, eight.bytes);
  expect(drawn.size).toEqual(pngSize(eight.bytes));
  expect(drawn.tableTop).toBeGreaterThan(0);
  expect(drawn.placement).toBeGreaterThan(0);

  expect(fullSize.name).toBe("Plan-1.main-plan-32px-per-stud.png.zip");
  const zip = await readZip(fullSize.bytes);
  const tiles = [...(zip.ok ? zip.value : [])].map(([name, bytes]) => {
    const [, column, row] = TILE_NAME.exec(name) ?? [];
    return { column, row: Number(row), bytes, size: pngSize(bytes) };
  });
  const columns = new Set(tiles.map((tile) => tile.column)).size;
  const rows = new Set(tiles.map((tile) => tile.row)).size;
  const [tileWidth = 0, tileHeight = 0] = tiles[0]?.size ?? [];
  const [pageWidth, pageHeight] = pagePixels(fullSizeSvg);
  const contents = await Promise.all(tiles.map((tile) => decoded(page, tile.bytes)));
  expect(tiles.length).toBeGreaterThan(1);
  expect(tiles.length).toBe(columns * rows);
  expect(new Set(tiles.map((tile) => tile.size.join("×")))).toEqual(
    new Set([`${tileWidth}×${tileHeight}`]),
  );
  expect(Math.max(tileWidth, tileHeight)).toBeLessThanOrEqual(MAX_TILE_PX);
  expect({
    coversWidth: columns * tileWidth >= pageWidth && columns * tileWidth - pageWidth < columns,
    coversHeight: rows * tileHeight >= pageHeight && rows * tileHeight - pageHeight < rows,
  }).toEqual({ coversWidth: true, coversHeight: true });
  expect(contents.map((tile) => tile.size.join("×"))).toEqual(
    tiles.map((tile) => tile.size.join("×")),
  );
  expect(contents.reduce((sum, tile) => sum + (tile.tableTop ?? 0), 0)).toBeGreaterThan(0);
  expect(contents.reduce((sum, tile) => sum + (tile.placement ?? 0), 0)).toBeGreaterThan(0);
});

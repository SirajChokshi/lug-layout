import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, type LatticePoint } from "./editor-page.ts";

const PALETTE_MODULE = "generated:mils-plain";
const MODULE_AIM: LatticePoint = { x: 380, z: 420 };
const BAKED_AIM: LatticePoint = { x: -320, z: 420 };
const COMPILED_AIM: LatticePoint = { x: -1020, z: 420 };
const DIAGNOSTICS = /\/rolling-diagnostics[./]/u;
const BAKE_BUCKET = /\/library-bake\/buckets\//u;
const BAKE_DIAGNOSTICS = /\/library-bake\/rolling-diagnostics\//u;
const BUNDLE_DIAGNOSTICS = /\/rolling-diagnostics\.[0-9a-f]{16}\.json$/u;
const LIBRARY_BAKE_URL = "**/library-bake/**";
const PRINTED_ROUND_BRICK = "ldraw:3941p01";
const PRINTED_ROUND_BRICK_ROWS = 13;
const PRINTED_ROUND_BRICK_ARCS = 5;
const LATTICE_PILLAR = "ldraw:2580";
const NOT_KEPT = "were computed at import and their rows aren't kept";

function model(name: string, part: string): string {
  return [
    `0 Model with ${part} on a baseplate, built for the rolling diagnostics test`,
    `0 Name: ${name}`,
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
    `1 4 -200 -24 -200 1 0 0 0 1 0 0 0 1 ${part}`,
    "",
  ].join("\n");
}

test("the inspector alone loads rolling diagnostics: a placement session and imports, from the library bake or compiled, fetch none, and asking shows each part's rows or why it has none", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
  const diagnosticsRequests = (): ReadonlyArray<string> =>
    requested.filter((path) => DIAGNOSTICS.test(path));
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();

  await editor.zoom(400);
  await editor.placeAt(PALETTE_MODULE, MODULE_AIM);
  await editor.escape();
  expect(diagnosticsRequests(), "a placement session").toEqual([]);

  const bakedFile = test.info().outputPath("printed-round-brick.ldr");
  await writeFile(bakedFile, model("printed-round-brick.ldr", "3941p01.dat"));
  const baked = await editor.importModel(bakedFile);
  expect(baked.status, baked.text).toBe("placeable");
  expect(
    requested.some((path) => BAKE_BUCKET.test(path)),
    "the import reads the bake",
  ).toBe(true);
  await editor.placeAt(baked.item, BAKED_AIM);

  await page.context().route(LIBRARY_BAKE_URL, (route) => route.abort());
  const compiledFile = test.info().outputPath("lattice-pillar.ldr");
  await writeFile(compiledFile, model("lattice-pillar.ldr", "2580.dat"));
  const compiled = await editor.importModel(compiledFile);
  await page.context().unroute(LIBRARY_BAKE_URL);
  expect(compiled.status, compiled.text).toBe("placeable");
  await editor.placeAt(compiled.item, COMPILED_AIM);
  await editor.escape();
  expect(diagnosticsRequests(), "two imports, one from the bake").toEqual([]);

  const inspector = page.getByRole("region", { name: "Inspector" });
  const showBands = async (): Promise<ReadonlyArray<string>> => {
    const before = diagnosticsRequests().length;
    await inspector.getByRole("button", { name: "Show unread rolling bands" }).click();
    await expect(inspector.getByLabel("Unread rolling bands")).toBeVisible();
    return diagnosticsRequests().slice(before);
  };
  const part = (partId: string) =>
    inspector.getByLabel("Unread rolling bands").locator(".rolling-diagnostics-part", {
      hasText: partId,
    });

  expect(await editor.select(MODULE_AIM)).toBe(PALETTE_MODULE);
  const bundleAsked = await showBands();
  expect(bundleAsked).toHaveLength(1);
  expect(bundleAsked.every((path) => BUNDLE_DIAGNOSTICS.test(path))).toBe(true);
  await inspector.screenshot({ path: test.info().outputPath("inspector-module.png") });

  expect(await editor.select(BAKED_AIM)).toBe(baked.item);
  const bakeAsked = await showBands();
  expect(bakeAsked.length).toBeGreaterThan(0);
  expect(bakeAsked.every((path) => BAKE_DIAGNOSTICS.test(path))).toBe(true);
  await expect(part(PRINTED_ROUND_BRICK).locator("li")).toHaveCount(PRINTED_ROUND_BRICK_ROWS);
  await expect(part(PRINTED_ROUND_BRICK).locator("li", { hasText: /^arcs:/u })).toHaveCount(
    PRINTED_ROUND_BRICK_ARCS,
  );
  await inspector.screenshot({ path: test.info().outputPath("inspector-library-bake.png") });

  expect(await editor.select(COMPILED_AIM)).toBe(compiled.item);
  expect(await showBands()).toEqual([]);
  await expect(part(LATTICE_PILLAR)).toContainText(NOT_KEPT);
  await expect(part(LATTICE_PILLAR).locator("li")).toHaveCount(0);
  await inspector.screenshot({ path: test.info().outputPath("inspector-compiled-at-import.png") });
});

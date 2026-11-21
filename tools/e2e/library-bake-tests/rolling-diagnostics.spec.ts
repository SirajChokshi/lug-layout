import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, type LatticePoint } from "../tests/editor-page.ts";

const BAKED_AIM: LatticePoint = { x: 380, z: 420 };
const DIAGNOSTICS = /\/rolling-diagnostics[./]/u;
const BAKE_BUCKET = /\/library-bake\/buckets\//u;
const BAKE_DIAGNOSTICS = /\/library-bake\/rolling-diagnostics\//u;
const BUNDLE_DIAGNOSTICS = /\/rolling-diagnostics\.[0-9a-f]{16}\.json$/u;
const PRINTED_ROUND_BRICK = "ldraw:3941p01";
const PRINTED_ROUND_BRICK_ROWS = 13;
const PRINTED_ROUND_BRICK_ARCS = 5;

function printedRoundBrickModel(): string {
  return [
    "0 Printed round brick on a baseplate, built for the rolling diagnostics test",
    "0 Name: printed-round-brick.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
    "1 4 -200 -24 -200 1 0 0 0 1 0 0 0 1 3941p01.dat",
    "",
  ].join("\n");
}

test("an import that takes parts from the library bake fetches no rolling diagnostics until the selection panel asks, then only its bake bucket's file", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
  const diagnosticsRequests = (): ReadonlyArray<string> =>
    requested.filter((path) => DIAGNOSTICS.test(path));
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();

  await editor.zoom(400);
  const file = test.info().outputPath("printed-round-brick.ldr");
  await writeFile(file, printedRoundBrickModel());
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  expect(
    requested.some((path) => BAKE_BUCKET.test(path)),
    "the import reads the bake",
  ).toBe(true);
  await editor.placeAt(imported.item, BAKED_AIM);
  expect(await editor.select(BAKED_AIM)).toBe(imported.item);
  expect(diagnosticsRequests(), "an import that takes parts from the bake").toEqual([]);

  const panel = page.getByRole("region", { name: "Selection" });
  await panel.getByRole("button", { name: "Show unread rolling bands" }).click();
  const bands = panel.getByLabel("Unread rolling bands");
  await expect(bands).toBeVisible();
  const asked = diagnosticsRequests();
  expect(asked.filter((path) => BAKE_DIAGNOSTICS.test(path)).length).toBeGreaterThan(0);
  expect(asked.every((path) => BAKE_DIAGNOSTICS.test(path) || BUNDLE_DIAGNOSTICS.test(path))).toBe(
    true,
  );
  const brick = bands.locator(".rolling-diagnostics-part", { hasText: PRINTED_ROUND_BRICK });
  await expect(brick.locator("li")).toHaveCount(PRINTED_ROUND_BRICK_ROWS);
  await expect(brick.locator("li", { hasText: /^arcs:/u })).toHaveCount(PRINTED_ROUND_BRICK_ARCS);
  await panel.screenshot({ path: test.info().outputPath("selection-panel-library-bake.png") });
});

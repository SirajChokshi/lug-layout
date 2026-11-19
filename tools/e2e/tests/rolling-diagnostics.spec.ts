import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, type LatticePoint } from "./editor-page.ts";

const PALETTE_MODULE = "generated:mils-plain";
const MODULE_AIM: LatticePoint = { x: 380, z: 420 };
const IMPORT_AIM: LatticePoint = { x: -320, z: 420 };
const DIAGNOSTICS = /\/rolling-diagnostics[./]/u;
const BAKE_BUCKET = /\/library-bake\/buckets\//u;
const BAKE_DIAGNOSTICS = /\/library-bake\/rolling-diagnostics\//u;
const BUNDLE_DIAGNOSTICS = /\/rolling-diagnostics\.[0-9a-f]{16}\.json$/u;
const PRINTED_ROUND_BRICK = "ldraw:3941p01";
const PRINTED_ROUND_BRICK_ROWS = 13;
const PRINTED_ROUND_BRICK_ARCS = 5;
const DRUM_TITLE = "Custom Drum with Two Inset Panels";
const DRUM_SIDES = 16;
const DRUM_RADIUS = 20;
const PANEL_RADIUS = 19.6;
const PANELLED_SIDES = new Set([2, 3, 4, 5, 10, 11, 12, 13]);

function rim(radius: number, side: number, y: number): string {
  const angle = (2 * Math.PI * (side % DRUM_SIDES)) / DRUM_SIDES;
  return `${(radius * Math.cos(angle)).toFixed(6)} ${y} ${(radius * Math.sin(angle)).toFixed(6)}`;
}

function wall(radius: number, side: number, low: number, high: number): string {
  return `4 16 ${rim(radius, side + 1, low)} ${rim(radius, side, low)} ${rim(radius, side, high)} ${rim(radius, side + 1, high)}`;
}

function panelledDrum(): ReadonlyArray<string> {
  const lines: string[] = [];
  for (let side = 0; side < DRUM_SIDES; side++) {
    lines.push(wall(DRUM_RADIUS, side, -16, -13), wall(DRUM_RADIUS, side, -3, 0));
    if (PANELLED_SIDES.has(side)) {
      lines.push(
        wall(DRUM_RADIUS, side, -13, -12),
        wall(PANEL_RADIUS, side, -12, -4),
        wall(DRUM_RADIUS, side, -4, -3),
        `4 16 ${rim(DRUM_RADIUS, side, -12)} ${rim(DRUM_RADIUS, side + 1, -12)} ${rim(PANEL_RADIUS, side + 1, -12)} ${rim(PANEL_RADIUS, side, -12)}`,
        `4 16 ${rim(DRUM_RADIUS, side + 1, -4)} ${rim(DRUM_RADIUS, side, -4)} ${rim(PANEL_RADIUS, side, -4)} ${rim(PANEL_RADIUS, side + 1, -4)}`,
      );
    } else {
      lines.push(wall(DRUM_RADIUS, side, -13, -3));
    }
  }
  return lines;
}

function rollingModel(): string {
  return [
    "0 FILE rolling-model.mpd",
    "0 Model with a printed round brick and a custom drum, built for the rolling diagnostics test",
    "0 Name: rolling-model.mpd",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
    "1 4 -200 -24 -200 1 0 0 0 1 0 0 0 1 3941p01.dat",
    "1 1 200 -16 200 1 0 0 0 1 0 0 0 1 zz-panelled-drum.dat",
    "0 NOFILE",
    "0 FILE zz-panelled-drum.dat",
    `0 ${DRUM_TITLE}`,
    "0 Name: zz-panelled-drum.dat",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "0 BFC CERTIFY CCW",
    ...panelledDrum(),
    "0 NOFILE",
    "",
  ].join("\n");
}

test("the inspector alone loads rolling diagnostics: a placement session and an import that takes parts from the library bake fetch none, and asking shows the bake's rows and the import's own parts", async ({
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

  const file = test.info().outputPath("rolling-model.mpd");
  await writeFile(file, rollingModel());
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  expect(
    requested.some((path) => BAKE_BUCKET.test(path)),
    "the import reads the bake",
  ).toBe(true);
  await editor.placeAt(imported.item, IMPORT_AIM);
  expect(await editor.select(IMPORT_AIM)).toBe(imported.item);
  expect(diagnosticsRequests(), "an import that takes parts from the bake").toEqual([]);

  const inspector = page.getByRole("region", { name: "Inspector" });
  await inspector.getByRole("button", { name: "Show unread rolling bands" }).click();
  const bands = inspector.getByLabel("Unread rolling bands");
  await expect(bands).toBeVisible();
  const asked = diagnosticsRequests();
  expect(asked.length).toBeGreaterThan(0);
  expect(asked.every((path) => BAKE_DIAGNOSTICS.test(path))).toBe(true);
  const brick = bands.locator(".rolling-diagnostics-part", { hasText: PRINTED_ROUND_BRICK });
  await expect(brick.locator("li")).toHaveCount(PRINTED_ROUND_BRICK_ROWS);
  await expect(brick.locator("li", { hasText: /^arcs:/u })).toHaveCount(PRINTED_ROUND_BRICK_ARCS);
  await expect(bands.locator(".rolling-diagnostics-part", { hasText: DRUM_TITLE })).toContainText(
    "were computed at import and their rows aren't kept",
  );
  await inspector.screenshot({ path: test.info().outputPath("inspector-import.png") });

  const before = diagnosticsRequests().length;
  expect(await editor.select(MODULE_AIM)).toBe(PALETTE_MODULE);
  await inspector.getByRole("button", { name: "Show unread rolling bands" }).click();
  await expect(inspector.getByLabel("Unread rolling bands")).toBeVisible();
  const bundleAsked = diagnosticsRequests().slice(before);
  expect(bundleAsked.length).toBe(1);
  expect(bundleAsked.every((path) => BUNDLE_DIAGNOSTICS.test(path))).toBe(true);
  await inspector.screenshot({ path: test.info().outputPath("inspector-module.png") });
});

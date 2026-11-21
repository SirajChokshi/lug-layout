import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { EditorPage, type LatticePoint } from "./editor-page.ts";

const PALETTE_MODULE = "generated:mils-plain";
const MODULE_AIM: LatticePoint = { x: 380, z: 420 };
const COMPILED_AIM: LatticePoint = { x: -320, z: 420 };
const DIAGNOSTICS = /\/rolling-diagnostics[./]/u;
const BUNDLE_DIAGNOSTICS = /\/rolling-diagnostics\.[0-9a-f]{16}\.json$/u;
const LATTICE_PILLAR = "ldraw:2580";
const NOT_KEPT = "were computed at import and their rows aren't kept";

function pillarModel(): string {
  return [
    "0 Lattice pillar on a baseplate, built for the rolling diagnostics test",
    "0 Name: lattice-pillar.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3811.dat",
    "1 4 -200 -24 -200 1 0 0 0 1 0 0 0 1 2580.dat",
    "",
  ].join("\n");
}

test("the selection panel alone loads rolling diagnostics: a placement session and an import compiled at import fetch none, and asking shows the bundle's rows or names a part compiled at import", async ({
  page,
}) => {
  const requested: string[] = [];
  page.on("request", (request) => requested.push(new URL(request.url()).pathname));
  const diagnosticsRequests = (): ReadonlyArray<string> =>
    requested.filter((path) => DIAGNOSTICS.test(path));
  const editor = await EditorPage.open(page);
  const raw = await editor.serveLdrawLibrary();

  await editor.zoom(400);
  await editor.placeAt(PALETTE_MODULE, MODULE_AIM);
  await editor.escape();
  expect(diagnosticsRequests(), "a placement session").toEqual([]);

  const allowLibraryBake = editor.blockLibraryBake();
  const file = test.info().outputPath("lattice-pillar.ldr");
  await writeFile(file, pillarModel());
  const servedBefore = raw.served();
  const imported = await editor.importModel(file);
  allowLibraryBake();
  expect(imported.status, imported.text).toBe("placeable");
  const servedRaw = raw.served() - servedBefore;
  process.stdout.write(`library bake blocked: the raw route served ${servedRaw} LDraw files\n`);
  expect(
    servedRaw,
    "with the bake blocked, the import reads its parts from the raw library",
  ).toBeGreaterThan(0);
  await editor.placeAt(imported.item, COMPILED_AIM);
  await editor.escape();
  expect(diagnosticsRequests(), "an import compiled at import").toEqual([]);

  const panel = page.getByRole("region", { name: "Selection" });
  const showBands = async (): Promise<ReadonlyArray<string>> => {
    const before = diagnosticsRequests().length;
    await panel.getByRole("button", { name: "Show unread rolling bands" }).click();
    await expect(panel.getByLabel("Unread rolling bands")).toBeVisible();
    return diagnosticsRequests().slice(before);
  };

  expect(await editor.select(MODULE_AIM)).toBe(PALETTE_MODULE);
  const bundleAsked = await showBands();
  expect(bundleAsked).toHaveLength(1);
  expect(bundleAsked.every((path) => BUNDLE_DIAGNOSTICS.test(path))).toBe(true);
  await panel.screenshot({ path: test.info().outputPath("selection-panel-module.png") });

  expect(await editor.select(COMPILED_AIM)).toBe(imported.item);
  expect(await showBands()).toEqual([]);
  const pillar = panel
    .getByLabel("Unread rolling bands")
    .locator(".rolling-diagnostics-part", { hasText: LATTICE_PILLAR });
  await expect(pillar).toContainText(NOT_KEPT);
  await expect(pillar.locator("li")).toHaveCount(0);
  await panel.screenshot({
    path: test.info().outputPath("selection-panel-compiled-at-import.png"),
  });
});

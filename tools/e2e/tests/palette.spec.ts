import { expect, test, type Locator } from "@playwright/test";
import { EditorPage, TRACK_ITEM } from "./editor-page.ts";

const GREEN_BASEPLATE = "ldraw:3811@2";
const CROSSROADS = "ldraw:44343p03@72";

test("a swatch dragged out of palette search lands where it is dropped, and the tool picked before comes back", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(300);
  const target = { x: 0, z: 0 };
  await editor.escape();
  const drop = await editor.screenOf(target);
  await editor.choose(CROSSROADS);
  const search = page.locator(".palette-search");
  const crossroads = page.locator(`.palette [data-item="${CROSSROADS}"]`);

  await search.fill("3811 green");
  const swatch = page.locator(`.palette-results [data-item="${GREEN_BASEPLATE}"]`);
  await editor.dragOnto(swatch, drop);
  expect(await editor.poses()).toEqual([{ item: GREEN_BASEPLATE, ...target, yPlates: 0, rot: 0 }]);

  await swatch.dragTo(page.locator(".palette-head h2"));
  expect(await editor.poses(), "a drag dropped off the layout places nothing").toHaveLength(1);

  await search.fill("");
  await expect(crossroads).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`.palette [data-item="${GREEN_BASEPLATE}"]`)).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("picking the track tool or a track piece again puts it down, and picking a part again keeps it", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  const search = page.locator(".palette-search");
  const pickTwice = async (
    target: Locator,
    modes: readonly [string, string],
    pressedAfter: "true" | "false",
  ): Promise<void> => {
    await target.click();
    await expect(editor.root).toHaveAttribute("data-mode", modes[0]);
    await target.click();
    await expect(editor.root).toHaveAttribute("data-mode", modes[1]);
    await expect(target).toHaveAttribute("aria-pressed", pressedAfter);
  };

  const tool = page.locator(`.palette [data-section="track"] [data-item="${TRACK_ITEM}"]`);
  await pickTwice(tool, ["track", "select"], "false");
  await pickTwice(
    page.locator(".palette .palette-pieces [data-item]").first(),
    ["track", "select"],
    "false",
  );
  await pickTwice(
    page.locator(`.palette [data-section="baseplates"] [data-item="${GREEN_BASEPLATE}"]`),
    ["place", "place"],
    "true",
  );
  await editor.escape();
  await pickTwice(page.locator('[data-action="draw-track"]'), ["track", "select"], "false");

  await search.fill("9v straights");
  await pickTwice(
    page.locator(`.palette-results [data-group="${TRACK_ITEM}"] .palette-result-main`),
    ["track", "select"],
    "false",
  );
  await search.fill("3811 green");
  await pickTwice(
    page.locator('.palette-results [data-group="ldraw:3811"] .palette-result-main'),
    ["place", "place"],
    "true",
  );
});

test("mirroring a held switch shows only the mirrored switch as picked", async ({ page }) => {
  await EditorPage.open(page);
  const pieces = page.locator(".palette .palette-pieces [data-item]");
  const pressed = page.locator('.palette .palette-pieces [aria-pressed="true"]');
  const switchPiece = pieces.filter({ hasText: "Switch" }).first();
  const chosen = await switchPiece.getAttribute("data-item");

  await switchPiece.click();
  await expect(pressed).toHaveCount(1);
  await page.keyboard.press("x");
  await expect(pressed).toHaveCount(1);
  await expect(pressed).toContainText("Switch");
  await expect(pressed).not.toHaveAttribute("data-item", chosen ?? "");
});

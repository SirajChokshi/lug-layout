import { expect, test } from "@playwright/test";
import { EditorPage, STUD } from "./editor-page.ts";

const CROSSROADS = "ldraw:44343p03@72";
const STRAIGHT = "ldraw:44336p04@72";

test("road plates refuse overlaps and mismatched edges, and join exactly when they fit", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(300);
  const { wide } = await editor.itemStuds(CROSSROADS);
  const side = wide * STUD;

  await editor.placeAt(CROSSROADS, { x: 0, z: 0 });
  const placed = await editor.poses();
  expect(placed).toEqual([{ item: CROSSROADS, x: 0, z: 0, yPlates: 0, rot: 0 }]);

  const overlap = await editor.aim(STRAIGHT, { x: side / 2, z: 0 });
  expect(await editor.snapState()).toBe("refused");
  await page.mouse.click(overlap.sx, overlap.sy);
  expect(await editor.counter("refused")).toBe(1);
  expect(await editor.poses()).toEqual(placed);
  await expect(page.locator('[data-action="undo"]')).toHaveText(/Undo place/u);

  const neighbour = { x: side, z: 0 };
  const states: string[] = [];
  for (const rot of [0, 1]) {
    await editor.aim(STRAIGHT, neighbour, rot);
    states.push(await editor.snapState());
  }
  expect(states.toSorted()).toEqual(["refused", "snapped"]);
  const fits = states.indexOf("snapped");

  await editor.aim(STRAIGHT, neighbour, (fits + 1) % 2);
  const mismatched = await editor.screenOf(neighbour);
  await page.mouse.click(mismatched.sx, mismatched.sy);
  expect(await editor.counter("refused")).toBe(2);
  expect(await editor.poses()).toEqual(placed);

  await editor.placeAt(STRAIGHT, neighbour, fits);
  expect(await editor.poses()).toEqual([
    ...placed,
    { item: STRAIGHT, ...neighbour, yPlates: 0, rot: fits },
  ]);
  expect(await editor.counter("road-mismatch")).toBe(0);
  expect(await editor.counter("road-joined")).toBeGreaterThan(0);
  expect(await editor.counter("refused")).toBe(2);

  await page.screenshot({ path: test.info().outputPath("road-refusals.png") });
});

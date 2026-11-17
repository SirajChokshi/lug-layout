import { expect, test } from "@playwright/test";
import { EditorPage, STUD } from "./editor-page.ts";

const SIX_STUD_CROSSROADS = "ldraw:44343p03@72";
const SIX_STUD_STRAIGHT = "ldraw:44336p04@72";
const EIGHT_STUD_CROSSROADS = "ldraw:611p01@2";
const QUARTER_TURNS = [0, 1, 2, 3] as const;

test("road plates refuse overlaps and mismatched lanes, and join exactly when they fit", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(300);
  const { wide } = await editor.itemStuds(SIX_STUD_CROSSROADS);
  const side = wide * STUD;
  const neighbour = { x: side, z: 0 };

  await editor.placeAt(SIX_STUD_CROSSROADS, { x: 0, z: 0 });
  const placed = await editor.poses();
  expect(placed).toEqual([{ item: SIX_STUD_CROSSROADS, x: 0, z: 0, yPlates: 0, rot: 0 }]);

  const overlap = await editor.aim(SIX_STUD_STRAIGHT, { x: side / 4, z: 0 });
  expect(await editor.snapState()).toBe("refused");
  await page.mouse.click(overlap.sx, overlap.sy);
  expect(await editor.counter("refused")).toBe(1);
  expect(await editor.poses()).toEqual(placed);

  for (const rot of QUARTER_TURNS) {
    const point = await editor.aim(EIGHT_STUD_CROSSROADS, neighbour, rot);
    expect(await editor.snapState(), `8-stud lanes against 6-stud lanes at ${rot}`).toBe("refused");
    await page.mouse.click(point.sx, point.sy);
  }
  expect(await editor.counter("refused")).toBe(1 + QUARTER_TURNS.length);
  expect(await editor.poses()).toEqual(placed);

  await editor.undo();
  expect(await editor.poses(), "one undo after the refusals takes back the first plate").toEqual(
    [],
  );
  await editor.redo();
  expect(await editor.poses()).toEqual(placed);

  let fitting: number | null = null;
  for (const rot of QUARTER_TURNS) {
    await editor.aim(SIX_STUD_STRAIGHT, neighbour, rot);
    if ((await editor.snapState()) === "snapped") {
      fitting = Number(await editor.root.getAttribute("data-ghost-rot"));
      break;
    }
  }
  if (fitting === null)
    throw new Error("no quarter turn joins a 6-stud straight to the crossroads");
  await editor.placeAt(SIX_STUD_STRAIGHT, neighbour, fitting);
  expect(await editor.poses()).toEqual([
    ...placed,
    { item: SIX_STUD_STRAIGHT, ...neighbour, yPlates: 0, rot: fitting },
  ]);
  expect(await editor.counter("road-mismatch")).toBe(0);
  expect(await editor.counter("road-joined")).toBeGreaterThan(0);
  expect(await editor.counter("refused")).toBe(1 + QUARTER_TURNS.length);

  await page.screenshot({ path: test.info().outputPath("road-refusals.png") });
});

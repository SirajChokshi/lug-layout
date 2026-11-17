import { expect, test } from "@playwright/test";
import { EditorPage, STUD, type PlanFootprint } from "./editor-page.ts";

const MARKET_STREET = "omr:10190-1";
const GROCER = "omr:10185-1";
const OFF_SEAM = { dx: 3 * STUD, dz: -5 * STUD };

function minX(footprints: ReadonlyArray<PlanFootprint>, index: number): number {
  const footprint = footprints[index];
  if (!footprint) throw new Error(`no footprint ${index}`);
  return footprint.box.minX;
}

test("a second modular snaps flush with its pin holes on the first's pins, and pins that would run into a side without holes are refused", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(300);
  const { wide } = await editor.itemStuds("ldraw:3811@2");
  const side = wide * STUD;

  await editor.placeAt(MARKET_STREET, { x: 0, z: 0 });
  await editor.escape();
  const cursor = await editor.screenOf({ x: side + OFF_SEAM.dx, z: OFF_SEAM.dz });
  await editor.choose(MARKET_STREET);
  const rules = page.locator("section.placement-rules");

  expect(await editor.hoverAt(cursor), "the ghost snaps to the pinned pose").toEqual({
    x: side,
    z: 0,
  });
  await expect(rules).toHaveAttribute("data-ghost-pin-holes", "2");
  await expect(rules).toHaveAttribute("data-ghost-pins-seated", "2");
  await expect(rules).toHaveAttribute("data-ghost-refused", "");
  await page.screenshot({ path: test.info().outputPath("modular-pins-ghost.png") });

  await page.mouse.click(cursor.sx, cursor.sy);
  const pinned = [
    { item: MARKET_STREET, x: 0, z: 0, yPlates: 0, rot: 0 },
    { item: MARKET_STREET, x: side, z: 0, yPlates: 0, rot: 0 },
  ];
  expect(await editor.poses()).toEqual(pinned);
  const footprints = (await editor.footprints()).toSorted((a, b) => a.box.minX - b.box.minX);
  expect(minX(footprints, 1) - minX(footprints, 0), "the baseplates meet with no gap").toBe(side);
  expect(await editor.counter("refused")).toBe(0);

  await editor.placeAt(GROCER, { x: 0, z: side });
  expect(await editor.poses(), "the refused Green Grocer changes nothing").toEqual(pinned);
  expect(await editor.lastRefusal()).toEqual({
    rule: "overlap",
    message: expect.stringContaining("and 10190-1 Market Street (2007) fills -4 to 8 LDU."),
  });

  await page.screenshot({ path: test.info().outputPath("modular-pins.png") });
});

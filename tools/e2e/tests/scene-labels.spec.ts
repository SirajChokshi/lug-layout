import { expect, test, type Page } from "@playwright/test";
import { EditorPage, STUD, TRACK_ITEM } from "./editor-page.ts";

const GREEN_BASEPLATE = "ldraw:3811@2";
const PLATE_XS = [-1600, -960, -320, 320, 960, 1600];
const RAISED_PLATES = 6;
const RUN_END_LDU = 80 * STUD;
const MIN_RUN_PIECES = 6;
const DRAG_STEPS = 12;
const ZOOM_TO_TABLE = 700;
const ZOOM_STEP = 250;
const ZOOM_OUT_STEPS = 6;
const ZOOM_IN_STEPS = 10;

interface LabelBox {
  readonly text: string;
  readonly shown: boolean;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

async function labelBoxes(page: Page): Promise<ReadonlyArray<LabelBox>> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
  return page.locator("svg.scene-labels g.scene-label").evaluateAll((groups) =>
    groups.map((group) => {
      const pill = group.querySelector("rect")?.getBoundingClientRect();
      return {
        text: group.textContent ?? "",
        shown: group.getAttribute("visibility") === "visible",
        left: pill?.left ?? 0,
        top: pill?.top ?? 0,
        right: pill?.right ?? 0,
        bottom: pill?.bottom ?? 0,
      };
    }),
  );
}

function overlapping(labels: ReadonlyArray<LabelBox>): ReadonlyArray<string> {
  const shown = labels.filter((label) => label.shown);
  return shown.flatMap((a, i) =>
    shown
      .slice(i + 1)
      .filter((b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom)
      .map((b) => `${a.text} over ${b.text}`),
  );
}

function shownCount(labels: ReadonlyArray<LabelBox>): number {
  return labels.filter((label) => label.shown).length;
}

test("height labels along a raised run never overlap: zoomed out only a few show, and closer in more do", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(ZOOM_TO_TABLE);
  for (const x of PLATE_XS) await editor.placeAt(GREEN_BASEPLATE, { x, z: 0 });
  await editor.choose(TRACK_ITEM);
  const from = await editor.screenOf({ x: -RUN_END_LDU, z: 0 });
  const to = await editor.screenOf({ x: RUN_END_LDU, z: 0 });
  for (let plate = 0; plate < RAISED_PLATES; plate++) await editor.press("PageUp");
  await page.mouse.move(from.sx, from.sy);
  await page.mouse.down();
  for (let step = 1; step <= DRAG_STEPS; step++) {
    const t = step / DRAG_STEPS;
    await page.mouse.move(from.sx + (to.sx - from.sx) * t, from.sy + (to.sy - from.sy) * t);
  }
  await page.mouse.up();
  await expect
    .poll(async () => (await editor.laidTrack()).length, { message: "the raised run is laid" })
    .toBeGreaterThanOrEqual(MIN_RUN_PIECES);
  for (let step = 0; step < ZOOM_OUT_STEPS; step++) await editor.zoom(ZOOM_STEP);
  const far = await labelBoxes(page);
  for (let step = 0; step < ZOOM_IN_STEPS; step++) await editor.zoom(-ZOOM_STEP);
  const near = await labelBoxes(page);

  expect({ far: overlapping(far), near: overlapping(near) }).toEqual({ far: [], near: [] });
  expect(shownCount(far)).toBeGreaterThan(0);
  expect(shownCount(near)).toBeGreaterThan(shownCount(far));
});

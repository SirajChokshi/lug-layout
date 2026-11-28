import { expect, test } from "@playwright/test";
import { fileURLToPath } from "node:url";
import {
  EditorPage,
  TRACK_ITEM,
  curveFarthestFrom,
  isCurve,
  nearestLattice,
  routeMiddle,
} from "./editor-page.ts";

const MY_WAGONS = fileURLToPath(
  new URL("../../../packages/import/test-data/my-container-and-tank-wagons.ldr", import.meta.url),
);
const RIGHT_SWITCH = "track-piece:ldraw:75541-f1";
const HEADINGS = 16;
const EAST = 0;
const WEST = HEADINGS / 2;
const THROTTLE_PRESSES = 3;

test("the Play cab throws a switch dropped into a hand-drawn oval from its lever on the layout, by click or key, and Space on the lever throws it without stopping a user's own train", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  await editor.zoom(700);
  await editor.choose(TRACK_ITEM);
  await editor.dragTrack({ x: -800, z: 0 }, { x: 800, z: 0 });
  const ends = await editor.trackEnds();
  const east = ends.find((end) => end.heading === EAST);
  const west = ends.find((end) => end.heading === WEST);
  if (!east || !west) throw new Error(`a straight run has two ends: ${JSON.stringify(ends)}`);
  expect((await editor.dragTrack(nearestLattice(east), nearestLattice(west))).openEnds).toBe(0);
  await editor.escape();
  const middle = (await editor.trackRoutes())
    .filter((route) => !isCurve(route))
    .map(routeMiddle)
    .toSorted((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0];
  if (!middle) throw new Error("the oval has no straight");
  await editor.placeAt(RIGHT_SWITCH, middle);
  await editor.escape();
  expect((await editor.laidTrack()).filter((piece) => piece.ref.includes("75541"))).toHaveLength(1);
  const wagons = await editor.importModel(MY_WAGONS);
  expect(wagons.status, wagons.text).toBe("placeable");
  await editor.placeAt(wagons.item, curveFarthestFrom(await editor.trackRoutes(), [middle]));
  await editor.escape();
  expect(await editor.trainsOnRails()).toBe(1);

  await editor.startPlay();
  const panel = page.locator("section.play-panel");
  const lever = page.locator(".switch-lever");
  await expect(lever).toHaveCount(1);
  const thrown = async () => [
    await panel.getAttribute("data-switches"),
    await lever.getAttribute("aria-pressed"),
  ];
  const states = [await thrown()];
  await lever.locator(".switch-lever-base").click();
  await expect(panel).toHaveAttribute("data-switches", "d");
  states.push(await thrown());
  await lever.focus();
  await page.keyboard.press("Enter");
  await expect(panel).toHaveAttribute("data-switches", "s");
  states.push(await thrown());

  for (let press = 0; press < THROTTLE_PRESSES; press++) await page.keyboard.press("]");
  await expect
    .poll(async () => Number(await panel.locator(".play-speed").textContent()))
    .toBeGreaterThan(0);
  const throttle = panel.locator('input[type="range"]');
  const target = await throttle.inputValue();
  await lever.focus();
  await page.keyboard.press(" ");
  await expect(panel).toHaveAttribute("data-switches", "d");
  states.push(await thrown());

  expect(states).toEqual([
    ["s", "false"],
    ["d", "true"],
    ["s", "false"],
    ["d", "true"],
  ]);
  expect(Number(target)).toBeGreaterThan(0);
  expect(await throttle.inputValue()).toBe(target);
});

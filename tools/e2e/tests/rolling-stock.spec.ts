import { expect, test } from "@playwright/test";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  EditorPage,
  TRACK_ITEM,
  nearestLattice,
  routeMiddle,
  type LatticePoint,
  type TrackRoute,
} from "./editor-page.ts";

const LOCOMOTIVE = "omr:10020-1";
const MY_OWN_CAR = fileURLToPath(
  new URL("../../../packages/client/test-data/custom-bogie-wagon.mpd", import.meta.url),
);
const MY_WAGONS = fileURLToPath(
  new URL("../../../packages/client/test-data/my-two-wagons.ldr", import.meta.url),
);
const HEADINGS = 16;
const EAST = 0;
const WEST = HEADINGS / 2;
const THROTTLE_PRESSES = 4;
const RUN_DEADLINE_MS = 30_000;
const SAMPLE_MS = 200;
const LOCOMOTIVE_AT = { x: 0, z: 0 };
const CABOOSE_AT = { x: -100, z: 1600 };

function isCurve(route: TrackRoute): boolean {
  return (route.to.heading - route.from.heading + HEADINGS) % HEADINGS !== HEADINGS / 2;
}

function curveFarthestFrom(
  routes: ReadonlyArray<TrackRoute>,
  taken: ReadonlyArray<LatticePoint>,
): LatticePoint {
  const clearance = (point: LatticePoint) =>
    Math.min(...taken.map((other) => Math.hypot(point.x - other.x, point.z - other.z)));
  const farthest = routes
    .filter(isCurve)
    .map(routeMiddle)
    .toSorted((a, b) => clearance(b) - clearance(a))[0];
  if (!farthest) throw new Error("the oval has no curve");
  return farthest;
}

test("trains set by hand on a hand-drawn oval, imported ones included, couple when held on a standing train, run from where they stand and are still on the rails after a reload", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  await editor.zoom(700);
  await editor.choose(TRACK_ITEM);
  await editor.dragTrack({ x: -400, z: 0 }, { x: 400, z: 0 });
  const ends = await editor.trackEnds();
  const east = ends.find((end) => end.heading === EAST);
  const west = ends.find((end) => end.heading === WEST);
  if (!east || !west) throw new Error(`a straight run has two ends: ${JSON.stringify(ends)}`);
  const oval = await editor.dragTrack(nearestLattice(east), nearestLattice(west));
  expect(oval.openEnds).toBe(0);
  await editor.escape();

  const imported = await editor.importModel(MY_OWN_CAR);
  expect(imported.status, imported.text).toBe("placeable");
  const wagons = await editor.importModel(MY_WAGONS);
  expect(wagons.status, wagons.text).toBe("placeable");
  await editor.placeAt(LOCOMOTIVE, LOCOMOTIVE_AT);
  await editor.placeAt(imported.item, CABOOSE_AT);
  await editor.placeAt(wagons.item, LOCOMOTIVE_AT);
  const coupled = page.locator("section.play-panel li", { hasText: basename(MY_WAGONS) });
  await expect(coupled).toHaveCount(1);
  await expect(coupled).toContainText("Locomotive (2004)");
  await expect(coupled).toContainText(" + ");
  expect(await editor.trainsOnRails()).toBe(2);
  await editor.undo();
  await expect(coupled).toHaveCount(0);
  expect(await editor.trainsOnRails()).toBe(2);
  const curve = curveFarthestFrom(await editor.trackRoutes(), [LOCOMOTIVE_AT, CABOOSE_AT]);
  await editor.placeAt(wagons.item, curve);
  await editor.escape();

  expect(await editor.trainsOnRails()).toBe(3);
  expect(await editor.poses()).toEqual([]);
  await editor.undo();
  expect(await editor.trainsOnRails()).toBe(2);
  await editor.redo();
  expect(await editor.trainsOnRails()).toBe(3);

  await editor.startPlay();
  expect(await editor.playState()).toMatchObject({
    status: "running",
    bogiesOff: 0,
    derailSpeed: 0,
  });
  await page
    .getByRole("combobox", { name: "Drive", exact: true })
    .selectOption({ label: `3. ${basename(MY_WAGONS)}` });
  await expect(page.locator("section.play-panel")).toHaveAttribute("data-driven", "2");
  const standing = await editor.playState();
  for (let press = 0; press < THROTTLE_PRESSES; press++) await editor.press("]");
  await expect
    .poll(async () => (await editor.playState()).xLdu, {
      timeout: RUN_DEADLINE_MS,
      intervals: [SAMPLE_MS],
    })
    .not.toBe(standing.xLdu);
  await editor.press("Shift+P");

  const reopened = await EditorPage.open(page);
  expect(await reopened.trainsOnRails()).toBe(3);
  await page.screenshot({ path: test.info().outputPath("rolling-stock.png") });
});

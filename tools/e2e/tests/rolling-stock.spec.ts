import { expect, test } from "@playwright/test";
import { EditorPage, STUD, TRACK_ITEM } from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const LOCOMOTIVE = "rolling-stock:omr:10133-1";
const CAR = "rolling-stock:omr:10017-1";
const STILL_SPEED_LDU_PER_S = 0.001;
const RUN_READY_TIMEOUT_MS = 150_000;

interface SimStatus {
  readonly trains: number;
  readonly trainEdge: ReadonlyArray<number>;
  readonly trainOffsetLdu: ReadonlyArray<number>;
  readonly vehicles: ReadonlyArray<{ readonly model: string; readonly reversed: boolean }>;
}

test("rolling stock goes on laid track only, couples into a consist, undoes, and runs from where it stands", async ({
  page,
  context,
}) => {
  const editor = await EditorPage.open(page);
  await editor.zoom(1400);
  const { wide } = await editor.itemStuds(BASEPLATE);
  const side = wide * STUD;
  for (const k of [-1, 0, 1]) await editor.placeAt(BASEPLATE, { x: k * side, z: 0 });
  await editor.choose(TRACK_ITEM);
  const line = await editor.dragTrack({ x: -800, z: 0 }, { x: 800, z: 0 });
  expect(line).toMatchObject({ lastCommit: "laid", pieces: 5, openEnds: 2 });
  await editor.escape();

  await editor.choose(LOCOMOTIVE);
  await editor.hoverAt(await editor.screenOf({ x: 200, z: 20 }));
  expect(await editor.trainGhost()).toBe("on-track");
  await page.screenshot({ path: test.info().outputPath("01-locomotive-ghost-on-track.png") });
  await editor.clickAt({ x: 200, z: 20 });
  const [locomotive] = await editor.trains();
  expect(locomotive).toMatchObject({ cars: [{ model: "omr:10133-1", reversed: false }] });
  expect(locomotive?.axleOffCentreLdu).toBeLessThan(1e-9);
  expect(Number.isInteger(locomotive?.offsetLdu)).toBe(true);

  const refused = await editor.counter("refused");
  await editor.hoverAt(await editor.screenOf({ x: -300, z: 240 }));
  expect(await editor.trainGhost()).toBe("refused-off-track");
  await page.screenshot({ path: test.info().outputPath("02-ghost-on-baseplate-refused.png") });
  await editor.clickAt({ x: -300, z: 240 });
  expect(await editor.counter("refused")).toBe(refused + 1);
  expect(await editor.trains()).toHaveLength(1);

  await editor.escape();
  await editor.choose(CAR);
  await editor.hoverAt(await editor.screenOf({ x: -360, z: 0 }));
  expect(await editor.trainGhost()).toBe("couples");
  await editor.clickAt({ x: -360, z: 0 });
  const consist = async () =>
    (await editor.trains()).map((train) => train.cars.map((car) => car.model));
  expect(await consist()).toEqual([["omr:10133-1", "omr:10017-1"]]);
  await editor.escape();
  await editor.undo();
  expect(await consist()).toEqual([["omr:10133-1"]]);
  await editor.redo();
  expect(await consist()).toEqual([["omr:10133-1", "omr:10017-1"]]);
  await page.screenshot({ path: test.info().outputPath("03-consist-on-track.png") });

  const run = page.locator("section.train-panel [data-run-trains]");
  await expect(run).toBeVisible();
  const href = await run.getAttribute("href");
  const world = await editor.root.getAttribute("data-world");
  expect(href).toContain(`world=${world ?? ""}`);
  const placed = await editor.trains();

  const viewer = await context.newPage();
  await viewer.goto(`/${href ?? ""}&speed=${STILL_SPEED_LDU_PER_S}`);
  const sim = viewer.locator("#sim");
  await expect(sim).toBeAttached({ timeout: RUN_READY_TIMEOUT_MS });
  const status: SimStatus = JSON.parse((await sim.textContent()) ?? "{}");
  expect(status.trains).toBe(placed.length);
  expect(status.vehicles.map((vehicle) => vehicle.model)).toEqual(["10133-1", "10017-1"]);
  placed.forEach((train, t) => {
    expect(status.trainEdge[t]).toBe(2 * train.track + (train.forward ? 0 : 1));
    expect(status.trainOffsetLdu[t]).toBeCloseTo(train.offsetLdu, 1);
  });
  await viewer.screenshot({ path: test.info().outputPath("04-run-viewer-starts-in-place.png") });
});

import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import {
  EditorPage,
  STUD,
  shiftedPosition,
  type LaidTrackPiece,
  type LatticePoint,
  type Pose,
} from "./editor-page.ts";

const BASEPLATE = "ldraw:3811@2";
const BASEPLATE_HALF = 320;
const START: LatticePoint = { x: 800, z: 0 };
const GROUP_SHIFT = 640;

const HEADING_STEPS = 16;
const QUARTER_TURN_STEPS = 4;
const Z_COEFFICIENT = 4;

function pivotOf(from: LatticePoint, to: LatticePoint): LatticePoint {
  return { x: (to.x + to.z - from.z + from.x) / 2, z: (from.z + from.x - to.x + to.z) / 2 };
}

function turnedPoint(at: LatticePoint, pivot: LatticePoint): LatticePoint {
  return { x: pivot.x + at.z - pivot.z, z: pivot.z - at.x + pivot.x };
}

function turnedPosition(position: ReadonlyArray<string>, pivot: LatticePoint): string[] {
  const c = position.map((coefficient) => BigInt(coefficient));
  const rotated = c.map((_, k) =>
    k < Z_COEFFICIENT ? (c[k + Z_COEFFICIENT] ?? 0n) : -(c[k - Z_COEFFICIENT] ?? 0n),
  );
  const px = BigInt(pivot.x / STUD);
  const pz = BigInt(pivot.z / STUD);
  return rotated
    .map((coefficient, k) =>
      k === 0 ? coefficient + px - pz : k === Z_COEFFICIENT ? coefficient + pz + px : coefficient,
    )
    .map((coefficient) => coefficient.toString());
}

function customCottage(): string {
  return [
    "0 Custom cottage built for the multi-select test",
    "0 Name: custom-cottage.ldr",
    "0 Author: lug-layout e2e (generated at test time)",
    "0 !LICENSE Licensed under CC BY 4.0 : see CAreadme.txt",
    "1 2 0 0 0 1 0 0 0 1 0 0 0 1 3867.dat",
    "1 15 -40 -24 -60 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 15 40 -24 -60 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 15 -40 -24 60 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 15 40 -24 60 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 4 -40 -48 -60 1 0 0 0 1 0 0 0 1 3001.dat",
    "1 4 40 -48 60 1 0 0 0 1 0 0 0 1 3001.dat",
    "",
  ].join("\n");
}

test("an imported model drags flush beside a baseplate and is refused one stud in, the arrows nudge it, and a box-selected group moves, turns, pastes and deletes, each one undo step", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const file = test.info().outputPath("custom-cottage.ldr");
  await writeFile(file, customCottage());
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  const cottage = imported.item;
  await editor.zoom(400);
  const states: Array<ReadonlyArray<Pose>> = [];
  const record = async (): Promise<void> => {
    states.push(await editor.poses());
  };
  const cottagePose = async (): Promise<Pose | undefined> =>
    (await editor.poses()).find((pose) => pose.item === cottage);

  await editor.placeAt(BASEPLATE, { x: 0, z: 0 });
  await editor.placeAt(cottage, START);
  await record();
  const footprint = (await editor.footprints()).find((entry) => entry.ref === cottage)?.box;
  if (!footprint) throw new Error("the cottage has no footprint");
  const flush: LatticePoint = { x: BASEPLATE_HALF + START.x - footprint.minX, z: 0 };
  const oneIn: LatticePoint = { x: flush.x - STUD, z: 0 };

  expect(await editor.select(START)).toBe(cottage);
  await editor.dragFrom(START, flush);
  expect(await cottagePose()).toMatchObject({ x: flush.x, z: flush.z });
  await record();
  const refusedBefore = await editor.counter("refused");
  await editor.dragFrom(flush, START, oneIn);
  expect(await cottagePose()).toMatchObject({ x: flush.x, z: flush.z });
  expect(await editor.counter("refused")).toBe(refusedBefore + 1);
  await expect(page.locator(".tool-hud")).toContainText("Can't move it there.");

  await editor.press("ArrowRight");
  expect(await cottagePose()).toMatchObject({ x: flush.x + STUD, z: 0 });
  await record();
  await editor.press("ArrowLeft");
  expect(await cottagePose()).toMatchObject({ x: flush.x, z: flush.z });
  await record();
  await editor.press("ArrowLeft");
  expect(await cottagePose()).toMatchObject({ x: flush.x, z: flush.z });
  expect(await editor.counter("refused")).toBe(refusedBefore + 2);

  await editor.escape();
  await editor.dragFrom({ x: -560, z: -480 }, { x: flush.x + 400, z: 480 });
  expect(await editor.selectionCount()).toBe(2);
  await editor.shiftClickAt({ x: 0, z: -200 });
  expect(await editor.selectionCount()).toBe(1);
  await editor.shiftClickAt({ x: 0, z: -200 });
  expect(await editor.selectionCount()).toBe(2);

  await editor.dragFrom({ x: 0, z: 0 }, { x: 0, z: GROUP_SHIFT });
  const shifted = await editor.poses();
  expect(shifted.map((pose) => pose.z)).toEqual([GROUP_SHIFT, GROUP_SHIFT]);
  await record();
  await editor.press("r");
  expect((await editor.poses()).map((pose) => pose.rot)).toEqual([1, 1]);
  await record();
  await editor.press("Control+c");
  await editor.press("Control+v");
  await expect(editor.root).toHaveAttribute("data-gesture", "paste");
  await editor.clickAt({ x: 160, z: -720 });
  expect(await editor.poses()).toHaveLength(4);
  expect(await editor.selectionCount()).toBe(2);
  await record();
  await editor.press("Delete");
  expect(await editor.poses()).toEqual(states.at(-2));
  await record();

  for (let step = states.length - 1; step > 0; step--) {
    await editor.undo();
    expect(await editor.poses(), `after undoing step ${step}`).toEqual(states[step - 1]);
  }

  await editor.waitForFarTierAndMeshesSettled();
  await page.screenshot({ path: test.info().outputPath("multi-select.png") });
});

test("an imported model and laid track box-selected together nudge, turn and delete as one undo step each that redo repeats, and a nudge that pulls a piece off its join unclips it like real track, which undo joins again", async ({
  page,
}) => {
  const editor = await EditorPage.open(page);
  await editor.serveLdrawLibrary();
  const file = test.info().outputPath("custom-cottage.ldr");
  await writeFile(file, customCottage());
  const imported = await editor.importModel(file);
  expect(imported.status, imported.text).toBe("placeable");
  const cottage = imported.item;
  await editor.zoom(400);

  await editor.press("t");
  const laidRun = await editor.dragTrack({ x: -480, z: 0 }, { x: 480, z: 0 });
  expect(laidRun).toMatchObject({ pieces: 3, joins: 2 });
  await editor.escape();
  await editor.placeAt(cottage, { x: -320, z: 600 });
  await editor.escape();

  interface GroupState {
    readonly poses: ReadonlyArray<Pose>;
    readonly track: ReadonlyArray<LaidTrackPiece>;
  }
  const states: GroupState[] = [];
  const state = async (): Promise<GroupState> => ({
    poses: await editor.poses(),
    track: await editor.laidTrack(),
  });
  states.push(await state());

  const laid = states[0];
  const laidCottage = laid?.poses.find((pose) => pose.item === cottage);
  if (!laid || !laidCottage) throw new Error("the cottage was not placed");

  await editor.dragFrom({ x: -720, z: -240 }, { x: 80, z: 960 });
  expect(await editor.selectionCount()).toBe(2);
  await editor.press("ArrowLeft");
  const pulled = await state();
  expect(pulled.poses).toEqual([{ ...laidCottage, x: laidCottage.x - STUD }]);
  expect(
    pulled.track.filter(
      (piece, index) => JSON.stringify(piece) !== JSON.stringify(laid.track[index]),
    ),
  ).toHaveLength(1);
  expect(await editor.trackCounts()).toMatchObject({ joins: 1, openEnds: 4 });
  await editor.undo();
  expect(await state()).toEqual(laid);
  expect(await editor.trackCounts()).toMatchObject({ joins: 2, openEnds: 2 });

  await editor.escape();
  await editor.dragFrom({ x: -720, z: -240 }, { x: 720, z: 960 });
  expect(await editor.selectionCount()).toBe(4);
  await editor.press("ArrowDown");
  const nudged = await state();
  const nudgedCottage = nudged.poses.find((pose) => pose.item === cottage);
  if (!nudgedCottage) throw new Error("the nudge lost the cottage");
  const dx = nudgedCottage.x - laidCottage.x;
  const dz = nudgedCottage.z - laidCottage.z;
  expect(Math.abs(dx) + Math.abs(dz)).toBe(STUD);
  expect(nudged).toEqual({
    poses: [{ ...laidCottage, x: laidCottage.x + dx, z: laidCottage.z + dz }],
    track: laid.track.map((piece) => ({
      ...piece,
      position: shiftedPosition(piece.position, dx, dz),
    })),
  });
  expect((await editor.trackCounts()).joins).toBe(2);
  states.push(nudged);
  await editor.press("r");
  const turned = await state();
  const turnedCottage = turned.poses.find((pose) => pose.item === cottage);
  if (!turnedCottage) throw new Error("the turn lost the cottage");
  const pivot = pivotOf(nudgedCottage, turnedCottage);
  expect(turned).toEqual({
    poses: [
      { ...nudgedCottage, ...turnedPoint(nudgedCottage, pivot), rot: (nudgedCottage.rot + 1) % 4 },
    ],
    track: nudged.track.map((piece) => ({
      ...piece,
      heading: (piece.heading + HEADING_STEPS - QUARTER_TURN_STEPS) % HEADING_STEPS,
      position: turnedPosition(piece.position, pivot),
    })),
  });
  expect((await editor.trackCounts()).joins).toBe(2);
  states.push(turned);
  await page.screenshot({ path: test.info().outputPath("track-group-turned.png") });
  await editor.press("Delete");
  expect(await state()).toEqual({ poses: [], track: [] });
  states.push(await state());

  for (let step = states.length - 1; step > 0; step--) {
    await editor.undo();
    expect(await state(), `after undoing step ${step}`).toEqual(states[step - 1]);
    expect(await editor.selectionCount(), `selected after undoing step ${step}`).toBe(4);
  }
  for (let step = 1; step < states.length; step++) {
    await editor.redo();
    expect(await state(), `after redoing step ${step}`).toEqual(states[step]);
    expect(await editor.selectionCount(), `selected after redoing step ${step}`).toBe(
      step === states.length - 1 ? 0 : 4,
    );
  }
});

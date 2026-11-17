import { afterEach, expect, it, vi } from "vitest";
import type { IEditor } from "./editor.ts";
import { StraightDownBackend, startEditor as startRig } from "./editor-test-rig.ts";

const UPPER_SET = "2150-1";
const BASEPLATE = "ldraw:3811";
const ROAD_PLATE = "ldraw:44336p01";
const NDC_TO_LDU = 10_000;
const RAY_START_Y = 1000;
const FAR_LDU = 4000;
const SET_OFFSET_LDU = -160;
const PLATE_EDGE_PROBE_LDU = 300;

afterEach(() => {
  vi.unstubAllGlobals();
});

async function startEditor(
  backend = new StraightDownBackend(NDC_TO_LDU, RAY_START_Y),
): Promise<IEditor> {
  return (await startRig([UPPER_SET], backend)).editor;
}

function itemOf(editor: IEditor, group: string): string {
  const item = editor.snapshot().catalog.find((entry) => entry.group === group);
  if (!item) throw new Error(`the catalog offers nothing from ${group}`);
  return item.id;
}

function clickAt(editor: IEditor, x: number, z: number, additive = false): void {
  editor.pointerMove(x / NDC_TO_LDU, z / NDC_TO_LDU);
  editor.click(x / NDC_TO_LDU, z / NDC_TO_LDU, 0, additive);
}

interface Pose {
  readonly item: string;
  readonly x: number;
  readonly z: number;
  readonly yPlates: number;
  readonly rot: number;
}

function poses(editor: IEditor): Pose[] {
  const dump = editor.dump();
  const placements = dump.placements;
  return placements.refId
    .map((refId, i) => ({
      item: dump.refs[refId] ?? "",
      x: placements.x[i] ?? 0,
      z: placements.z[i] ?? 0,
      yPlates: placements.yPlates[i] ?? 0,
      rot: placements.rot[i] ?? 0,
    }))
    .toSorted((a, b) => a.item.localeCompare(b.item) || a.x - b.x);
}

function poseOf(editor: IEditor, item: string): Pose {
  const pose = poses(editor).find((candidate) => candidate.item === item);
  if (!pose) throw new Error(`${item} is not placed`);
  return pose;
}

async function setOnBaseplate(): Promise<IEditor> {
  const editor = await startEditor();
  editor.chooseItem(itemOf(editor, BASEPLATE));
  clickAt(editor, 0, 0);
  editor.chooseItem(`omr:${UPPER_SET}`);
  clickAt(editor, SET_OFFSET_LDU, SET_OFFSET_LDU);
  editor.chooseItem(null);
  expect(editor.snapshot().lastRefusal).toBeNull();
  return editor;
}

it("turns a box-selected group rigidly about one pivot: a set standing off-centre on a baseplate keeps its offset turned a quarter, and four turns bring both home", async () => {
  const editor = await setOnBaseplate();
  const home = poses(editor);
  const plate = poseOf(editor, itemOf(editor, BASEPLATE));
  const set = poseOf(editor, `omr:${UPPER_SET}`);
  expect([set.x - plate.x, set.z - plate.z]).not.toEqual([0, 0]);

  const far = FAR_LDU / NDC_TO_LDU;
  editor.selectInRect({ fromNdcX: -far, fromNdcY: -far, toNdcX: far, toNdcY: far }, false);
  expect(editor.snapshot().selection?.count).toBe(2);

  editor.rotate(0);
  expect(editor.snapshot().lastRefusal).toBeNull();
  const turnedPlate = poseOf(editor, itemOf(editor, BASEPLATE));
  const turnedSet = poseOf(editor, `omr:${UPPER_SET}`);
  expect([turnedSet.x - turnedPlate.x, turnedSet.z - turnedPlate.z]).toEqual([
    set.z - plate.z,
    plate.x - set.x,
  ]);
  expect([turnedPlate.rot, turnedSet.rot]).toEqual([(plate.rot + 1) % 4, (set.rot + 1) % 4]);
  expect(turnedSet.yPlates).toBe(set.yPlates);

  editor.rotate(0);
  editor.rotate(0);
  editor.rotate(0);
  expect(poses(editor)).toEqual(home);
  expect(editor.snapshot().history.undoDepth).toBe(6);

  editor.deleteSelection(0);
  expect(editor.snapshot().placements).toBe(0);
  editor.undo(0);
  expect(poses(editor)).toEqual(home);
  expect(editor.snapshot().selection?.count).toBe(2);
}, 120_000);

it("names the selected model that carries what a group edit would strand, and leaves the layout alone", async () => {
  const editor = await setOnBaseplate();
  editor.chooseItem(itemOf(editor, ROAD_PLATE));
  clickAt(editor, FAR_LDU / 2, 0);
  editor.chooseItem(null);
  const before = poses(editor);
  const road = poseOf(editor, itemOf(editor, ROAD_PLATE));
  const plate = poseOf(editor, itemOf(editor, BASEPLATE));

  clickAt(editor, road.x, road.z);
  expect(editor.snapshot().selection?.item).toBe(itemOf(editor, ROAD_PLATE));
  const plateItem = itemOf(editor, BASEPLATE);
  const edge = PLATE_EDGE_PROBE_LDU;
  for (const [dx, dz] of [
    [0, edge],
    [0, -edge],
    [edge, 0],
    [-edge, 0],
  ] as const) {
    clickAt(editor, plate.x + dx, plate.z + dz, true);
    if (editor.snapshot().selection?.item === plateItem) break;
    if (editor.snapshot().selection?.count === 2) clickAt(editor, plate.x + dx, plate.z + dz, true);
  }
  expect(editor.snapshot().selection?.count).toBe(2);
  expect(editor.snapshot().selection?.item).toBe(plateItem);

  editor.deleteSelection(0);
  const refusal = editor.snapshot().lastRefusal;
  expect(refusal?.item).toBe(itemOf(editor, BASEPLATE));
  expect(refusal?.message).toMatch(/^3811 Baseplate 32 x 32\b.* carries 2150-1, .*Select it too/u);
  expect(poses(editor)).toEqual(before);
}, 120_000);

it("selects a model pressed and released in place, and starts no box on it", async () => {
  const editor = await setOnBaseplate();
  const set = poseOf(editor, `omr:${UPPER_SET}`);
  editor.selectAll();
  expect(editor.snapshot().selection?.count).toBe(2);

  expect(editor.dragStart(set.x / NDC_TO_LDU, set.z / NDC_TO_LDU)).toBe(true);
  editor.dragEnd(set.x / NDC_TO_LDU, set.z / NDC_TO_LDU, 0);
  expect(editor.snapshot().selection?.count).toBe(1);
  expect(editor.snapshot().selection?.item).toBe(`omr:${UPPER_SET}`);

  expect(editor.dragStart(FAR_LDU / NDC_TO_LDU, FAR_LDU / NDC_TO_LDU)).toBe(false);
}, 120_000);

function dragFrom(editor: IEditor, from: Pose, toX: number, toZ: number): void {
  expect(editor.dragStart(from.x / NDC_TO_LDU, from.z / NDC_TO_LDU)).toBe(true);
  editor.dragMove(toX / NDC_TO_LDU, toZ / NDC_TO_LDU);
  editor.dragEnd(toX / NDC_TO_LDU, toZ / NDC_TO_LDU, 0);
}

it("drags a model as one move command: refused off the studs, landed exactly on another baseplate, and nudged one stud by the arrow keys", async () => {
  const editor = await setOnBaseplate();
  const plateItem = itemOf(editor, BASEPLATE);
  editor.chooseItem(plateItem);
  clickAt(editor, FAR_LDU / 2, 0);
  editor.chooseItem(null);
  const home = poses(editor);
  const set = poseOf(editor, `omr:${UPPER_SET}`);
  const [under, other] = home.filter((pose) => pose.item === plateItem);
  if (!under || !other) throw new Error("the second baseplate was not placed");

  const refusals = editor.snapshot().refusals;
  dragFrom(editor, set, set.x, set.z + FAR_LDU);
  expect(editor.snapshot().refusals).toBe(refusals + 1);
  expect(editor.snapshot().lastRefusal?.action).toBe("move");
  expect(poses(editor)).toEqual(home);

  const depth = editor.snapshot().history.undoDepth;
  dragFrom(editor, set, set.x + other.x - under.x, set.z);
  expect(editor.snapshot().history.undoDepth).toBe(depth + 1);
  expect(editor.snapshot().history.undo).toBe("move");
  const moved = poseOf(editor, `omr:${UPPER_SET}`);
  expect(moved).toEqual({ ...set, x: set.x + other.x - under.x });

  editor.nudge(1, 0, 0);
  const nudged = poseOf(editor, `omr:${UPPER_SET}`);
  expect(Math.abs(nudged.x - moved.x) + Math.abs(nudged.z - moved.z)).toBe(20);

  editor.undo(0);
  editor.undo(0);
  expect(poses(editor)).toEqual(home);
}, 120_000);

async function heldPlate(backend: StraightDownBackend): Promise<{
  readonly editor: IEditor;
  readonly plate: Pose;
  readonly target: readonly [number, number];
}> {
  const editor = await startEditor(backend);
  const plateItem = itemOf(editor, BASEPLATE);
  editor.chooseItem(plateItem);
  clickAt(editor, 0, 0);
  clickAt(editor, FAR_LDU / 2, 0);
  editor.chooseItem(null);
  const plate = poses(editor)
    .filter((pose) => pose.item === plateItem)
    .at(-1);
  if (!plate) throw new Error("the baseplates were not placed");
  const target = [plate.x, plate.z + FAR_LDU] as const;
  expect(editor.dragStart(plate.x / NDC_TO_LDU, plate.z / NDC_TO_LDU)).toBe(true);
  editor.dragMove(target[0] / NDC_TO_LDU, target[1] / NDC_TO_LDU);
  expect(editor.snapshot().move?.dz).toBe(FAR_LDU);
  return { editor, plate, target };
}

it("turns a held drag with R, and drops it turned where it was dragged, as one move", async () => {
  const { editor, plate, target } = await heldPlate(
    new StraightDownBackend(NDC_TO_LDU, RAY_START_Y),
  );
  const depth = editor.snapshot().history.undoDepth;
  editor.rotate(0);
  expect(editor.snapshot().move?.turns).toBe(1);
  expect(editor.snapshot().history.undoDepth).toBe(depth);
  editor.dragEnd(target[0] / NDC_TO_LDU, target[1] / NDC_TO_LDU, 0);
  expect(editor.snapshot().lastRefusal).toBeNull();
  expect(editor.snapshot().history.undoDepth).toBe(depth + 1);
  expect(editor.snapshot().history.undo).toBe("move");
  const dropped = poses(editor).find((pose) => pose.z > plate.z + FAR_LDU / 2);
  expect(dropped?.rot).toBe((plate.rot + 1) % 4);
}, 120_000);

it("lets go of a held drag cleanly when Delete or Ctrl+Z is pressed mid-drag", async () => {
  for (const command of ["delete", "undo"] as const) {
    const backend = new StraightDownBackend(NDC_TO_LDU, RAY_START_Y);
    const { editor, target } = await heldPlate(backend);
    const before = editor.snapshot();
    if (command === "delete") editor.deleteSelection(0);
    else editor.undo(0);
    expect(editor.snapshot().move).toBeNull();
    editor.dragMove(target[0] / NDC_TO_LDU + 0.01, target[1] / NDC_TO_LDU);
    editor.dragEnd(target[0] / NDC_TO_LDU, target[1] / NDC_TO_LDU, 0);
    expect(editor.snapshot().refusals).toBe(before.refusals);
    expect(editor.snapshot().placements).toBe(before.placements - 1);
    expect(editor.snapshot().history.undo).toBe(command === "delete" ? "remove" : "place");
    expect(backend.selectionBoxes).toHaveLength(editor.snapshot().selection?.count ?? 0);
    expect(poses(editor).every((pose) => pose.z < FAR_LDU / 2)).toBe(true);
  }
}, 120_000);

it("pastes a copied group as one place command: same layout where it drops, turned by R, refused on top of the original", async () => {
  const editor = await setOnBaseplate();
  const home = poses(editor);
  const plate = poseOf(editor, itemOf(editor, BASEPLATE));
  const model = poseOf(editor, `omr:${UPPER_SET}`);
  editor.selectAll();
  editor.copySelection();
  expect(editor.snapshot().clipboard).toBe(2);

  editor.paste();
  expect(editor.snapshot().mode).toBe("paste");
  const refusals = editor.snapshot().refusals;
  clickAt(editor, plate.x, plate.z);
  expect(editor.snapshot().refusals).toBe(refusals + 1);
  expect(poses(editor)).toEqual(home);

  const depth = editor.snapshot().history.undoDepth;
  clickAt(editor, FAR_LDU, 0);
  expect(editor.snapshot().history.undoDepth).toBe(depth + 1);
  expect(editor.snapshot().mode).toBe("select");
  expect(editor.snapshot().selection?.count).toBe(2);
  const pasted = poses(editor).filter(
    (pose) => !home.some((h) => h.x === pose.x && h.z === pose.z),
  );
  const [pastedPlate, pastedModel] = pasted;
  if (!pastedPlate || !pastedModel) throw new Error("the paste did not add both models");
  expect([pastedModel.x - pastedPlate.x, pastedModel.z - pastedPlate.z]).toEqual([
    model.x - plate.x,
    model.z - plate.z,
  ]);
  expect([pastedPlate.yPlates, pastedModel.yPlates]).toEqual([plate.yPlates, model.yPlates]);

  editor.undo(0);
  expect(poses(editor)).toEqual(home);

  editor.paste();
  editor.rotate(0);
  clickAt(editor, -FAR_LDU, 0);
  const turned = poses(editor).filter(
    (pose) => !home.some((h) => h.x === pose.x && h.z === pose.z),
  );
  const [turnedPlate, turnedModel] = turned;
  if (!turnedPlate || !turnedModel) throw new Error("the turned paste did not add both models");
  expect([turnedModel.x - turnedPlate.x, turnedModel.z - turnedPlate.z]).toEqual([
    model.z - plate.z,
    plate.x - model.x,
  ]);
  expect([turnedPlate.rot, turnedModel.rot]).toEqual([(plate.rot + 1) % 4, (model.rot + 1) % 4]);
}, 120_000);

it("sets a selection's centre and rotation from the properties panel, each as one exact command", async () => {
  const editor = await startEditor();
  editor.chooseItem(itemOf(editor, BASEPLATE));
  clickAt(editor, 0, 0);
  editor.chooseItem(null);
  const [plate] = poses(editor);
  if (!plate) throw new Error("the baseplate was not placed");
  clickAt(editor, plate.x, plate.z);
  const selection = editor.snapshot().selection;
  if (!selection) throw new Error("the baseplate was not selected");

  const depth = editor.snapshot().history.undoDepth;
  const toX = selection.centreXStuds + 3 * selection.gridStuds;
  editor.moveSelectionTo(toX, selection.centreZStuds, 0);
  expect(editor.snapshot().selection?.centreXStuds).toBe(toX);
  expect(poses(editor)).toEqual([{ ...plate, x: plate.x + 3 * selection.gridStuds * 20 }]);

  editor.turnSelectionTo(2, 0);
  expect(editor.snapshot().selection?.rot).toBe(2);
  expect(editor.snapshot().selection?.centreXStuds).toBe(toX);
  expect(editor.snapshot().history.undoDepth).toBe(depth + 2);
  editor.undo(0);
  editor.undo(0);
  expect(poses(editor)).toEqual([plate]);
}, 120_000);

const NON_SQUARE_BASEPLATE = "ldraw:3334";

it("brings a non-square baseplate back exactly where it started after 90°, 180°, 270° and 0° from the rotation buttons", async () => {
  const editor = await startEditor();
  editor.chooseItem(itemOf(editor, NON_SQUARE_BASEPLATE));
  clickAt(editor, 0, 0);
  editor.chooseItem(null);
  editor.selectAll();
  const home = poses(editor);
  expect(home).toHaveLength(1);
  const visits = [1, 2, 3, 0].map((rot) => {
    editor.turnSelectionTo(rot, 0);
    expect(editor.snapshot().lastRefusal).toBeNull();
    return editor.snapshot().selection?.rot;
  });
  expect(visits).toEqual([1, 2, 3, 0]);
  expect(poses(editor)).toEqual(home);
}, 120_000);

it("rounds a typed half-step position away from where the selection is, the same both ways", async () => {
  const editor = await startEditor();
  editor.chooseItem(itemOf(editor, BASEPLATE));
  clickAt(editor, 0, 0);
  editor.chooseItem(null);
  editor.selectAll();
  const start = editor.snapshot().selection;
  if (!start) throw new Error("the baseplate was not selected");
  const half = start.gridStuds / 2;

  editor.moveSelectionTo(start.centreXStuds + half, start.centreZStuds, 0);
  expect(editor.snapshot().selection?.centreXStuds).toBe(start.centreXStuds + start.gridStuds);
  editor.undo(0);
  editor.moveSelectionTo(start.centreXStuds - half, start.centreZStuds, 0);
  expect(editor.snapshot().selection?.centreXStuds).toBe(start.centreXStuds - start.gridStuds);
}, 120_000);

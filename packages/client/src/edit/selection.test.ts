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

async function startEditor(): Promise<IEditor> {
  return (await startRig([UPPER_SET], new StraightDownBackend(NDC_TO_LDU, RAY_START_Y))).editor;
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

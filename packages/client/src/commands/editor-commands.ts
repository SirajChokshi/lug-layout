import { TRACK_ITEM_ID, type EditorSnapshot, type IEditor } from "../edit/editor.ts";
import { chordMatches, type KeyChord, type KeyInput } from "./key-chord.ts";

export type EditorActionId =
  | "select-tool"
  | "draw-track"
  | "rotate"
  | "delete"
  | "duplicate"
  | "undo"
  | "redo"
  | "focus"
  | "centre"
  | "pan-left"
  | "pan-right"
  | "pan-forward"
  | "pan-back"
  | "orbit-left"
  | "orbit-right"
  | "tilt-down"
  | "tilt-up"
  | "zoom-in"
  | "zoom-out"
  | "toggle-joins"
  | "toggle-road-snap";

export type ShellCommandId = "show-shortcuts";

export type CommandId = EditorActionId | ShellCommandId;

export type CommandGroup = "Tools" | "Edit" | "View" | "Help";

export interface CommandSpec {
  readonly id: CommandId;
  readonly title: string;
  readonly group: CommandGroup;
  readonly keys: ReadonlyArray<KeyChord>;
  readonly whileTyping?: boolean;
}

export interface PointerGesture {
  readonly gesture: string;
  readonly action: string;
}

export const COMMAND_GROUPS: ReadonlyArray<CommandGroup> = ["Tools", "Edit", "View", "Help"];

export const COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    id: "select-tool",
    title: "Select tool: stop placing, clear the selection",
    group: "Tools",
    keys: [{ key: "Escape" }],
  },
  { id: "draw-track", title: "Draw track", group: "Tools", keys: [{ key: "t" }] },
  { id: "rotate", title: "Rotate 90°", group: "Edit", keys: [{ key: "r" }] },
  {
    id: "delete",
    title: "Delete the selection",
    group: "Edit",
    keys: [{ key: "Delete" }, { key: "Backspace" }],
  },
  {
    id: "duplicate",
    title: "Place more like the selection",
    group: "Edit",
    keys: [{ key: "d", mod: true }],
  },
  { id: "undo", title: "Undo", group: "Edit", keys: [{ key: "z", mod: true }] },
  {
    id: "redo",
    title: "Redo",
    group: "Edit",
    keys: [
      { key: "z", mod: true, shift: true },
      { key: "y", mod: true },
    ],
  },
  { id: "focus", title: "Frame the selection", group: "View", keys: [{ key: "f" }] },
  { id: "centre", title: "Centre on the cursor", group: "View", keys: [{ key: "c" }] },
  { id: "pan-left", title: "Pan left", group: "View", keys: [{ key: "ArrowLeft" }] },
  { id: "pan-right", title: "Pan right", group: "View", keys: [{ key: "ArrowRight" }] },
  { id: "pan-forward", title: "Pan forward", group: "View", keys: [{ key: "ArrowUp" }] },
  { id: "pan-back", title: "Pan back", group: "View", keys: [{ key: "ArrowDown" }] },
  {
    id: "orbit-left",
    title: "Orbit left",
    group: "View",
    keys: [{ key: "ArrowLeft", shift: true }],
  },
  {
    id: "orbit-right",
    title: "Orbit right",
    group: "View",
    keys: [{ key: "ArrowRight", shift: true }],
  },
  {
    id: "tilt-down",
    title: "Tilt to look down from above",
    group: "View",
    keys: [{ key: "ArrowUp", shift: true }],
  },
  {
    id: "tilt-up",
    title: "Tilt toward the horizon",
    group: "View",
    keys: [{ key: "ArrowDown", shift: true }],
  },
  { id: "zoom-in", title: "Zoom in", group: "View", keys: [{ key: "=" }, { key: "+" }] },
  { id: "zoom-out", title: "Zoom out", group: "View", keys: [{ key: "-" }] },
  { id: "toggle-joins", title: "Show road join markers", group: "View", keys: [{ key: "j" }] },
  {
    id: "toggle-road-snap",
    title: "Snap road pieces to matching edges",
    group: "Edit",
    keys: [{ key: "s" }],
  },
  { id: "show-shortcuts", title: "Keyboard shortcuts", group: "Help", keys: [{ key: "?" }] },
];

export const POINTER_GESTURES: ReadonlyArray<PointerGesture> = [
  { gesture: "Click", action: "Place the part in hand, or select a model" },
  { gesture: "Drag", action: "Lay a run of track while drawing track" },
  { gesture: "Right-drag", action: "Orbit" },
  { gesture: "Shift-drag or middle-drag", action: "Pan" },
  { gesture: "Wheel", action: "Zoom" },
];

const PAN_STEP_PX = 120;
const ORBIT_STEP_PX = 52;
const ZOOM_STEP_WHEEL = 200;
const QUARTER_TURNS = 4;

const SPECS = new Map(COMMANDS.map((spec) => [spec.id, spec]));

export function commandSpec(id: CommandId): CommandSpec {
  const spec = SPECS.get(id);
  if (!spec) throw new Error(`no command ${id}`);
  return spec;
}

export function commandForKey(input: KeyInput, typing: boolean): CommandId | null {
  for (const spec of COMMANDS) {
    if (typing && !spec.whileTyping) continue;
    if (spec.keys.some((chord) => chordMatches(chord, input))) return spec.id;
  }
  return null;
}

export function isShellCommand(id: CommandId): id is ShellCommandId {
  return id === "show-shortcuts";
}

export function commandActive(id: CommandId, snapshot: EditorSnapshot): boolean {
  if (id === "select-tool") return snapshot.mode === "select";
  if (id === "draw-track") return snapshot.mode === "track";
  if (id === "toggle-joins") return snapshot.showJoins;
  if (id === "toggle-road-snap") return snapshot.snapRoads;
  return false;
}

export function commandEnabled(id: CommandId, snapshot: EditorSnapshot): boolean {
  if (isShellCommand(id)) return true;
  if (snapshot.status !== "ready") return false;
  switch (id) {
    case "rotate":
      return snapshot.mode === "place" || snapshot.selection !== null;
    case "delete":
    case "duplicate":
    case "focus":
      return snapshot.selection !== null;
    case "undo":
      return snapshot.history.undo !== null;
    case "redo":
      return snapshot.history.redo !== null;
    case "centre":
      return snapshot.hover !== null;
    case "draw-track":
      return snapshot.catalog.some((item) => item.id === TRACK_ITEM_ID);
    case "select-tool":
    case "pan-left":
    case "pan-right":
    case "pan-forward":
    case "pan-back":
    case "orbit-left":
    case "orbit-right":
    case "tilt-down":
    case "tilt-up":
    case "zoom-in":
    case "zoom-out":
    case "toggle-joins":
    case "toggle-road-snap":
      return true;
    default: {
      const unhandled: never = id;
      throw new Error(`unhandled command ${String(unhandled)}`);
    }
  }
}

function placeMoreLikeSelection(editor: IEditor, eventTimeMs: number): void {
  const selection = editor.snapshot().selection;
  if (!selection) return;
  editor.chooseItem(selection.item);
  const turns = (selection.rot - editor.snapshot().ghostRot + QUARTER_TURNS) % QUARTER_TURNS;
  for (let turn = 0; turn < turns; turn++) editor.rotate(eventTimeMs);
}

export function runEditorAction(editor: IEditor, id: EditorActionId, eventTimeMs: number): void {
  switch (id) {
    case "select-tool":
      editor.chooseItem(null);
      return;
    case "draw-track":
      editor.chooseItem(editor.snapshot().mode === "track" ? null : TRACK_ITEM_ID);
      return;
    case "rotate":
      editor.rotate(eventTimeMs);
      return;
    case "delete":
      editor.deleteSelection(eventTimeMs);
      return;
    case "duplicate":
      placeMoreLikeSelection(editor, eventTimeMs);
      return;
    case "undo":
      editor.undo(eventTimeMs);
      return;
    case "redo":
      editor.redo(eventTimeMs);
      return;
    case "focus":
      editor.focusSelection();
      return;
    case "centre":
      editor.centreOnCursor();
      return;
    case "pan-left":
      editor.pan(PAN_STEP_PX, 0);
      return;
    case "pan-right":
      editor.pan(-PAN_STEP_PX, 0);
      return;
    case "pan-forward":
      editor.pan(0, PAN_STEP_PX);
      return;
    case "pan-back":
      editor.pan(0, -PAN_STEP_PX);
      return;
    case "orbit-left":
      editor.orbit(-ORBIT_STEP_PX, 0);
      return;
    case "orbit-right":
      editor.orbit(ORBIT_STEP_PX, 0);
      return;
    case "tilt-down":
      editor.orbit(0, ORBIT_STEP_PX);
      return;
    case "tilt-up":
      editor.orbit(0, -ORBIT_STEP_PX);
      return;
    case "zoom-in":
      editor.zoom(-ZOOM_STEP_WHEEL);
      return;
    case "zoom-out":
      editor.zoom(ZOOM_STEP_WHEEL);
      return;
    case "toggle-joins":
      editor.setShowJoins(!editor.snapshot().showJoins);
      return;
    case "toggle-road-snap":
      editor.setSnapRoads(!editor.snapshot().snapRoads);
      return;
    default: {
      const unhandled: never = id;
      throw new Error(`unhandled editor action ${String(unhandled)}`);
    }
  }
}

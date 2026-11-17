import type { IEditorCamera } from "../camera/editor-camera.ts";
import { TRACK_ITEM_ID, type EditorSnapshot, type IEditor } from "../edit/editor.ts";
import { chordMatches, type KeyChord, type KeyInput } from "./key-chord.ts";

export type EditorActionId =
  | "select-tool"
  | "draw-track"
  | "draw-road"
  | "rotate"
  | "delete"
  | "duplicate"
  | "undo"
  | "redo"
  | "focus"
  | "fit-all"
  | "toggle-plan-view"
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

export type ShellCommandId = "show-shortcuts" | "open-palette";

export type CommandId = EditorActionId | ShellCommandId;

export type CommandGroup = "Tools" | "Edit" | "View" | "Help";

export interface CommandSpec {
  readonly id: CommandId;
  readonly title: string;
  readonly group: CommandGroup;
  readonly keys: ReadonlyArray<KeyChord>;
  readonly keywords?: string;
  readonly whileTyping?: boolean;
  readonly repeats?: boolean;
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
    keywords: "cancel stop escape deselect pointer",
  },
  {
    id: "draw-track",
    title: "Draw track",
    group: "Tools",
    keys: [{ key: "t" }],
    keywords: "rail train lay 9v",
  },
  {
    id: "draw-road",
    title: "Draw road",
    group: "Tools",
    keys: [{ key: "g" }],
    keywords: "street lay plates mils",
  },
  {
    id: "rotate",
    title: "Rotate 90°",
    group: "Edit",
    keys: [{ key: "r" }],
    keywords: "turn spin quarter",
  },
  {
    id: "delete",
    title: "Delete the selection",
    group: "Edit",
    keys: [{ key: "Delete" }, { key: "Backspace" }],
    keywords: "remove erase",
  },
  {
    id: "duplicate",
    title: "Place more like the selection",
    group: "Edit",
    keys: [{ key: "d", mod: true }],
    keywords: "duplicate copy clone again pick",
  },
  {
    id: "undo",
    title: "Undo",
    group: "Edit",
    keys: [{ key: "z", mod: true }],
    keywords: "back revert",
    repeats: true,
  },
  {
    id: "redo",
    title: "Redo",
    group: "Edit",
    keys: [
      { key: "z", mod: true, shift: true },
      { key: "y", mod: true },
    ],
    keywords: "again forward",
    repeats: true,
  },
  {
    id: "focus",
    title: "Frame the selection",
    group: "View",
    keys: [{ key: "f" }],
    keywords: "focus zoom to fit",
  },
  {
    id: "fit-all",
    title: "Fit everything in view",
    group: "View",
    keys: [{ key: "Home" }, { key: "f", shift: true }],
    keywords: "zoom extents home whole layout overview",
  },
  {
    id: "toggle-plan-view",
    title: "Switch between the 3D view and the true-scale 2D plan",
    group: "View",
    keys: [{ key: "v" }],
    keywords: "plan top down 2d orthographic overhead",
  },
  {
    id: "centre",
    title: "Centre on the cursor",
    group: "View",
    keys: [{ key: "c" }],
    keywords: "center look at",
  },
  { id: "pan-left", title: "Pan left", group: "View", keys: [{ key: "ArrowLeft" }], repeats: true },
  {
    id: "pan-right",
    title: "Pan right",
    group: "View",
    keys: [{ key: "ArrowRight" }],
    repeats: true,
  },
  {
    id: "pan-forward",
    title: "Pan forward",
    group: "View",
    keys: [{ key: "ArrowUp" }],
    repeats: true,
  },
  { id: "pan-back", title: "Pan back", group: "View", keys: [{ key: "ArrowDown" }], repeats: true },
  {
    id: "orbit-left",
    title: "Orbit left",
    group: "View",
    keys: [{ key: "ArrowLeft", shift: true }],
    repeats: true,
  },
  {
    id: "orbit-right",
    title: "Orbit right",
    group: "View",
    keys: [{ key: "ArrowRight", shift: true }],
    repeats: true,
  },
  {
    id: "tilt-down",
    title: "Tilt to look down from above",
    group: "View",
    keys: [{ key: "ArrowUp", shift: true }],
    repeats: true,
  },
  {
    id: "tilt-up",
    title: "Tilt toward the horizon",
    group: "View",
    keys: [{ key: "ArrowDown", shift: true }],
    repeats: true,
  },
  {
    id: "zoom-in",
    title: "Zoom in",
    group: "View",
    keys: [{ key: "=" }, { key: "+" }],
    repeats: true,
  },
  { id: "zoom-out", title: "Zoom out", group: "View", keys: [{ key: "-" }], repeats: true },
  {
    id: "toggle-joins",
    title: "Show road join markers",
    group: "View",
    keys: [{ key: "j" }],
    keywords: "toggle edges open mismatch",
  },
  {
    id: "toggle-road-snap",
    title: "Snap road pieces to matching edges",
    group: "Edit",
    keys: [{ key: "s" }],
    keywords: "toggle magnet align",
  },
  {
    id: "open-palette",
    title: "Find a part or command",
    group: "Help",
    keys: [{ key: "k", mod: true }, { key: "/" }],
    keywords: "search palette command quick open",
    whileTyping: true,
  },
  {
    id: "show-shortcuts",
    title: "Keyboard shortcuts",
    group: "Help",
    keys: [{ key: "?" }],
    keywords: "help keys hotkeys cheat sheet",
  },
];

export const POINTER_GESTURES: ReadonlyArray<PointerGesture> = [
  { gesture: "Click", action: "Place the part in hand, or select a model" },
  { gesture: "Drag", action: "Lay a run of track while drawing track" },
  { gesture: "Right-drag", action: "Orbit (pan in the 2D plan)" },
  {
    gesture: "Shift-, Space- or middle-drag",
    action: "Pan, keeping the grabbed point under the cursor",
  },
  { gesture: "Wheel or pinch", action: "Zoom at the cursor" },
  { gesture: "Two-finger scroll", action: "Pan on a trackpad (Alt orbits)" },
  { gesture: "Double-click", action: "Frame the selection" },
];

const PAN_STEP_PX = 120;
const ORBIT_STEP_PX = 52;
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
    const typed = spec.keys.filter((chord) => !typing || chord.mod);
    if (typed.some((chord) => chordMatches(chord, input))) return spec.id;
  }
  return null;
}

export function isShellCommand(id: CommandId): id is ShellCommandId {
  return id === "show-shortcuts" || id === "open-palette";
}

export function commandActive(id: CommandId, snapshot: EditorSnapshot): boolean {
  if (id === "select-tool") return snapshot.mode === "select";
  if (id === "draw-track") return snapshot.mode === "track";
  if (id === "draw-road") return snapshot.mode === "road";
  if (id === "toggle-joins") return snapshot.showJoins;
  if (id === "toggle-road-snap") return snapshot.snapRoads;
  return false;
}

export function commandEnabled(id: CommandId, snapshot: EditorSnapshot): boolean {
  if (isShellCommand(id)) return true;
  if (snapshot.status !== "ready") return false;
  switch (id) {
    case "rotate":
      return snapshot.mode === "place" || snapshot.mode === "road" || snapshot.selection !== null;
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
    case "draw-road":
      return snapshot.roadKit !== null;
    case "select-tool":
    case "fit-all":
    case "toggle-plan-view":
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

export function runEditorAction(
  editor: IEditor,
  camera: IEditorCamera,
  id: EditorActionId,
  eventTimeMs: number,
): void {
  switch (id) {
    case "select-tool":
      editor.chooseItem(null);
      return;
    case "draw-track":
      editor.chooseItem(editor.snapshot().mode === "track" ? null : TRACK_ITEM_ID);
      return;
    case "draw-road": {
      const snapshot = editor.snapshot();
      editor.chooseItem(snapshot.mode === "road" ? null : snapshot.roadKit);
      return;
    }
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
    case "focus": {
      const selection = editor.snapshot().selection;
      if (selection) camera.focus(selection.box);
      return;
    }
    case "fit-all":
      camera.fitAll();
      return;
    case "toggle-plan-view":
      camera.setMode(camera.snapshot().mode === "plan" ? "orbit" : "plan");
      return;
    case "centre": {
      const hover = editor.snapshot().hover;
      if (hover) camera.lookAt(hover.x, hover.z, true);
      return;
    }
    case "pan-left":
      camera.panBy(-PAN_STEP_PX, 0);
      return;
    case "pan-right":
      camera.panBy(PAN_STEP_PX, 0);
      return;
    case "pan-forward":
      camera.panBy(0, -PAN_STEP_PX);
      return;
    case "pan-back":
      camera.panBy(0, PAN_STEP_PX);
      return;
    case "orbit-left":
      camera.orbit(-ORBIT_STEP_PX, 0);
      return;
    case "orbit-right":
      camera.orbit(ORBIT_STEP_PX, 0);
      return;
    case "tilt-down":
      camera.orbit(0, ORBIT_STEP_PX);
      return;
    case "tilt-up":
      camera.orbit(0, -ORBIT_STEP_PX);
      return;
    case "zoom-in":
      camera.zoomStep(1);
      return;
    case "zoom-out":
      camera.zoomStep(-1);
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

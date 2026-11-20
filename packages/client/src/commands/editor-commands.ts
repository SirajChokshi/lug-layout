import type { IEditorCamera } from "../camera/editor-camera.ts";
import { TRACK_ITEM_ID, type EditorSnapshot, type IEditor } from "../edit/editor.ts";
import type { ITrainPlay, PlaySnapshot } from "../play/train-play.ts";
import { chordMatches, type KeyChord, type KeyInput } from "./key-chord.ts";

export type EditorActionId =
  | "select-tool"
  | "draw-track"
  | "draw-road"
  | "rotate"
  | "rotate-back"
  | "flip-switch"
  | "next-connector"
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
  | "toggle-grid"
  | "toggle-road-snap"
  | "cycle-tier"
  | "measure-frames";

export type ShellCommandId = "show-shortcuts" | "open-palette";

export type PlayCommandId = "play" | "throttle-up" | "throttle-down" | "stop-train" | "rerail";

export type CommandId = EditorActionId | ShellCommandId | PlayCommandId;

export type CommandGroup = "Tools" | "Edit" | "View" | "Play" | "Help";

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

export const COMMAND_GROUPS: ReadonlyArray<CommandGroup> = [
  "Tools",
  "Edit",
  "View",
  "Play",
  "Help",
];

export const PLAY_THROTTLE_STEP_LDU_PER_S = 40;

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
    keywords: "street lay plates",
  },
  {
    id: "rotate",
    title: "Rotate",
    group: "Edit",
    keys: [{ key: "r" }],
    keywords: "turn spin quarter 90",
  },
  {
    id: "rotate-back",
    title: "Rotate the other way",
    group: "Edit",
    keys: [{ key: "r", shift: true }],
    keywords: "turn spin quarter 90 back reverse counter anticlockwise",
  },
  {
    id: "flip-switch",
    title: "Swap the held switch between left and right",
    group: "Edit",
    keys: [{ key: "x" }],
    keywords: "mirror flip turnout points hand",
  },
  {
    id: "next-connector",
    title: "Attach the held track piece by its next end",
    group: "Edit",
    keys: [{ key: "q" }],
    keywords: "cycle swing connector reverse curve",
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
    keys: [{ key: "p" }],
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
    id: "toggle-grid",
    title: "Show the stud grid on the ground",
    group: "View",
    keys: [{ key: "#" }],
    keywords: "toggle grid ground table floor studs lines guides",
  },
  {
    id: "toggle-road-snap",
    title: "Snap road pieces to matching edges",
    group: "Edit",
    keys: [{ key: "s" }],
    keywords: "toggle magnet align",
  },
  {
    id: "cycle-tier",
    title: "Cycle the detail tier: auto, near, mid, far",
    group: "View",
    keys: [{ key: "l" }],
    keywords: "lod level of detail near mid far voxel",
  },
  {
    id: "measure-frames",
    title: "Measure 60 GPU-synced frames of this view",
    group: "View",
    keys: [{ key: "m" }],
    keywords: "frame time performance benchmark gpu",
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
  {
    id: "play",
    title: "Run a train, or leave play",
    group: "Play",
    keys: [{ key: "p", shift: true }],
  },
  { id: "throttle-up", title: "Throttle forward", group: "Play", keys: [{ key: "]" }] },
  { id: "throttle-down", title: "Throttle back", group: "Play", keys: [{ key: "[" }] },
  { id: "stop-train", title: "Stop the train", group: "Play", keys: [{ key: " " }] },
  { id: "rerail", title: "Rerail a derailed train", group: "Play", keys: [{ key: "e" }] },
];

export const POINTER_GESTURES: ReadonlyArray<PointerGesture> = [
  { gesture: "Click", action: "Place the part in hand, or select a model" },
  { gesture: "Drag", action: "Lay a run of track or road while drawing it" },
  { gesture: "Right-drag", action: "Orbit (pan in the 2D plan)" },
  {
    gesture: "Shift-, Space- or middle-drag",
    action: "Pan, keeping the grabbed point under the cursor (Space also stops a moving train)",
  },
  { gesture: "Wheel or pinch", action: "Zoom at the cursor" },
  { gesture: "Two-finger scroll", action: "Pan on a trackpad (Alt orbits)" },
  { gesture: "Double-click", action: "Frame the selection" },
  { gesture: "Click a switch", action: "Throw it while a train runs" },
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

export function isPlayCommand(id: CommandId): id is PlayCommandId {
  return (
    id === "play" ||
    id === "throttle-up" ||
    id === "throttle-down" ||
    id === "stop-train" ||
    id === "rerail"
  );
}

export function commandActive(id: CommandId, snapshot: EditorSnapshot): boolean {
  if (id === "select-tool") return snapshot.mode === "select";
  if (id === "draw-track") return snapshot.mode === "track";
  if (id === "draw-road") return snapshot.mode === "road";
  if (id === "toggle-joins") return snapshot.showJoins;
  if (id === "toggle-grid") return snapshot.showGrid;
  if (id === "toggle-road-snap") return snapshot.snapRoads;
  return false;
}

const CAMERA_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>([
  "select-tool",
  "focus",
  "fit-all",
  "toggle-plan-view",
  "cycle-tier",
  "measure-frames",
  "centre",
  "pan-left",
  "pan-right",
  "pan-forward",
  "pan-back",
  "orbit-left",
  "orbit-right",
  "tilt-down",
  "tilt-up",
  "zoom-in",
  "zoom-out",
  "toggle-joins",
  "toggle-grid",
]);

export function runsDuringPlay(id: CommandId): boolean {
  return isShellCommand(id) || isPlayCommand(id) || CAMERA_COMMANDS.has(id);
}

export function playCommandEnabled(id: PlayCommandId, play: PlaySnapshot | undefined): boolean {
  if (!play) return id === "play";
  const running = play.status === "running";
  const derailed = play.derailSpeedLduPerS > 0;
  const max = play.maxSpeedLduPerS;
  switch (id) {
    case "play":
      return play.status !== "loading";
    case "throttle-up":
      return running && !derailed && play.targetLduPerS < max;
    case "throttle-down":
      return running && !derailed && play.targetLduPerS > -max;
    case "stop-train":
      return running && !derailed && (play.targetLduPerS !== 0 || play.speedLduPerS !== 0);
    case "rerail":
      return running && derailed;
    default: {
      const unhandled: never = id;
      throw new Error(`unhandled play command ${String(unhandled)}`);
    }
  }
}

export function commandEnabled(
  id: CommandId,
  snapshot: EditorSnapshot,
  play?: PlaySnapshot,
): boolean {
  if (isShellCommand(id)) return true;
  if (snapshot.status !== "ready") return false;
  if (isPlayCommand(id)) return playCommandEnabled(id, play);
  if (play?.status === "running" && !runsDuringPlay(id)) return false;
  switch (id) {
    case "rotate":
    case "rotate-back":
      return (
        !snapshot.readOnly &&
        (snapshot.mode === "place" ||
          snapshot.mode === "road" ||
          snapshot.selection !== null ||
          snapshot.track?.held != null)
      );
    case "flip-switch":
      return snapshot.track?.held?.mirror != null;
    case "next-connector":
      return snapshot.track?.held != null;
    case "delete":
    case "duplicate":
      return snapshot.selection !== null && !snapshot.readOnly;
    case "focus":
      return snapshot.selection !== null;
    case "undo":
      return snapshot.history.undo !== null && !snapshot.readOnly;
    case "redo":
      return snapshot.history.redo !== null && !snapshot.readOnly;
    case "centre":
      return snapshot.hover !== null;
    case "draw-track":
      return !snapshot.readOnly && snapshot.catalog.some((item) => item.id === TRACK_ITEM_ID);
    case "draw-road":
      return snapshot.roadKit !== null && !snapshot.readOnly;
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
    case "toggle-grid":
    case "toggle-road-snap":
    case "cycle-tier":
    case "measure-frames":
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
  const direction = turns > QUARTER_TURNS / 2 ? -1 : 1;
  const presses = direction === 1 ? turns : QUARTER_TURNS - turns;
  for (let press = 0; press < presses; press++) editor.rotate(eventTimeMs, direction);
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
      editor.rotate(eventTimeMs, 1);
      return;
    case "rotate-back":
      editor.rotate(eventTimeMs, -1);
      return;
    case "flip-switch":
      editor.mirrorPiece();
      return;
    case "next-connector":
      editor.cycleConnector();
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
    case "toggle-grid":
      editor.setShowGrid(!editor.snapshot().showGrid);
      return;
    case "toggle-road-snap":
      editor.setSnapRoads(!editor.snapshot().snapRoads);
      return;
    case "cycle-tier":
      editor.cycleTier();
      return;
    case "measure-frames":
      editor.measureFrames();
      return;
    default: {
      const unhandled: never = id;
      throw new Error(`unhandled editor action ${String(unhandled)}`);
    }
  }
}

export function startPlay(editor: IEditor, play: ITrainPlay): void {
  const setup = editor.playSetup();
  if (!setup) return;
  editor.chooseItem(null);
  void play.start(setup);
}

export function runPlayAction(editor: IEditor, play: ITrainPlay, id: PlayCommandId): void {
  const { status, targetLduPerS } = play.snapshot();
  switch (id) {
    case "play":
      if (status === "running") play.stop();
      else startPlay(editor, play);
      return;
    case "throttle-up":
      play.drive(targetLduPerS + PLAY_THROTTLE_STEP_LDU_PER_S);
      return;
    case "throttle-down":
      play.drive(targetLduPerS - PLAY_THROTTLE_STEP_LDU_PER_S);
      return;
    case "stop-train":
      play.drive(0);
      return;
    case "rerail":
      play.rerail();
      return;
    default: {
      const unhandled: never = id;
      throw new Error(`unhandled play action ${String(unhandled)}`);
    }
  }
}

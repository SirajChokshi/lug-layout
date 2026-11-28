import { BRICK_LDU, PLATE_LDU, STUD_LDU } from "@brr/math";
import type { GroundDirection, IEditorCamera } from "../camera/editor-camera.ts";
import type { EditorSnapshot, IEditor } from "../edit/editor.ts";
import { TRACK_ITEM_ID } from "../edit/track-edit-session.ts";
import { placementModeSwitchEnabled, togglePlacementMode } from "../edit/placement-mode.ts";
import type { ITrainPlay, PlaySnapshot } from "../play/train-play.ts";
import { KEY_FOR_SLOT } from "./hotbar.ts";
import { chordMatches, type KeyChord, type KeyInput } from "./key-chord.ts";
import { shellModeOffered, type ShellMode } from "./shell-mode.ts";

export type NudgeId = "nudge-left" | "nudge-right" | "nudge-forward" | "nudge-back";

export type EditorActionId =
  | "cancel"
  | "select-tool"
  | "draw-track"
  | "draw-road"
  | "measure"
  | "draw-tables"
  | "cycle-fill-grid"
  | "rotate"
  | "rotate-back"
  | "flip-switch"
  | "next-connector"
  | "extend-straight"
  | "extend-left"
  | "extend-right"
  | "extend-preview"
  | "next-track-choice"
  | "previous-track-choice"
  | "close-track-loop"
  | "raise-track"
  | "lower-track"
  | "raise-track-brick"
  | "lower-track-brick"
  | "delete"
  | "duplicate"
  | "copy"
  | "paste"
  | "undo"
  | "redo"
  | NudgeId
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
  | "toggle-placement-mode"
  | "cycle-tier"
  | "measure-frames";

export type ShellModeCommandId = `${ShellMode}-mode`;

export type ShellCommandId = "show-shortcuts" | "open-palette" | ShellModeCommandId;

export type PlayCommandId = "play" | "throttle-up" | "throttle-down" | "stop-train" | "rerail";

export type CommandId = EditorActionId | ShellCommandId | PlayCommandId | "pick-slot";

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

export type CommandMatch =
  | { readonly id: Exclude<CommandId, "pick-slot"> }
  | { readonly id: "pick-slot"; readonly slot: number };

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
const PLATES_PER_BRICK = BRICK_LDU / PLATE_LDU;

export const COMMANDS: ReadonlyArray<CommandSpec> = [
  {
    id: "cancel",
    title: "Cancel the drag or the paste in hand",
    group: "Tools",
    keys: [{ key: "Escape" }],
    keywords: "abort escape drop undo",
  },
  {
    id: "select-tool",
    title: "Select tool: stop placing, clear the selection",
    group: "Tools",
    keys: [{ key: "Escape" }],
    keywords: "cancel stop escape deselect pointer",
  },
  {
    id: "pick-slot",
    title: "Pick up the part in a hotbar slot",
    group: "Tools",
    keys: KEY_FOR_SLOT,
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
    id: "measure",
    title: "Measure: drag a ruler in studs and cm",
    group: "Tools",
    keys: [{ key: "u" }],
    keywords: "ruler distance length dimension tape size",
  },
  {
    id: "draw-tables",
    title: "Draw tables: drag to draw, drag an edge or corner to resize",
    group: "Tools",
    keys: [{ key: "b" }],
    keywords: "table board room plan size studs cm",
  },
  {
    id: "cycle-fill-grid",
    title: "Fill grid: 8, 16 or 32 studs, for dragging an area or filling the tables",
    group: "Edit",
    keys: [{ key: "g", shift: true }],
    keywords: "fill area tile repeat paint grid step pitch",
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
    title: "Attach the held or previewed track piece by its next end",
    group: "Edit",
    keys: [{ key: "q" }],
    keywords: "cycle swing connector reverse curve hand",
  },
  {
    id: "extend-straight",
    title: "Lay a straight on the track end",
    group: "Edit",
    keys: [{ key: "w" }],
    keywords: "append extend next piece forward rail",
  },
  {
    id: "extend-left",
    title: "Lay a left curve on the track end",
    group: "Edit",
    keys: [{ key: "a" }],
    keywords: "append extend next piece turn bend rail",
  },
  {
    id: "extend-right",
    title: "Lay a right curve on the track end",
    group: "Edit",
    keys: [{ key: "d" }],
    keywords: "append extend next piece turn bend rail",
  },
  {
    id: "extend-preview",
    title: "Lay the piece or join previewed on the track end",
    group: "Edit",
    keys: [{ key: "Enter" }],
    keywords: "append extend again repeat close loop join complete",
  },
  {
    id: "next-track-choice",
    title: "Preview the next choice on the track end",
    group: "Edit",
    keys: [{ key: "." }],
    keywords: "cycle option piece join",
  },
  {
    id: "previous-track-choice",
    title: "Preview the previous choice on the track end",
    group: "Edit",
    keys: [{ key: "," }],
    keywords: "cycle option piece join back",
  },
  {
    id: "close-track-loop",
    title: "Close the nearest pair of open track ends that joins exactly",
    group: "Edit",
    keys: [{ key: "o" }],
    keywords: "close loop gap join complete oval circuit ends",
  },
  {
    id: "raise-track",
    title: "Draw track one plate higher",
    group: "Edit",
    keys: [{ key: "PageUp" }],
    keywords: "height elevation raise bridge viaduct ramp up",
    repeats: true,
  },
  {
    id: "lower-track",
    title: "Draw track one plate lower",
    group: "Edit",
    keys: [{ key: "PageDown" }],
    keywords: "height elevation lower ramp down",
    repeats: true,
  },
  {
    id: "raise-track-brick",
    title: "Draw track one brick higher",
    group: "Edit",
    keys: [{ key: "PageUp", shift: true }],
    keywords: "height elevation raise bridge viaduct",
    repeats: true,
  },
  {
    id: "lower-track-brick",
    title: "Draw track one brick lower",
    group: "Edit",
    keys: [{ key: "PageDown", shift: true }],
    keywords: "height elevation lower",
    repeats: true,
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
    id: "copy",
    title: "Copy the selection",
    group: "Edit",
    keys: [{ key: "c", mod: true }],
    keywords: "clipboard group duplicate",
  },
  {
    id: "paste",
    title: "Paste the copied selection on the cursor",
    group: "Edit",
    keys: [{ key: "v", mod: true }],
    keywords: "clipboard group insert",
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
    id: "nudge-left",
    title: "Move the selection a stud left",
    group: "Edit",
    keys: [{ key: "ArrowLeft" }],
    keywords: "nudge step shift arrow",
    repeats: true,
  },
  {
    id: "nudge-right",
    title: "Move the selection a stud right",
    group: "Edit",
    keys: [{ key: "ArrowRight" }],
    keywords: "nudge step shift arrow",
    repeats: true,
  },
  {
    id: "nudge-forward",
    title: "Move the selection a stud up the screen",
    group: "Edit",
    keys: [{ key: "ArrowUp" }],
    keywords: "nudge step shift arrow",
    repeats: true,
  },
  {
    id: "nudge-back",
    title: "Move the selection a stud down the screen",
    group: "Edit",
    keys: [{ key: "ArrowDown" }],
    keywords: "nudge step shift arrow",
    repeats: true,
  },
  {
    id: "build-mode",
    title: "Build: the library, the tools and the inspector, in 3D",
    group: "View",
    keys: [],
    keywords: "mode edit lay place parts library",
  },
  {
    id: "plan-mode",
    title: "Plan: tables, checks, print sheets and the parts list, in 2D",
    group: "View",
    keys: [],
    keywords: "mode check issues event print shopping bom",
  },
  {
    id: "play-mode",
    title: "Play: run the trains from the cab",
    group: "View",
    keys: [],
    keywords: "mode drive throttle train",
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
    id: "toggle-placement-mode",
    title:
      "Switch between magnetic and precise placement (at an open track end, A lays a left curve)",
    group: "Edit",
    keys: [{ key: "a" }],
    keywords: "snap magnet magnetic assist precise exact free toggle",
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
  { gesture: "Click", action: "Place the part in hand, or select a model or track piece" },
  { gesture: "Shift-click", action: "Add a model or track piece to the selection, or take it out" },
  {
    gesture: "Drag",
    action: "Lay a run of track or road while drawing it, or fill an area with the part in hand",
  },
  {
    gesture: "Drag from outside the selection",
    action:
      "Box-select every model and track piece inside the box (Ctrl or Cmd adds to the selection)",
  },
  {
    gesture: "Drag a selected model or track piece",
    action: "Move the whole selection (Esc cancels)",
  },
  { gesture: "Right-drag", action: "Orbit (pan in the 2D plan)" },
  {
    gesture: "Shift-, Space- or middle-drag",
    action: "Pan, keeping the grabbed point under the cursor (Space also stops a moving train)",
  },
  { gesture: "Wheel or pinch", action: "Zoom at the cursor" },
  { gesture: "Two-finger scroll", action: "Pan on a trackpad (Alt orbits)" },
  {
    gesture: "Hold Alt (⌥ on a Mac)",
    action:
      "Switch between magnetic and precise placement while held (with a two-finger scroll it still orbits)",
  },
  {
    gesture: "Double-click a track piece",
    action: "Select its run, up to the next switch or open end",
  },
  { gesture: "Shift-double-click a track piece", action: "Select all the track joined to it" },
  { gesture: "Double-click a model or train", action: "Frame it" },
  { gesture: "Click a switch", action: "Throw it while a train runs" },
];

const NUDGE_SCREEN: Readonly<Record<NudgeId, readonly [number, number]>> = {
  "nudge-left": [-1, 0],
  "nudge-right": [1, 0],
  "nudge-forward": [0, -1],
  "nudge-back": [0, 1],
};

const PAN_STEP_PX = 120;
const ORBIT_STEP_PX = 52;
const QUARTER_TURNS = 4;

const SPECS = new Map(COMMANDS.map((spec) => [spec.id, spec]));

export function commandSpec(id: CommandId): CommandSpec {
  const spec = SPECS.get(id);
  if (!spec) throw new Error(`no command ${id}`);
  return spec;
}

export function commandsForKey(input: KeyInput, typing: boolean): ReadonlyArray<CommandMatch> {
  const bound: CommandMatch[] = [];
  for (const spec of COMMANDS) {
    if (typing && !spec.whileTyping) continue;
    const keyIndex = spec.keys.findIndex(
      (chord) => (!typing || chord.mod === true) && chordMatches(chord, input),
    );
    if (keyIndex < 0) continue;
    const { id } = spec;
    bound.push(isHotbarCommand(id) ? { id, slot: keyIndex } : { id });
  }
  return bound;
}

export function commandForKey(
  input: KeyInput,
  typing: boolean,
  enabled: (id: CommandId) => boolean,
): CommandMatch | null {
  const bound = commandsForKey(input, typing);
  return bound.find((match) => enabled(match.id)) ?? bound[0] ?? null;
}

export function shellModeCommand(id: ShellCommandId): ShellMode | null {
  switch (id) {
    case "build-mode":
      return "build";
    case "plan-mode":
      return "plan";
    case "play-mode":
      return "play";
    case "show-shortcuts":
    case "open-palette":
      return null;
    default: {
      const unhandled: never = id;
      throw new Error(`unhandled shell command ${String(unhandled)}`);
    }
  }
}

const SHELL_COMMANDS: ReadonlySet<CommandId> = new Set<ShellCommandId>([
  "show-shortcuts",
  "open-palette",
  "build-mode",
  "plan-mode",
  "play-mode",
]);

export function isShellCommand(id: CommandId): id is ShellCommandId {
  return SHELL_COMMANDS.has(id);
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

export function isHotbarCommand(id: CommandId): id is "pick-slot" {
  return id === "pick-slot";
}

export function commandActive(id: CommandId, snapshot: EditorSnapshot): boolean {
  if (id === "select-tool") return snapshot.mode === "select";
  if (id === "draw-track") return snapshot.mode === "track";
  if (id === "draw-road") return snapshot.mode === "road";
  if (id === "measure") return snapshot.mode === "measure";
  if (id === "draw-tables") return snapshot.mode === "table";
  if (id === "toggle-joins") return snapshot.showJoins;
  if (id === "toggle-grid") return snapshot.showGrid;
  if (id === "toggle-road-snap") return snapshot.snapRoads;
  if (id === "toggle-placement-mode") return snapshot.placementMode === "precise";
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

function previewsLibraryPiece(snapshot: EditorSnapshot): boolean {
  const extend = snapshot.track?.extend;
  return !snapshot.readOnly && extend?.choices[extend.index]?.kind === "piece";
}

export function commandEnabled(
  id: CommandId,
  snapshot: EditorSnapshot,
  play?: PlaySnapshot,
): boolean {
  if (isShellCommand(id)) {
    const mode = shellModeCommand(id);
    return mode === null || shellModeOffered(mode, play);
  }
  if (snapshot.status !== "ready") return false;
  if (isPlayCommand(id)) return playCommandEnabled(id, play);
  if (play?.status === "running" && !runsDuringPlay(id)) return false;
  switch (id) {
    case "cancel":
      return (
        snapshot.gesture !== null || snapshot.fillDraft !== null || snapshot.armedTable !== null
      );
    case "toggle-placement-mode":
      return placementModeSwitchEnabled(snapshot, play);
    case "rotate":
    case "rotate-back":
      return (
        !snapshot.readOnly &&
        (snapshot.mode === "place" ||
          snapshot.mode === "road" ||
          (snapshot.mode === "table" &&
            (snapshot.armedTable !== null || snapshot.hoveredTable !== null)) ||
          snapshot.selection?.movable === true ||
          (snapshot.gesture !== null && snapshot.gesture.kind !== "box") ||
          snapshot.track?.held != null)
      );
    case "flip-switch":
      return snapshot.track?.held?.mirror != null;
    case "next-connector":
      return snapshot.track?.held != null || previewsLibraryPiece(snapshot);
    case "extend-straight":
    case "extend-left":
    case "extend-right":
    case "extend-preview":
      return snapshot.track?.extend != null && !snapshot.readOnly;
    case "next-track-choice":
    case "previous-track-choice":
      return (
        (snapshot.track?.extend != null || snapshot.track?.held?.resizable === true) &&
        !snapshot.readOnly
      );
    case "close-track-loop":
      return (
        snapshot.mode === "track" &&
        !snapshot.readOnly &&
        snapshot.track?.held === null &&
        snapshot.track.loops.closures.length > 0
      );
    case "delete":
      if (snapshot.mode === "measure") return snapshot.rulers > 0 || snapshot.rulerDraft;
      if (snapshot.mode === "table") return snapshot.hoveredTable !== null;
      return snapshot.selection !== null && snapshot.gesture === null && !snapshot.readOnly;
    case "duplicate":
      return snapshot.selection?.members.length === 1 && !snapshot.readOnly;
    case "pick-slot":
      return !snapshot.readOnly;
    case "copy":
      return snapshot.selection?.movable === true;
    case "paste":
      return (
        snapshot.clipboard > 0 &&
        snapshot.mode === "select" &&
        snapshot.gesture === null &&
        !snapshot.readOnly
      );
    case "nudge-left":
    case "nudge-right":
    case "nudge-forward":
    case "nudge-back":
      return (
        snapshot.selection?.movable === true &&
        snapshot.mode === "select" &&
        snapshot.gesture === null &&
        !snapshot.readOnly
      );
    case "focus":
      return snapshot.selection !== null;
    case "undo":
      return snapshot.history.undo !== null && !snapshot.readOnly;
    case "redo":
      return snapshot.history.redo !== null && !snapshot.readOnly;
    case "draw-tables":
      return !snapshot.readOnly;
    case "centre":
      return snapshot.hover !== null;
    case "draw-track":
      return !snapshot.readOnly && snapshot.catalog.some((item) => item.id === TRACK_ITEM_ID);
    case "draw-road":
      return snapshot.roadKit !== null && !snapshot.readOnly;
    case "cycle-fill-grid":
      return snapshot.mode === "place" && !snapshot.readOnly;
    case "raise-track":
    case "raise-track-brick":
      return snapshot.mode === "track" && !snapshot.readOnly;
    case "lower-track":
    case "lower-track-brick":
      return (
        snapshot.mode === "track" &&
        !snapshot.readOnly &&
        (snapshot.track?.height.drawingPlates ?? 0) > 0
      );
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
    case "measure":
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
  const selected = editor.snapshot().selection?.primary;
  if (!selected) return;
  editor.chooseItem(selected.item);
  if (selected.kind === "track") return;
  const rot = selected.kind === "model" ? selected.rot : 0;
  const turns = (rot - editor.snapshot().ghostRot + QUARTER_TURNS) % QUARTER_TURNS;
  const direction = turns > QUARTER_TURNS / 2 ? -1 : 1;
  const presses = direction === 1 ? turns : QUARTER_TURNS - turns;
  for (let press = 0; press < presses; press++) editor.rotate(eventTimeMs, direction);
}

function studStep({ x, z }: GroundDirection): { readonly dx: number; readonly dz: number } {
  return Math.abs(x) >= Math.abs(z)
    ? { dx: Math.sign(x) * STUD_LDU + 0, dz: 0 }
    : { dx: 0, dz: Math.sign(z) * STUD_LDU + 0 };
}

function nudge(editor: IEditor, camera: IEditorCamera, id: NudgeId, eventTimeMs: number): void {
  const [rightPx, downPx] = NUDGE_SCREEN[id];
  const { dx, dz } = studStep(camera.groundDirection(rightPx, downPx));
  editor.moveSelectionBy(dx, dz, eventTimeMs);
}

export function runEditorAction(
  editor: IEditor,
  camera: IEditorCamera,
  id: EditorActionId,
  eventTimeMs: number,
): void {
  switch (id) {
    case "cancel":
      editor.cancelGesture();
      return;
    case "select-tool":
      if (editor.dropTrackEnd()) return;
      editor.chooseItem(editor.snapshot().track?.held ? TRACK_ITEM_ID : null);
      return;
    case "draw-track": {
      const snapshot = editor.snapshot();
      const tool = snapshot.trackTools.find((candidate) => candidate.active)?.item;
      editor.chooseItem(snapshot.mode === "track" ? null : (tool ?? TRACK_ITEM_ID));
      return;
    }
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
    case "extend-straight":
      editor.extendTrack("straight", eventTimeMs);
      return;
    case "extend-left":
      editor.extendTrack("left", eventTimeMs);
      return;
    case "extend-right":
      editor.extendTrack("right", eventTimeMs);
      return;
    case "extend-preview":
      editor.extendTrack(null, eventTimeMs);
      return;
    case "next-track-choice":
      editor.cycleTrackChoice(1);
      return;
    case "previous-track-choice":
      editor.cycleTrackChoice(-1);
      return;
    case "close-track-loop":
      editor.closeTrackLoop(null, eventTimeMs);
      return;
    case "raise-track":
      editor.raiseTrack(1);
      return;
    case "lower-track":
      editor.raiseTrack(-1);
      return;
    case "raise-track-brick":
      editor.raiseTrack(PLATES_PER_BRICK);
      return;
    case "lower-track-brick":
      editor.raiseTrack(-PLATES_PER_BRICK);
      return;
    case "delete":
      editor.deleteSelection(eventTimeMs);
      return;
    case "duplicate":
      placeMoreLikeSelection(editor, eventTimeMs);
      return;
    case "copy":
      editor.copySelection();
      return;
    case "paste":
      editor.pasteClipboard();
      return;
    case "nudge-left":
    case "nudge-right":
    case "nudge-forward":
    case "nudge-back":
      nudge(editor, camera, id, eventTimeMs);
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
    case "measure":
      editor.setMeasuring(editor.snapshot().mode !== "measure");
      return;
    case "draw-tables":
      editor.setTableTool(editor.snapshot().mode !== "table");
      return;
    case "cycle-fill-grid":
      editor.cycleFillGrid();
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
    case "toggle-placement-mode":
      togglePlacementMode(editor);
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
  if (editor.snapshot().studChecks > 0) return;
  editor.chooseItem(null);
  void play.start();
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

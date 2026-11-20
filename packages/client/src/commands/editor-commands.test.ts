import { describe, expect, it } from "vitest";
import type { PlaySnapshot } from "../play/train-play.ts";
import {
  COMMANDS,
  commandForKey,
  commandsForKey,
  playCommandEnabled,
  runsDuringPlay,
  type CommandId,
  type PlayCommandId,
} from "./editor-commands.ts";
import { chordText, type KeyInput } from "./key-chord.ts";

function press(key: string, held: Partial<Omit<KeyInput, "key">> = {}): KeyInput {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...held };
}

const anyEnabled = (): boolean => true;
const noneEnabled = (): boolean => false;
const panOnly = (id: CommandId): boolean => id === "pan-left";

describe("shortcut map", () => {
  it("shares a chord only between a command that acts on a selection or a drag and the one it falls back to", () => {
    const shared = new Map<string, ReadonlyArray<CommandId>>();
    for (const spec of COMMANDS) {
      for (const chord of spec.keys) {
        const input = press(chord.key, {
          ctrlKey: chord.mod ?? false,
          shiftKey: chord.shift ?? false,
          altKey: chord.alt ?? false,
        });
        const bound = commandsForKey(input, false).map((match) => match.id);
        expect(bound).toContain(spec.id);
        if (bound.length > 1) shared.set(chordText(chord, "other"), bound);
      }
    }

    expect(Object.fromEntries(shared)).toEqual({
      Esc: ["cancel", "select-tool"],
      "←": ["nudge-left", "pan-left"],
      "→": ["nudge-right", "pan-right"],
      "↑": ["nudge-forward", "pan-forward"],
      "↓": ["nudge-back", "pan-back"],
    });
  });

  it("routes a shared chord to the first command that would act, and to the first bound when none would", () => {
    expect([
      commandForKey(press("ArrowLeft"), false, anyEnabled),
      commandForKey(press("ArrowLeft"), false, panOnly),
      commandForKey(press("ArrowLeft"), false, noneEnabled),
    ]).toEqual([{ id: "nudge-left" }, { id: "pan-left" }, { id: "nudge-left" }]);
  });

  it.each<[string, KeyInput, CommandId | null]>([
    ["Cmd+Shift+Z as macOS reports it", press("z", { metaKey: true, shiftKey: true }), "redo"],
    ["Ctrl+Shift+Z with the letter shifted", press("Z", { ctrlKey: true, shiftKey: true }), "redo"],
    ["Ctrl+Z", press("z", { ctrlKey: true }), "undo"],
    ["Cmd+Z", press("z", { metaKey: true }), "undo"],
    ["? typed with Shift", press("?", { shiftKey: true }), "show-shortcuts"],
    ["+ typed with Shift", press("+", { shiftKey: true }), "zoom-in"],
    ["R with Caps Lock", press("R"), "rotate"],
    ["Shift+R", press("R", { shiftKey: true }), "rotate-back"],
    ["Ctrl+R stays the browser's reload", press("r", { ctrlKey: true }), null],
    ["Ctrl+C", press("c", { ctrlKey: true }), "copy"],
    ["C alone", press("c"), "centre"],
    ["Cmd+V", press("v", { metaKey: true }), "paste"],
    ["Alt+T", press("t", { altKey: true }), null],
    ["Arrow", press("ArrowLeft"), "nudge-left"],
    ["Shift+Arrow", press("ArrowLeft", { shiftKey: true }), "orbit-left"],
    ["P", press("p"), "toggle-plan-view"],
    ["a digit", press("7"), "pick-slot"],
  ])("maps %s", (_, input, expected) => {
    expect(commandForKey(input, false, anyEnabled)?.id ?? null).toBe(expected);
  });

  it("tells the hotbar which slot a digit picks, and carries no slot for any other command", () => {
    expect(commandForKey(press("1"), false, anyEnabled)).toEqual({ id: "pick-slot", slot: 0 });
    expect(commandForKey(press("9"), false, anyEnabled)).toEqual({ id: "pick-slot", slot: 8 });
    expect(commandForKey(press("z", { ctrlKey: true }), false, anyEnabled)).toEqual({
      id: "undo",
    });
  });

  it("leaves keys alone while the user types in a field", () => {
    expect(commandForKey(press("r"), true, anyEnabled)).toBeNull();
    expect(commandForKey(press("3"), true, anyEnabled)).toBeNull();
    expect(commandForKey(press("Backspace"), true, anyEnabled)).toBeNull();
    expect(commandForKey(press("z", { ctrlKey: true }), true, anyEnabled)).toBeNull();
    expect(commandForKey(press("/"), true, anyEnabled)).toBeNull();
  });

  it("still opens and closes the palette with Cmd+K or Ctrl+K from a field", () => {
    expect(commandForKey(press("k", { metaKey: true }), true, anyEnabled)?.id).toBe("open-palette");
    expect(commandForKey(press("k", { ctrlKey: true }), true, anyEnabled)?.id).toBe("open-palette");
  });

  it.each([
    [{ key: "z", mod: true, shift: true }, "⌘⇧Z", "Ctrl+Shift+Z"],
    [{ key: "Escape" }, "Esc", "Esc"],
    [{ key: "?" }, "?", "?"],
    [{ key: "ArrowUp", shift: true }, "⇧↑", "Shift+↑"],
  ])("labels %o per platform", (chord, mac, other) => {
    expect(chordText(chord, "mac")).toBe(mac);
    expect(chordText(chord, "other")).toBe(other);
  });
});

const MAX_LDU_PER_S = 400;

function play(patch: Partial<PlaySnapshot>): PlaySnapshot {
  return {
    status: "running",
    error: null,
    notice: null,
    trains: [],
    driven: 0,
    vehicles: 1,
    trainLengthLdu: 0,
    maxSpeedLduPerS: MAX_LDU_PER_S,
    targetLduPerS: 0,
    speedLduPerS: 0,
    direction: 1,
    derailSpeedLduPerS: 0,
    bogiesOffTrack: 0,
    trainXLdu: 0,
    trainZLdu: 0,
    switches: [],
    following: true,
    tick: 0,
    ...patch,
  };
}

const PLAY_COMMANDS: ReadonlyArray<PlayCommandId> = [
  "play",
  "throttle-up",
  "throttle-down",
  "stop-train",
  "rerail",
];

describe("play commands", () => {
  it.each<[string, PlaySnapshot, ReadonlyArray<PlayCommandId>]>([
    ["idle", play({ status: "idle" }), ["play"]],
    ["loading the train", play({ status: "loading" }), []],
    ["running, stopped", play({}), ["play", "throttle-up", "throttle-down"]],
    [
      "running forward",
      play({ targetLduPerS: 200, speedLduPerS: 150 }),
      ["play", "throttle-up", "throttle-down", "stop-train"],
    ],
    [
      "at full throttle forward",
      play({ targetLduPerS: MAX_LDU_PER_S, speedLduPerS: MAX_LDU_PER_S }),
      ["play", "throttle-down", "stop-train"],
    ],
    [
      "at full throttle backward",
      play({ targetLduPerS: -MAX_LDU_PER_S, speedLduPerS: MAX_LDU_PER_S }),
      ["play", "throttle-up", "stop-train"],
    ],
    ["derailed", play({ derailSpeedLduPerS: 400 }), ["play", "rerail"]],
  ])("enables only the ones that would act while %s", (_, snapshot, enabled) => {
    expect(PLAY_COMMANDS.filter((id) => playCommandEnabled(id, snapshot))).toEqual(enabled);
  });

  it("leaves only camera, play and shell commands live while a train runs", () => {
    expect(COMMANDS.map((spec) => spec.id).filter((id) => !runsDuringPlay(id))).toEqual([
      "cancel",
      "pick-slot",
      "draw-track",
      "draw-road",
      "measure",
      "draw-tables",
      "cycle-fill-grid",
      "rotate",
      "rotate-back",
      "flip-switch",
      "next-connector",
      "extend-straight",
      "extend-left",
      "extend-right",
      "extend-preview",
      "next-track-choice",
      "previous-track-choice",
      "delete",
      "duplicate",
      "copy",
      "paste",
      "undo",
      "redo",
      "nudge-left",
      "nudge-right",
      "nudge-forward",
      "nudge-back",
      "toggle-road-snap",
      "toggle-placement-mode",
    ]);
  });
});

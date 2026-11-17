import { describe, expect, it } from "vitest";
import { COMMANDS, commandForKey, type CommandId } from "./editor-commands.ts";
import { chordText, type KeyInput } from "./key-chord.ts";

function press(key: string, held: Partial<Omit<KeyInput, "key">> = {}): KeyInput {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...held };
}

describe("shortcut map", () => {
  it("gives every chord to exactly one command", () => {
    for (const spec of COMMANDS) {
      for (const chord of spec.keys) {
        const input = press(chord.key, {
          ctrlKey: chord.mod ?? false,
          shiftKey: chord.shift ?? false,
          altKey: chord.alt ?? false,
        });
        expect([chordText(chord, "other"), commandForKey(input, false)]).toEqual([
          chordText(chord, "other"),
          spec.id,
        ]);
      }
    }
  });

  it.each<[string, KeyInput, CommandId | null]>([
    ["Cmd+Shift+Z as macOS reports it", press("z", { metaKey: true, shiftKey: true }), "redo"],
    ["Ctrl+Shift+Z with the letter shifted", press("Z", { ctrlKey: true, shiftKey: true }), "redo"],
    ["Ctrl+Z", press("z", { ctrlKey: true }), "undo"],
    ["Cmd+Z", press("z", { metaKey: true }), "undo"],
    ["? typed with Shift", press("?", { shiftKey: true }), "show-shortcuts"],
    ["+ typed with Shift", press("+", { shiftKey: true }), "zoom-in"],
    ["R with Caps Lock", press("R"), "rotate"],
    ["Shift+R", press("R", { shiftKey: true }), null],
    ["Ctrl+R stays the browser's reload", press("r", { ctrlKey: true }), null],
    ["Alt+T", press("t", { altKey: true }), null],
    ["Arrow", press("ArrowLeft"), "pan-left"],
    ["Shift+Arrow", press("ArrowLeft", { shiftKey: true }), "orbit-left"],
  ])("maps %s", (_, input, expected) => {
    expect(commandForKey(input, false)).toBe(expected);
  });

  it("leaves keys alone while the user types in a field", () => {
    expect(commandForKey(press("r"), true)).toBeNull();
    expect(commandForKey(press("Backspace"), true)).toBeNull();
    expect(commandForKey(press("z", { ctrlKey: true }), true)).toBeNull();
    expect(commandForKey(press("/"), true)).toBeNull();
  });

  it("still opens and closes the palette with Cmd+K or Ctrl+K from a field", () => {
    expect(commandForKey(press("k", { metaKey: true }), true)).toBe("open-palette");
    expect(commandForKey(press("k", { ctrlKey: true }), true)).toBe("open-palette");
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

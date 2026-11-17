import { describe, expect, it } from "vitest";
import { COMMANDS, commandForKey, routeKey, type CommandId } from "./editor-commands.ts";
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
          { id: spec.id, chord: spec.keys.indexOf(chord) },
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
    ["a digit", press("7"), "pick-slot"],
  ])("maps %s", (_, input, expected) => {
    expect(commandForKey(input, false)?.id ?? null).toBe(expected);
  });

  it("leaves keys alone while the user types in a field", () => {
    expect(commandForKey(press("r"), true)).toBeNull();
    expect(commandForKey(press("3"), true)).toBeNull();
    expect(commandForKey(press("Backspace"), true)).toBeNull();
    expect(commandForKey(press("z", { ctrlKey: true }), true)).toBeNull();
    expect(commandForKey(press("/"), true)).toBeNull();
  });

  it("still opens and closes the palette with Cmd+K or Ctrl+K from a field", () => {
    expect(commandForKey(press("k", { metaKey: true }), true)?.id).toBe("open-palette");
    expect(commandForKey(press("k", { ctrlKey: true }), true)?.id).toBe("open-palette");
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

describe("key routing", () => {
  const everyChord = COMMANDS.flatMap((spec) =>
    spec.keys.map((_, chord) => ({ id: spec.id, chord })),
  );

  it("reaches neither the editor nor the hotbar while an overlay is open", () => {
    const reached = everyChord
      .filter((match) => {
        const { kind } = routeKey(match, true);
        return kind === "editor" || kind === "slot";
      })
      .map((match) => `${match.id}#${match.chord}`);
    expect(reached).toEqual([]);
  });

  it("still toggles overlays and closes them with Esc while one is open", () => {
    expect(routeKey({ id: "show-shortcuts", chord: 0 }, true).kind).toBe("overlay");
    expect(routeKey({ id: "open-palette", chord: 0 }, true).kind).toBe("overlay");
    expect(routeKey({ id: "select-tool", chord: 0 }, true).kind).toBe("close-overlay");
  });

  it("sends a digit to its hotbar slot only when no overlay is open", () => {
    const digit = commandForKey(press("3"), false);
    expect(digit && routeKey(digit, false)).toEqual({ kind: "slot", slot: 2 });
    expect(digit && routeKey(digit, true)).toEqual({ kind: "blocked" });
  });
});

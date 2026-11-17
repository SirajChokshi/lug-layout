export type KeyPlatform = "mac" | "other";

export interface KeyChord {
  readonly key: string;
  readonly mod?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
}

export interface KeyInput {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

const LETTER = /^[a-z]$/u;

const KEY_NAMES: Readonly<Record<string, string>> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Escape: "Esc",
  Delete: "Del",
  Backspace: "⌫",
  Enter: "Enter",
  " ": "Space",
};

const MODIFIER_NAMES: Readonly<Record<KeyPlatform, readonly [string, string, string]>> = {
  mac: ["⌘", "⇧", "⌥"],
  other: ["Ctrl", "Shift", "Alt"],
};

function normalKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

function shiftCounts(key: string): boolean {
  return key.length > 1 || LETTER.test(key);
}

export function chordMatches(chord: KeyChord, input: KeyInput): boolean {
  const key = normalKey(input.key);
  if (key !== chord.key) return false;
  if ((input.ctrlKey || input.metaKey) !== (chord.mod ?? false)) return false;
  if (input.altKey !== (chord.alt ?? false)) return false;
  return !shiftCounts(key) || input.shiftKey === (chord.shift ?? false);
}

export function chordKeys(chord: KeyChord, platform: KeyPlatform): ReadonlyArray<string> {
  const [mod, shift, alt] = MODIFIER_NAMES[platform];
  const keys: string[] = [];
  if (chord.mod) keys.push(mod);
  if (chord.alt) keys.push(alt);
  if (chord.shift) keys.push(shift);
  keys.push(KEY_NAMES[chord.key] ?? chord.key.toUpperCase());
  return keys;
}

export function chordText(chord: KeyChord, platform: KeyPlatform): string {
  return chordKeys(chord, platform).join(platform === "mac" ? "" : "+");
}

export function keyPlatform(userAgent: string): KeyPlatform {
  return /Mac|iPhone|iPad/u.test(userAgent) ? "mac" : "other";
}

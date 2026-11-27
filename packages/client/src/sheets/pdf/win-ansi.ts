const FIRST_PRINTABLE = 0x20;
const DELETE = 0x7f;
const LAST_BYTE = 0xff;
const C1_FIRST = 0x80;
const C1_LAST = 0x9f;
const QUESTION_MARK = 0x3f;

function windows1252(): ReadonlyMap<number, number> {
  const decoder = new TextDecoder("windows-1252");
  const table = new Map<number, number>();
  for (let byte = FIRST_PRINTABLE; byte <= LAST_BYTE; byte++) {
    if (byte === DELETE) continue;
    const code = decoder.decode(Uint8Array.of(byte)).codePointAt(0) ?? 0;
    if (code >= C1_FIRST && code <= C1_LAST) continue;
    table.set(code, byte);
  }
  return table;
}

const WIN_ANSI = windows1252();

export interface WinAnsiText {
  readonly bytes: ReadonlyArray<number>;
  readonly missing: ReadonlyArray<string>;
}

export function winAnsi(text: string): WinAnsiText {
  const bytes: number[] = [];
  const missing: string[] = [];
  for (const character of text) {
    const byte = WIN_ANSI.get(character.codePointAt(0) ?? 0);
    if (byte === undefined) {
      missing.push(character);
      bytes.push(QUESTION_MARK);
    } else {
      bytes.push(byte);
    }
  }
  return { bytes, missing };
}

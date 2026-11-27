import { STUD_LDU, isRot90, rot90Cos, rot90Sin } from "@brr/math";
import type { TextNoteV2 } from "@brr/schema/world";

export const TEXT_LINE_HEIGHT_EM = 1.2;
const TEXT_ADVANCE_EM = 0.6;

export interface TextAxes {
  alongX: number;
  alongZ: number;
  upX: number;
  upZ: number;
}

export function writeTextAxes(rot: number, out: TextAxes): TextAxes {
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  out.alongX = cos;
  out.alongZ = -sin + 0;
  out.upX = -sin + 0;
  out.upZ = -cos + 0;
  return out;
}

export function textAxes(rot: number): TextAxes {
  return writeTextAxes(rot, { alongX: 0, alongZ: 0, upX: 0, upZ: 0 });
}

export function textLines(text: string): ReadonlyArray<string> {
  return text.split("\n");
}

export function textHeightLdu(note: Pick<TextNoteV2, "heightStuds">): number {
  return note.heightStuds * STUD_LDU;
}

function halfExtents(note: TextNoteV2): { readonly along: number; readonly across: number } {
  const lines = textLines(note.text);
  const longest = Math.max(...lines.map((line) => line.length));
  const height = textHeightLdu(note);
  return {
    along: (longest * TEXT_ADVANCE_EM * height) / 2,
    across: (lines.length * TEXT_LINE_HEIGHT_EM * height) / 2,
  };
}

export function textContains(note: TextNoteV2, x: number, z: number, margin: number): boolean {
  const axes = textAxes(note.rot);
  const dx = x - note.x;
  const dz = z - note.z;
  const along = dx * axes.alongX + dz * axes.alongZ;
  const across = dx * axes.upX + dz * axes.upZ;
  const half = halfExtents(note);
  return Math.abs(along) <= half.along + margin && Math.abs(across) <= half.across + margin;
}

export function textCorners(note: TextNoteV2): Float64Array {
  const axes = textAxes(note.rot);
  const half = halfExtents(note);
  const corners = new Float64Array(8);
  const signs = [
    [-1, 1],
    [1, 1],
    [1, -1],
    [-1, -1],
  ] as const;
  signs.forEach(([along, across], i) => {
    corners[i * 2] = note.x + along * half.along * axes.alongX + across * half.across * axes.upX;
    corners[i * 2 + 1] =
      note.z + along * half.along * axes.alongZ + across * half.across * axes.upZ;
  });
  return corners;
}

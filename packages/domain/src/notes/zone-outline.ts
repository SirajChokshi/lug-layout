import type { StudPoint } from "@brr/schema/world";
import type { NotePoint } from "./note-state.ts";

export type ZoneOutline = ReadonlyArray<Readonly<StudPoint>>;

export function studRect(a: NotePoint, b: NotePoint): StudPoint[] | null {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minZ = Math.min(a.z, b.z);
  const maxZ = Math.max(a.z, b.z);
  if (minX === maxX || minZ === maxZ) return null;
  return [
    [minX, minZ],
    [maxX, minZ],
    [maxX, maxZ],
    [minX, maxZ],
  ];
}

export function zoneContains(outline: ZoneOutline, x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const a = outline[i];
    const b = outline[j];
    if (!a || !b) continue;
    const [ax, az] = a;
    const [bx, bz] = b;
    if (az > z !== bz > z && x < ((bx - ax) * (z - az)) / (bz - az) + ax) inside = !inside;
  }
  return inside;
}

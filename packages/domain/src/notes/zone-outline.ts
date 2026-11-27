import { planeHypot } from "@brr/math";
import type { StudPoint } from "@brr/schema/world";
import type { NotePoint } from "./note-state.ts";

export type ZoneOutline = ReadonlyArray<Readonly<StudPoint>>;

export const NO_CORNER = -1;

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

export function shiftedOutline(outline: ZoneOutline, dx: number, dz: number): StudPoint[] {
  return outline.map(([x, z]) => [x + dx + 0, z + dz + 0]);
}

export function withCornerAt(outline: ZoneOutline, index: number, point: NotePoint): StudPoint[] {
  return outline.map((corner, i) => (i === index ? [point.x, point.z] : [corner[0], corner[1]]));
}

export function nearestCorner(outline: ZoneOutline, x: number, z: number, reach: number): number {
  let best = NO_CORNER;
  let bestDistance = reach;
  for (let i = 0; i < outline.length; i++) {
    const corner = outline[i];
    if (!corner) continue;
    const distance = planeHypot(corner[0] - x, corner[1] - z);
    if (distance <= bestDistance) {
      best = i;
      bestDistance = distance;
    }
  }
  return best;
}

export function outlineCentroid(outline: ZoneOutline): NotePoint {
  let twiceArea = 0;
  let sumX = 0;
  let sumZ = 0;
  for (let i = 0; i < outline.length; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % outline.length];
    if (!a || !b) continue;
    const cross = a[0] * b[1] - b[0] * a[1];
    twiceArea += cross;
    sumX += (a[0] + b[0]) * cross;
    sumZ += (a[1] + b[1]) * cross;
  }
  return { x: sumX / (3 * twiceArea), z: sumZ / (3 * twiceArea) };
}

export function segmentDistance(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  x: number,
  z: number,
): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lengthSquared = dx * dx + dz * dz;
  const along =
    lengthSquared === 0
      ? 0
      : Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / lengthSquared));
  return planeHypot(ax + along * dx - x, az + along * dz - z);
}

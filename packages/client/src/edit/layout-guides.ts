import { CHUNK_STUDS, MM_PER_STUD, STUD_LDU } from "@brr/math";
import type { WorldBox } from "@brr/render";

const MID_GRID_STUDS = 8;
export const GRID_STEPS_STUDS: ReadonlyArray<number> = [1, MID_GRID_STUDS, CHUNK_STUDS];
export const GRID_STEPS_LDU: ReadonlyArray<number> = GRID_STEPS_STUDS.map(
  (studs) => studs * STUD_LDU,
);

const MM_PER_CM = 10;
const TENTHS = 10;
const SCALE_BAR_GROWTH = 2;

export type LabelKind = "ruler" | "draft" | "ghost" | "selection";

export interface LabelView {
  readonly id: string;
  readonly kind: LabelKind;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

function tenths(value: number): string {
  const rounded = Math.round(value * TENTHS) / TENTHS;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function studsText(ldu: number): string {
  return tenths(ldu / STUD_LDU);
}

export function cmText(ldu: number): string {
  return tenths(((ldu / STUD_LDU) * MM_PER_STUD) / MM_PER_CM);
}

export function lengthText(ldu: number): string {
  const studs = studsText(ldu);
  return `${studs} ${studs === "1" ? "stud" : "studs"} · ${cmText(ldu)} cm`;
}

export function areaText(widthLdu: number, depthLdu: number): string {
  return `${studsText(widthLdu)} × ${studsText(depthLdu)} studs · ${cmText(widthLdu)} × ${cmText(depthLdu)} cm`;
}

export function boxLabel(id: string, kind: LabelKind, box: WorldBox): LabelView {
  return {
    id,
    kind,
    text: areaText(box.maxX - box.minX, box.maxZ - box.minZ),
    x: (box.minX + box.maxX) / 2,
    y: box.maxY,
    z: (box.minZ + box.maxZ) / 2,
  };
}

export function scaleBarStuds(pixelsPerLdu: number, maxWidthPx: number): number {
  if (!(pixelsPerLdu > 0) || !Number.isFinite(pixelsPerLdu)) {
    throw new Error(`scale ${pixelsPerLdu} px per LDU is not a positive finite number`);
  }
  let studs = 1;
  while (studs * SCALE_BAR_GROWTH * STUD_LDU * pixelsPerLdu <= maxWidthPx) {
    studs *= SCALE_BAR_GROWTH;
  }
  return studs;
}

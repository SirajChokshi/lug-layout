import { MM_PER_STUD, STUD_LDU } from "@brr/math";
import type { WorldBox } from "@brr/render";

export const MM_PER_CM = 10;
const TENTHS = 10;

export type LabelKind = "ruler" | "draft" | "ghost" | "selection" | "table";

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

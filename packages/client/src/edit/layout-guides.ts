import {
  CHUNK_LDU,
  CHUNK_STUDS,
  STUD_LDU,
  isRot90,
  mmFromLdu,
  rot90Cos,
  rot90Sin,
} from "@brr/math";
import type { GridArea, GroundGrid, GuideSegment, GuideKind, WorldBox } from "@brr/render";
import type { LocalBox } from "./local-box.ts";

export const GUIDE_GRID_STUDS = 8;
export const GUIDE_GRID_LDU = GUIDE_GRID_STUDS * STUD_LDU;
export const GRID_STEPS_STUDS: ReadonlyArray<number> = [1, GUIDE_GRID_STUDS, CHUNK_STUDS];

const GRID_LIFT_LDU = 0.5;
const MM_PER_CM = 10;
const TICK_HALF_LDU = STUD_LDU / 2;

export function groundGrid(tableY: number, areas: ReadonlyArray<GridArea> | null): GroundGrid {
  return {
    y: tableY + GRID_LIFT_LDU,
    areas,
    levels: [
      { stepLdu: STUD_LDU, halfSteps: 48, color: 0x7d8f9c, opacity: 0.5, minPitchPx: 7 },
      { stepLdu: GUIDE_GRID_LDU, halfSteps: 40, color: 0x4f6270, opacity: 0.6, minPitchPx: 9 },
      { stepLdu: CHUNK_LDU, halfSteps: 40, color: 0x22323d, opacity: 0.85, minPitchPx: 9 },
    ],
  };
}

export type LabelKind = "ruler" | "draft" | "ghost" | "selection" | "table";

export interface LabelView {
  readonly id: string;
  readonly kind: LabelKind;
  readonly text: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Ruler {
  readonly ax: number;
  readonly az: number;
  readonly bx: number;
  readonly bz: number;
}

function tenths(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

export function studsOf(ldu: number): string {
  return tenths(ldu / STUD_LDU);
}

export function cmOf(ldu: number): string {
  return tenths(mmFromLdu(ldu) / MM_PER_CM);
}

export function lengthText(ldu: number): string {
  const studs = studsOf(ldu);
  return `${studs} ${studs === "1" ? "stud" : "studs"} · ${cmOf(ldu)} cm`;
}

export function areaText(widthLdu: number, depthLdu: number): string {
  return `${studsOf(widthLdu)} × ${studsOf(depthLdu)} studs · ${cmOf(widthLdu)} × ${cmOf(depthLdu)} cm`;
}

export function rulerLength(ruler: Ruler): number {
  return Math.hypot(ruler.bx - ruler.ax, ruler.bz - ruler.az);
}

export function rulerText(ruler: Ruler): string {
  const dx = Math.abs(ruler.bx - ruler.ax);
  const dz = Math.abs(ruler.bz - ruler.az);
  if (dx === 0 || dz === 0) return lengthText(dx + dz);
  return `${lengthText(rulerLength(ruler))} (${studsOf(dx)} × ${studsOf(dz)})`;
}

export function rulerGuides(ruler: Ruler, y: number, kind: GuideKind): GuideSegment[] {
  const { ax, az, bx, bz } = ruler;
  const length = rulerLength(ruler);
  if (length === 0) return [];
  const nx = (-(bz - az) / length) * TICK_HALF_LDU;
  const nz = ((bx - ax) / length) * TICK_HALF_LDU;
  const segments: GuideSegment[] = [
    { kind, ax, ay: y, az, bx, by: y, bz },
    { kind, ax: ax - nx, ay: y, az: az - nz, bx: ax + nx, by: y, bz: az + nz },
    { kind, ax: bx - nx, ay: y, az: bz - nz, bx: bx + nx, by: y, bz: bz + nz },
  ];
  if (ax !== bx && az !== bz) {
    segments.push(
      { kind: "dimension", ax, ay: y, az, bx, by: y, bz: az },
      { kind: "dimension", ax: bx, ay: y, az, bx, by: y, bz },
    );
  }
  return segments;
}

export function rulerLabel(id: string, kind: LabelKind, ruler: Ruler, y: number): LabelView {
  return {
    id,
    kind,
    text: rulerText(ruler),
    x: (ruler.ax + ruler.bx) / 2,
    y,
    z: (ruler.az + ruler.bz) / 2,
  };
}

export function placedBox(
  box: LocalBox,
  x: number,
  z: number,
  yLdu: number,
  rot: number,
): WorldBox {
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const ax = x + cos * box.min[0] + sin * box.min[2];
  const az = z - sin * box.min[0] + cos * box.min[2];
  const bx = x + cos * box.max[0] + sin * box.max[2];
  const bz = z - sin * box.max[0] + cos * box.max[2];
  return {
    minX: Math.min(ax, bx),
    minY: yLdu + box.min[1],
    minZ: Math.min(az, bz),
    maxX: Math.max(ax, bx),
    maxY: yLdu + box.max[1],
    maxZ: Math.max(az, bz),
  };
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

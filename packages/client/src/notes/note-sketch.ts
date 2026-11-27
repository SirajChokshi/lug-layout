import type { NoteSpan, ZoneOutline } from "@brr/domain";
import { STUD_LDU, planeHypot } from "@brr/math";
import type { NoteArea, NotePath, NoteShapes } from "@brr/render";
import type { LabelKind, LabelView } from "../edit/size-labels.ts";

const TICK_HALF_LDU = STUD_LDU / 2;
const HEX_RADIX = 16;
const HEX_DIGITS_FROM = 1;

export const SELECTED_RGB = 0x1f62d1;
export const DRAFT_RGB = 0x2f74e8;

export interface PlanRect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export function rgbOf(color: string): number {
  return Number.parseInt(color.slice(HEX_DIGITS_FROM), HEX_RADIX);
}

function outlinePoints(outline: ZoneOutline): Float64Array {
  const points = new Float64Array(outline.length * 2);
  outline.forEach(([x, z], i) => {
    points[i * 2] = x;
    points[i * 2 + 1] = z;
  });
  return points;
}

export class NoteSketch {
  readonly areas: NoteArea[] = [];
  readonly paths: NotePath[] = [];
  readonly labels: LabelView[] = [];

  constructor(readonly y: number) {}

  zone(outline: ZoneOutline, rgb: number): void {
    const points = outlinePoints(outline);
    this.areas.push({ outline: points, rgb });
    this.paths.push({ points, closed: true, rgb });
  }

  outline(outline: ZoneOutline, closed: boolean, rgb: number): void {
    this.paths.push({ points: outlinePoints(outline), closed, rgb });
  }

  line(ax: number, az: number, bx: number, bz: number, rgb: number): void {
    this.paths.push({ points: Float64Array.of(ax, az, bx, bz), closed: false, rgb });
  }

  ruler(span: NoteSpan, rgb: number): void {
    const { ax, az, bx, bz } = span;
    this.line(ax, az, bx, bz, rgb);
    const length = planeHypot(bx - ax, bz - az);
    if (length === 0) return;
    const nx = (-(bz - az) / length) * TICK_HALF_LDU;
    const nz = ((bx - ax) / length) * TICK_HALF_LDU;
    this.line(ax - nx, az - nz, ax + nx, az + nz, rgb);
    this.line(bx - nx, bz - nz, bx + nx, bz + nz, rgb);
  }

  square(x: number, z: number, half: number, rgb: number): void {
    this.rect({ minX: x - half, minZ: z - half, maxX: x + half, maxZ: z + half }, rgb);
  }

  rect(rect: PlanRect, rgb: number): void {
    const { minX, minZ, maxX, maxZ } = rect;
    this.paths.push({
      points: Float64Array.of(minX, minZ, maxX, minZ, maxX, maxZ, minX, maxZ),
      closed: true,
      rgb,
    });
  }

  frame(corners: Float64Array, rgb: number): void {
    this.paths.push({ points: corners, closed: true, rgb });
  }

  label(id: string, kind: LabelKind, text: string, x: number, z: number): void {
    this.labels.push({ id, kind, text, x, y: this.y, z });
  }

  shapes(): NoteShapes {
    return { y: this.y, areas: this.areas, paths: this.paths };
  }
}

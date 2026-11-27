import type { NoteSpan, ZoneOutline } from "@brr/domain";
import type { NoteArea, NotePath, NoteShapes, WorldBox } from "@brr/render";
import { rulerTicks } from "../edit/measure-tool.ts";
import type { LabelKind, LabelView } from "../edit/size-labels.ts";

const HEX_RADIX = 16;

export const SELECTED_RGB = 0x1f62d1;
export const DRAFT_RGB = 0x2f74e8;

export function rgbOf(color: string): number {
  return Number.parseInt(color.slice(1), HEX_RADIX);
}

function outlinePoints(outline: ZoneOutline): Float64Array {
  return Float64Array.from(outline.flat());
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

  line({ ax, az, bx, bz }: NoteSpan, rgb: number): void {
    this.paths.push({ points: Float64Array.of(ax, az, bx, bz), closed: false, rgb });
  }

  ruler(span: NoteSpan, rgb: number): void {
    this.line(span, rgb);
    for (const tick of rulerTicks(span) ?? []) this.line(tick, rgb);
  }

  square(x: number, z: number, half: number, rgb: number): void {
    this.rect({ minX: x - half, minZ: z - half, maxX: x + half, maxZ: z + half }, rgb);
  }

  rect({ minX, minZ, maxX, maxZ }: Pick<WorldBox, "minX" | "minZ" | "maxX" | "maxZ">, rgb: number) {
    const points = Float64Array.of(minX, minZ, maxX, minZ, maxX, maxZ, minX, maxZ);
    this.paths.push({ points, closed: true, rgb });
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

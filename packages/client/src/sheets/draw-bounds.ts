import {
  boxesOverlap,
  composed,
  IDENTITY,
  type Box,
  type DrawItem,
  type Point,
  type Similarity,
  type TextItem,
} from "./draw-list.ts";
import type { ISheetTypeface } from "./sheet-typeface.ts";

const HALO_MM = 0.4;

function pointsBox(points: ReadonlyArray<Point>, marginMm: number): Box | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  if (!(minX <= maxX && minY <= maxY)) return null;
  return {
    x: minX - marginMm,
    y: minY - marginMm,
    width: maxX - minX + 2 * marginMm,
    height: maxY - minY + 2 * marginMm,
  };
}

function mapped(box: Box, transform: Similarity): Box {
  return {
    x: box.x * transform.scale + transform.dx,
    y: box.y * transform.scale + transform.dy,
    width: box.width * transform.scale,
    height: box.height * transform.scale,
  };
}

export class DrawBounds {
  constructor(private readonly typeface: ISheetTypeface) {}

  boxOf(item: DrawItem, transform: Similarity = IDENTITY): Box | null {
    if (item.kind === "group") {
      const inner = composed(transform, item.transform);
      let box: Box | null = null;
      for (const child of item.items) box = union(box, this.boxOf(child, inner));
      if (box && item.clip) {
        const clip = mapped(item.clip, inner);
        return boxesOverlap(box, clip) ? intersection(box, clip) : null;
      }
      return box;
    }
    const local = this.localBox(item, transform.scale);
    return local ? mapped(local, transform) : null;
  }

  culled(items: ReadonlyArray<DrawItem>, transform: Similarity, window: Box): DrawItem[] {
    const kept: DrawItem[] = [];
    for (const item of items) {
      if (item.kind === "group") {
        const inner = composed(transform, item.transform);
        const children = this.culled(item.items, inner, window);
        if (children.length > 0) kept.push({ ...item, items: children });
        continue;
      }
      const box = this.boxOf(item, transform);
      if (box && boxesOverlap(box, window)) kept.push(item);
    }
    return kept;
  }

  private localBox(item: Exclude<DrawItem, { kind: "group" }>, scale: number): Box | null {
    switch (item.kind) {
      case "rect":
        return pointsBox(
          [
            [item.box.x, item.box.y],
            [item.box.x + item.box.width, item.box.y + item.box.height],
          ],
          item.paint.strokeMm / scale / 2,
        );
      case "path":
        return pointsBox(item.rings.flat(), item.paint.strokeMm / scale / 2);
      case "line":
        return pointsBox([item.from, item.to], item.paint.strokeMm / scale / 2);
      case "circle":
        return pointsBox(
          [
            [item.center[0] - item.radius, item.center[1] - item.radius],
            [item.center[0] + item.radius, item.center[1] + item.radius],
          ],
          item.paint.strokeMm / scale / 2,
        );
      case "text":
        return this.textBox(item, scale);
      default: {
        const unhandled: never = item;
        throw new Error(`unhandled draw item ${String(unhandled)}`);
      }
    }
  }

  private textBox(item: TextItem, scale: number): Box | null {
    const size = item.style.sizeMm / scale;
    const width = this.typeface.widthMm(item.text, size);
    const start =
      item.style.anchor === "start" ? 0 : item.style.anchor === "middle" ? -width / 2 : -width;
    const margin = (item.style.halo ? HALO_MM : 0) / scale;
    const [x, y] = item.at;
    const corners: Point[] =
      item.turn === "none"
        ? [
            [x + start, y - size],
            [x + start + width, y + size / 2],
          ]
        : [
            [x - size, y - start - width],
            [x + size / 2, y - start],
          ];
    return pointsBox(corners, margin);
  }
}

function union(a: Box | null, b: Box | null): Box | null {
  if (a === null) return b;
  if (b === null) return a;
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    width: Math.max(a.x + a.width, b.x + b.width) - x,
    height: Math.max(a.y + a.height, b.y + b.height) - y,
  };
}

function intersection(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return {
    x,
    y,
    width: Math.min(a.x + a.width, b.x + b.width) - x,
    height: Math.min(a.y + a.height, b.y + b.height) - y,
  };
}

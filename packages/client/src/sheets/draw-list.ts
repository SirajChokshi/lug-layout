export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

const HEX_COLOR = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/u;
const HEX = 16;

export function rgb(hex: string): Rgb {
  const match = HEX_COLOR.exec(hex);
  if (!match) throw new Error(`${hex} is not a #rrggbb colour`);
  return {
    r: Number.parseInt(match[1] ?? "", HEX),
    g: Number.parseInt(match[2] ?? "", HEX),
    b: Number.parseInt(match[3] ?? "", HEX),
  };
}

export interface Paint {
  readonly fill: Rgb | null;
  readonly fillOpacity: number;
  readonly stroke: Rgb | null;
  readonly strokeMm: number;
  readonly dashMm: ReadonlyArray<number>;
}

export function samePaint(a: Paint, b: Paint): boolean {
  return (
    sameColor(a.fill, b.fill) &&
    a.fillOpacity === b.fillOpacity &&
    sameColor(a.stroke, b.stroke) &&
    a.strokeMm === b.strokeMm &&
    a.dashMm.length === b.dashMm.length &&
    a.dashMm.every((dash, i) => dash === b.dashMm[i])
  );
}

function sameColor(a: Rgb | null, b: Rgb | null): boolean {
  if (a === null || b === null) return a === b;
  return a.r === b.r && a.g === b.g && a.b === b.b;
}

export type TextAnchor = "start" | "middle" | "end";

export type TextTurn = "none" | "counterclockwise";

export interface TextStyle {
  readonly sizeMm: number;
  readonly bold: boolean;
  readonly color: Rgb;
  readonly anchor: TextAnchor;
  readonly halo: boolean;
}

export type Point = readonly [number, number];

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Similarity {
  readonly scale: number;
  readonly dx: number;
  readonly dy: number;
}

export const IDENTITY: Similarity = { scale: 1, dx: 0, dy: 0 };

export function translation(dx: number, dy: number): Similarity {
  return { scale: 1, dx, dy };
}

export function composed(outer: Similarity, inner: Similarity): Similarity {
  return {
    scale: outer.scale * inner.scale,
    dx: outer.scale * inner.dx + outer.dx,
    dy: outer.scale * inner.dy + outer.dy,
  };
}

export interface RectItem {
  readonly kind: "rect";
  readonly role: string;
  readonly paint: Paint;
  readonly box: Box;
}

export interface PathItem {
  readonly kind: "path";
  readonly role: string;
  readonly paint: Paint;
  readonly rings: ReadonlyArray<ReadonlyArray<Point>>;
  readonly closed: boolean;
}

export interface LineItem {
  readonly kind: "line";
  readonly role: string;
  readonly paint: Paint;
  readonly from: Point;
  readonly to: Point;
}

export interface CircleItem {
  readonly kind: "circle";
  readonly role: string;
  readonly paint: Paint;
  readonly center: Point;
  readonly radius: number;
}

export interface TextItem {
  readonly kind: "text";
  readonly role: string;
  readonly style: TextStyle;
  readonly at: Point;
  readonly text: string;
  readonly turn: TextTurn;
}

export interface GroupItem {
  readonly kind: "group";
  readonly role: string;
  readonly transform: Similarity;
  readonly clip: Box | null;
  readonly items: ReadonlyArray<DrawItem>;
}

export type PaintedItem = RectItem | PathItem | LineItem | CircleItem;

export type DrawItem = PaintedItem | TextItem | GroupItem;

export function group(
  role: string,
  items: ReadonlyArray<DrawItem>,
  transform: Similarity = IDENTITY,
  clip: Box | null = null,
): GroupItem {
  return { kind: "group", role, transform, clip, items };
}

export function boxesOverlap(a: Box, b: Box): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

export function insetBox(box: Box, inset: number): Box {
  return {
    x: box.x + inset,
    y: box.y + inset,
    width: box.width - 2 * inset,
    height: box.height - 2 * inset,
  };
}

export const MASTER_GRID = 16;

export type IconSize = 16 | 20 | 24;

export const ICON_SIZES: ReadonlyArray<IconSize> = [16, 20, 24];

export type IconTone =
  | "ink"
  | "tone"
  | "paper"
  | "tint"
  | "accent"
  | "deep"
  | "wood"
  | "steel"
  | "go"
  | "stop"
  | "warn"
  | "gold";

export type Point = readonly [number, number];

export type Segment =
  | { readonly op: "M" | "L"; readonly to: Point }
  | {
      readonly op: "A";
      readonly radius: number;
      readonly large: boolean;
      readonly sweep: boolean;
      readonly to: Point;
    }
  | { readonly op: "Z" };

interface ShapeStyle {
  readonly tone: IconTone;
  readonly opacity: number;
  readonly halo: boolean;
  readonly sizes: ReadonlyArray<IconSize>;
}

export type Shape =
  | (ShapeStyle & {
      readonly kind: "rect";
      readonly x: number;
      readonly y: number;
      readonly w: number;
      readonly h: number;
      readonly radius: number;
    })
  | (ShapeStyle & { readonly kind: "circle"; readonly center: Point; readonly radius: number })
  | (ShapeStyle & { readonly kind: "path"; readonly segments: ReadonlyArray<Segment> });

export type Glyph = ReadonlyArray<Shape>;

interface StyleOptions {
  readonly opacity?: number;
  readonly halo?: boolean;
  readonly sizes?: ReadonlyArray<IconSize>;
}

const DEGREES_PER_HALF_TURN = 180;

function style(tone: IconTone, options: StyleOptions): ShapeStyle {
  return {
    tone,
    opacity: options.opacity ?? 1,
    halo: options.halo ?? false,
    sizes: options.sizes ?? ICON_SIZES,
  };
}

export function rect(
  x: number,
  y: number,
  w: number,
  h: number,
  tone: IconTone,
  options: StyleOptions & { readonly radius?: number } = {},
): Shape {
  return { kind: "rect", x, y, w, h, radius: options.radius ?? 0, ...style(tone, options) };
}

export function circle(
  cx: number,
  cy: number,
  radius: number,
  tone: IconTone,
  options: StyleOptions = {},
): Shape {
  return { kind: "circle", center: [cx, cy], radius, ...style(tone, options) };
}

export function path(
  tone: IconTone,
  segments: ReadonlyArray<Segment>,
  options: StyleOptions = {},
): Shape {
  return { kind: "path", segments, ...style(tone, options) };
}

export function poly(
  tone: IconTone,
  points: ReadonlyArray<Point>,
  options: StyleOptions = {},
): Shape {
  const [first, ...rest] = points;
  if (!first) throw new Error("a polygon needs points");
  return path(
    tone,
    [{ op: "M", to: first }, ...rest.map((to) => ({ op: "L" as const, to })), { op: "Z" }],
    options,
  );
}

function polar(center: Point, radius: number, degrees: number): Point {
  const radians = (degrees * Math.PI) / DEGREES_PER_HALF_TURN;
  return [center[0] + radius * Math.cos(radians), center[1] + radius * Math.sin(radians)];
}

export function bar(
  from: Point,
  to: Point,
  width: number,
  tone: IconTone,
  options: StyleOptions = {},
): Shape {
  const length = Math.sqrt((to[0] - from[0]) ** 2 + (to[1] - from[1]) ** 2);
  const nx = (-(to[1] - from[1]) / length) * (width / 2);
  const ny = ((to[0] - from[0]) / length) * (width / 2);
  return poly(
    tone,
    [
      [from[0] + nx, from[1] + ny],
      [to[0] + nx, to[1] + ny],
      [to[0] - nx, to[1] - ny],
      [from[0] - nx, from[1] - ny],
    ],
    options,
  );
}

export function arcBand(
  center: Point,
  inner: number,
  outer: number,
  fromDegrees: number,
  toDegrees: number,
  tone: IconTone,
  options: StyleOptions = {},
): Shape {
  const large = toDegrees - fromDegrees > DEGREES_PER_HALF_TURN;
  return path(
    tone,
    [
      { op: "M", to: polar(center, outer, fromDegrees) },
      { op: "A", radius: outer, large, sweep: true, to: polar(center, outer, toDegrees) },
      { op: "L", to: polar(center, inner, toDegrees) },
      { op: "A", radius: inner, large, sweep: false, to: polar(center, inner, fromDegrees) },
      { op: "Z" },
    ],
    options,
  );
}

export function radialBar(
  center: Point,
  inner: number,
  outer: number,
  degrees: number,
  width: number,
  tone: IconTone,
  options: StyleOptions = {},
): Shape {
  return bar(polar(center, inner, degrees), polar(center, outer, degrees), width, tone, options);
}

export function arrowHead(
  center: Point,
  radius: number,
  degrees: number,
  halfWidth: number,
  length: number,
  tone: IconTone,
  options: StyleOptions = {},
): Shape {
  const radians = (degrees * Math.PI) / DEGREES_PER_HALF_TURN;
  const base = polar(center, radius, degrees);
  const forward: Point = [-Math.sin(radians), Math.cos(radians)];
  return poly(
    tone,
    [
      polar(center, radius - halfWidth, degrees),
      [base[0] + forward[0] * length, base[1] + forward[1] * length],
      polar(center, radius + halfWidth, degrees),
    ],
    options,
  );
}

export function star(
  center: Point,
  outer: number,
  inner: number,
  tone: IconTone,
  options: StyleOptions = {},
): Shape {
  const points = Array.from({ length: 10 }, (_, index) =>
    polar(center, index % 2 === 0 ? outer : inner, -90 + index * 36),
  );
  return poly(tone, points, options);
}

function mirrorPoint([x, y]: Point): Point {
  return [MASTER_GRID - x, y];
}

function mirrorSegment(segment: Segment): Segment {
  switch (segment.op) {
    case "M":
    case "L":
      return { op: segment.op, to: mirrorPoint(segment.to) };
    case "A":
      return { ...segment, sweep: !segment.sweep, to: mirrorPoint(segment.to) };
    case "Z":
      return segment;
    default: {
      const unhandled: never = segment;
      throw new Error(`unhandled segment ${JSON.stringify(unhandled)}`);
    }
  }
}

function mirrorShape(shape: Shape): Shape {
  switch (shape.kind) {
    case "rect":
      return { ...shape, x: MASTER_GRID - shape.x - shape.w };
    case "circle":
      return { ...shape, center: mirrorPoint(shape.center) };
    case "path":
      return { ...shape, segments: shape.segments.map(mirrorSegment) };
    default: {
      const unhandled: never = shape;
      throw new Error(`unhandled shape ${JSON.stringify(unhandled)}`);
    }
  }
}

export function mirrored(glyph: Glyph): Glyph {
  return glyph.map(mirrorShape);
}

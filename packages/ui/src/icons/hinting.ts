import {
  MASTER_GRID,
  type Glyph,
  type IconSize,
  type IconTone,
  type Point,
  type Segment,
  type Shape,
} from "./shapes.ts";

export interface FittedShape {
  readonly tone: IconTone;
  readonly opacity: number;
  readonly halo: boolean;
  readonly segments: ReadonlyArray<Segment>;
}

const STEPS_PER_PIXEL = 2;

function wholePixel(value: number, scale: number): number {
  return Math.round(value * scale);
}

function halfPixel(value: number, scale: number): number {
  return Math.round(value * scale * STEPS_PER_PIXEL) / STEPS_PER_PIXEL;
}

function rectSegments(
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
): ReadonlyArray<Segment> {
  const right = x + w;
  const bottom = y + h;
  if (radius <= 0) {
    return [
      { op: "M", to: [x, y] },
      { op: "L", to: [right, y] },
      { op: "L", to: [right, bottom] },
      { op: "L", to: [x, bottom] },
      { op: "Z" },
    ];
  }
  const corner = (to: Point): Segment => ({ op: "A", radius, large: false, sweep: true, to });
  return [
    { op: "M", to: [x + radius, y] },
    { op: "L", to: [right - radius, y] },
    corner([right, y + radius]),
    { op: "L", to: [right, bottom - radius] },
    corner([right - radius, bottom]),
    { op: "L", to: [x + radius, bottom] },
    corner([x, bottom - radius]),
    { op: "L", to: [x, y + radius] },
    corner([x + radius, y]),
    { op: "Z" },
  ];
}

function fitStem(
  start: number,
  length: number,
  scale: number,
  box: number,
): readonly [number, number] {
  const fitted = Math.min(box, Math.max(1, wholePixel(length, scale)));
  return [Math.min(Math.max(0, wholePixel(start, scale)), box - fitted), fitted];
}

function fitRect(
  shape: Extract<Shape, { kind: "rect" }>,
  scale: number,
  box: number,
): ReadonlyArray<Segment> {
  const [x, w] = fitStem(shape.x, shape.w, scale, box);
  const [y, h] = fitStem(shape.y, shape.h, scale, box);
  const radius = Math.min(halfPixel(shape.radius, scale), w / 2, h / 2);
  return rectSegments(x, y, w, h, radius);
}

function fitCircle(
  shape: Extract<Shape, { kind: "circle" }>,
  scale: number,
): ReadonlyArray<Segment> {
  const diameter = Math.max(1, Math.round(shape.radius * 2 * scale));
  const radius = diameter / 2;
  const cx = Math.round(shape.center[0] * scale - radius) + radius;
  const cy = Math.round(shape.center[1] * scale - radius) + radius;
  const arc = (to: Point): Segment => ({ op: "A", radius, large: false, sweep: true, to });
  return [
    { op: "M", to: [cx - radius, cy] },
    arc([cx + radius, cy]),
    arc([cx - radius, cy]),
    { op: "Z" },
  ];
}

function endpoint(segment: Segment): Point | null {
  return segment.op === "Z" ? null : segment.to;
}

function straightEdges(segments: ReadonlyArray<Segment>): ReadonlyArray<readonly [Point, Point]> {
  const edges: Array<readonly [Point, Point]> = [];
  let start: Point | null = null;
  let previous: Point | null = null;
  for (const segment of segments) {
    if (segment.op === "M") start = segment.to;
    else if (segment.op === "L" && previous) edges.push([previous, segment.to]);
    else if (segment.op === "Z" && previous && start) edges.push([previous, start]);
    previous = segment.op === "Z" ? start : endpoint(segment);
  }
  return edges;
}

function moveTo(segment: Segment, to: Point): Segment {
  return segment.op === "Z" ? segment : { ...segment, to };
}

function fitPath(segments: ReadonlyArray<Segment>, scale: number): ReadonlyArray<Segment> {
  const halved = segments.map((segment) => {
    const to = endpoint(segment);
    const moved = to
      ? moveTo(segment, [halfPixel(to[0], scale), halfPixel(to[1], scale)])
      : segment;
    return moved.op === "A" ? { ...moved, radius: halfPixel(moved.radius, scale) } : moved;
  });
  const columns = new Set<number>();
  const rows = new Set<number>();
  for (const [from, to] of straightEdges(halved)) {
    if (from[0] === to[0]) columns.add(from[0]);
    if (from[1] === to[1]) rows.add(from[1]);
  }
  return halved.map((segment) => {
    const to = endpoint(segment);
    if (!to) return segment;
    return moveTo(segment, [
      columns.has(to[0]) ? Math.round(to[0]) : to[0],
      rows.has(to[1]) ? Math.round(to[1]) : to[1],
    ]);
  });
}

function fitShape(shape: Shape, scale: number, box: number): ReadonlyArray<Segment> {
  switch (shape.kind) {
    case "rect":
      return fitRect(shape, scale, box);
    case "circle":
      return fitCircle(shape, scale);
    case "path":
      return fitPath(shape.segments, scale);
    default: {
      const unhandled: never = shape;
      throw new Error(`unhandled shape ${JSON.stringify(unhandled)}`);
    }
  }
}

export function fitGlyph(glyph: Glyph, size: IconSize): ReadonlyArray<FittedShape> {
  const scale = size / MASTER_GRID;
  return glyph
    .filter((shape) => shape.sizes.includes(size))
    .map((shape) => ({
      tone: shape.tone,
      opacity: shape.opacity,
      halo: shape.halo,
      segments: fitShape(shape, scale, size),
    }));
}

function segmentData(segment: Segment): string {
  switch (segment.op) {
    case "M":
    case "L":
      return `${segment.op}${segment.to[0]} ${segment.to[1]}`;
    case "A":
      return `A${segment.radius} ${segment.radius} 0 ${segment.large ? 1 : 0} ${segment.sweep ? 1 : 0} ${segment.to[0]} ${segment.to[1]}`;
    case "Z":
      return "Z";
    default: {
      const unhandled: never = segment;
      throw new Error(`unhandled segment ${JSON.stringify(unhandled)}`);
    }
  }
}

export function pathData(segments: ReadonlyArray<Segment>): string {
  return segments.map(segmentData).join("");
}

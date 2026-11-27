import { expect, it } from "vitest";
import { ICON_GLYPHS, ICON_NAMES, type IconName } from "./glyphs.ts";
import { fitGlyph } from "./hinting.ts";
import { ICON_SIZES, type IconSize, type Point, type Segment } from "./shapes.ts";

function points(segments: ReadonlyArray<Segment>): ReadonlyArray<Point> {
  return segments.flatMap((segment) => (segment.op === "Z" ? [] : [segment.to]));
}

function edges(segments: ReadonlyArray<Segment>): ReadonlyArray<readonly [Point, Point]> {
  const found: Array<readonly [Point, Point]> = [];
  let start: Point | null = null;
  let previous: Point | null = null;
  for (const segment of segments) {
    if (segment.op === "M") start = segment.to;
    if (segment.op === "L" && previous) found.push([previous, segment.to]);
    if (segment.op === "Z" && previous && start) found.push([previous, start]);
    previous = segment.op === "Z" ? start : segment.to;
  }
  return found;
}

function blurryEdges(name: IconName, size: IconSize): ReadonlyArray<string> {
  return fitGlyph(ICON_GLYPHS[name], size).flatMap((shape) =>
    edges(shape.segments).flatMap(([from, to]) => {
      if (from[0] === to[0] && from[1] === to[1]) return [];
      const vertical = from[0] === to[0] && !Number.isInteger(from[0]);
      const horizontal = from[1] === to[1] && !Number.isInteger(from[1]);
      return vertical || horizontal ? [`${name}@${size}: ${from.join(",")} → ${to.join(",")}`] : [];
    }),
  );
}

function offGrid(name: IconName, size: IconSize): ReadonlyArray<string> {
  return fitGlyph(ICON_GLYPHS[name], size).flatMap((shape) =>
    points(shape.segments)
      .filter(
        ([x, y]) =>
          !Number.isInteger(x * 2) ||
          !Number.isInteger(y * 2) ||
          x < 0 ||
          y < 0 ||
          x > size ||
          y > size,
      )
      .map(([x, y]) => `${name}@${size}: ${x},${y}`),
  );
}

it("fits every icon's horizontal and vertical edges to whole pixels at 16, 20 and 24 px", () => {
  expect(
    ICON_NAMES.flatMap((name) => ICON_SIZES.flatMap((size) => blurryEdges(name, size))),
  ).toEqual([]);
});

it("keeps every icon's points on the half-pixel grid inside its box", () => {
  expect(ICON_NAMES.flatMap((name) => ICON_SIZES.flatMap((size) => offGrid(name, size)))).toEqual(
    [],
  );
});

import {
  addExactRational,
  compareExactDecimal,
  compareExactRational,
  divideExactRational,
  exactRational,
  exactRationalEquals,
  exactRationalFromDecimal,
  exactRationalFromFloat64,
  formatExactDecimal,
  multiplyExactRational,
  subtractExactRational,
  type ExactDecimal,
  type ExactRational,
} from "@brr/math";
import { exactPolygons, type ExactVec3 } from "../ldraw/exact-walk.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";

export const RAIL_SECTION_INWARD_LDU = 20;

export interface PlanPoint {
  readonly x: number;
  readonly z: number;
}

interface ExactPlanPoint {
  readonly x: ExactRational;
  readonly z: ExactRational;
}

export interface ScanEnd {
  readonly origin: PlanPoint;
  readonly along: number;
  readonly endSleeper: ReadonlyArray<ExactVec3>;
}

export interface RailHeads {
  readonly topY: ExactDecimal;
  readonly polygons: ReadonlyArray<ReadonlyArray<ExactPlanPoint>>;
}

export interface RailSection {
  readonly railCentresLdu: readonly [ExactRational, ExactRational];
  readonly railHalfSpacingLdu: ExactRational;
  readonly railCentreOffsetLdu: ExactRational;
}

interface FlatPolygon {
  readonly y: ExactDecimal;
  readonly outline: ReadonlyArray<ExactPlanPoint>;
}

interface Interval {
  readonly from: ExactRational;
  readonly to: ExactRational;
}

const ZERO = exactRational(0n, 1n);
const ONE = exactRational(1n, 1n);
const TWO = exactRational(2n, 1n);

function exactPlanPoint(point: PlanPoint): ExactPlanPoint {
  return { x: exactRationalFromFloat64(point.x), z: exactRationalFromFloat64(point.z) };
}

function sub(a: ExactPlanPoint, b: ExactPlanPoint): ExactPlanPoint {
  return { x: subtractExactRational(a.x, b.x), z: subtractExactRational(a.z, b.z) };
}

function cross(a: ExactPlanPoint, b: ExactPlanPoint): ExactRational {
  return subtractExactRational(multiplyExactRational(a.x, b.z), multiplyExactRational(a.z, b.x));
}

function lesser(a: ExactRational, b: ExactRational): ExactRational {
  return compareExactRational(a, b) <= 0 ? a : b;
}

function greater(a: ExactRational, b: ExactRational): ExactRational {
  return compareExactRational(a, b) >= 0 ? a : b;
}

export function flatPolygons(library: LdrawLibrary, part: string): ReadonlyArray<FlatPolygon> {
  return exactPolygons(library, part, true).flatMap((polygon) => {
    const [first, ...rest] = polygon.vertices;
    if (first === undefined) return [];
    const flat = rest.every((vertex) => compareExactDecimal(vertex[1], first[1]) === 0);
    if (!flat) return [];
    const outline = polygon.vertices.map(([x, , z]) => ({
      x: exactRationalFromDecimal(x),
      z: exactRationalFromDecimal(z),
    }));
    return [{ y: first[1], outline }];
  });
}

interface LevelScan {
  readonly y: ExactDecimal;
  readonly polygons: ReadonlyArray<ReadonlyArray<ExactPlanPoint>>;
  readonly intervals: ReadonlyArray<Interval>;
}

function adjacentRunsSmallestFirst<T>(fromTop: ReadonlyArray<T>): ReadonlyArray<ReadonlyArray<T>> {
  const runs: T[][] = [];
  for (let runLength = 1; runLength <= fromTop.length; runLength += 1) {
    for (let start = 0; start + runLength <= fromTop.length; start += 1) {
      runs.push(fromTop.slice(start, start + runLength));
    }
  }
  return runs;
}

function levelScansFromTop(
  flat: ReadonlyArray<FlatPolygon>,
  line: ScanLine,
): ReadonlyArray<LevelScan> {
  const crossed = flat
    .map((polygon) => ({ y: polygon.y, intervals: scanIntervals([polygon.outline], line) }))
    .filter((crossing) => crossing.intervals.length > 0);
  const levelsFromTop = crossed
    .map((crossing) => crossing.y)
    .toSorted(compareExactDecimal)
    .filter(
      (y, index, sorted) => index === 0 || compareExactDecimal(y, sorted[index - 1] ?? y) !== 0,
    );
  return levelsFromTop.map((y) => {
    const onLevel = (polygonY: ExactDecimal) => compareExactDecimal(polygonY, y) === 0;
    return {
      y,
      polygons: flat.filter((polygon) => onLevel(polygon.y)).map((polygon) => polygon.outline),
      intervals: crossed
        .filter((crossing) => onLevel(crossing.y))
        .flatMap((crossing) => crossing.intervals),
    };
  });
}

export function railHeadsAtEnd(flat: ReadonlyArray<FlatPolygon>, end: ScanEnd): RailHeads | null {
  const levelScans = levelScansFromTop(flat, scanLine(end, RAIL_SECTION_INWARD_LDU));
  for (const run of adjacentRunsSmallestFirst(levelScans)) {
    const [top] = run;
    if (top === undefined) continue;
    if (railPairIntervals(run.flatMap((level) => level.intervals)) === null) continue;
    return { topY: top.y, polygons: run.flatMap((level) => level.polygons) };
  }
  return null;
}

function insidePolygon(polygon: ReadonlyArray<ExactPlanPoint>, point: ExactPlanPoint): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    if (a === undefined || b === undefined) continue;
    const aAbove = compareExactRational(a.z, point.z) > 0;
    const bAbove = compareExactRational(b.z, point.z) > 0;
    if (aAbove === bAbove) continue;
    const crossingX = addExactRational(
      divideExactRational(
        multiplyExactRational(subtractExactRational(b.x, a.x), subtractExactRational(point.z, a.z)),
        subtractExactRational(b.z, a.z),
      ),
      a.x,
    );
    if (compareExactRational(point.x, crossingX) < 0) inside = !inside;
  }
  return inside;
}

export function onRailHead(heads: RailHeads, point: PlanPoint): boolean {
  const exact = exactPlanPoint(point);
  return heads.polygons.some((polygon) => insidePolygon(polygon, exact));
}

function crossingInterval(
  polygon: ReadonlyArray<ExactPlanPoint>,
  centre: ExactPlanPoint,
  normal: ExactPlanPoint,
): Interval | null {
  const sides = polygon.map((point) =>
    compareExactRational(cross(sub(point, centre), normal), ZERO),
  );
  if (sides.every((side) => side > 0) || sides.every((side) => side < 0)) return null;
  const crossings: ExactRational[] = [];
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (a === undefined || b === undefined) continue;
    const edge = sub(b, a);
    const toStart = sub(a, centre);
    const denominator = cross(normal, edge);
    if (exactRationalEquals(denominator, ZERO)) continue;
    const alongEdge = divideExactRational(cross(toStart, normal), denominator);
    if (compareExactRational(alongEdge, ZERO) < 0) continue;
    if (compareExactRational(alongEdge, ONE) > 0) continue;
    crossings.push(divideExactRational(cross(toStart, edge), denominator));
  }
  const [first, ...rest] = crossings;
  if (first === undefined) return null;
  return { from: rest.reduce(lesser, first), to: rest.reduce(greater, first) };
}

function mergedIntervals(intervals: ReadonlyArray<Interval>): ReadonlyArray<Interval> {
  const merged: Interval[] = [];
  for (const interval of intervals.toSorted((a, b) => compareExactRational(a.from, b.from))) {
    const last = merged.at(-1);
    if (last !== undefined && compareExactRational(interval.from, last.to) <= 0) {
      merged[merged.length - 1] = { from: last.from, to: greater(last.to, interval.to) };
    } else {
      merged.push(interval);
    }
  }
  return merged.filter((interval) => compareExactRational(interval.from, interval.to) < 0);
}

interface ScanLine {
  readonly centre: ExactPlanPoint;
  readonly normal: ExactPlanPoint;
  readonly endSleeperSpan: Interval;
}

function offsetAcross(
  point: ExactPlanPoint,
  centre: ExactPlanPoint,
  normal: ExactPlanPoint,
  direction: ExactPlanPoint,
): ExactRational {
  return divideExactRational(cross(sub(point, centre), direction), cross(normal, direction));
}

function distinctPlanPoints(vertices: ReadonlyArray<ExactVec3>): ReadonlyArray<ExactPlanPoint> {
  const byText = new Map<string, ExactPlanPoint>();
  for (const [x, , z] of vertices) {
    const key = `${formatExactDecimal(x)} ${formatExactDecimal(z)}`;
    if (!byText.has(key)) {
      byText.set(key, { x: exactRationalFromDecimal(x), z: exactRationalFromDecimal(z) });
    }
  }
  return [...byText.values()];
}

function spanAcross(
  points: ReadonlyArray<ExactPlanPoint>,
  centre: ExactPlanPoint,
  normal: ExactPlanPoint,
  direction: ExactPlanPoint,
): Interval {
  const [first, ...rest] = points;
  if (first === undefined) throw new Error("a track end has no end-sleeper geometry");
  const sideOf = (point: ExactPlanPoint) => cross(point, direction);
  const upward = compareExactRational(cross(normal, direction), ZERO) > 0;
  const lowest = rest.reduce(
    (low, point) => (compareExactRational(sideOf(point), sideOf(low)) < 0 ? point : low),
    first,
  );
  const highest = rest.reduce(
    (high, point) => (compareExactRational(sideOf(point), sideOf(high)) > 0 ? point : high),
    first,
  );
  const [from, to] = upward ? [lowest, highest] : [highest, lowest];
  return {
    from: offsetAcross(from, centre, normal, direction),
    to: offsetAcross(to, centre, normal, direction),
  };
}

function scanLine(end: ScanEnd, inwardLdu: number): ScanLine {
  const direction = exactPlanPoint({ x: Math.cos(end.along), z: Math.sin(end.along) });
  const normal = exactPlanPoint({ x: -Math.sin(end.along), z: Math.cos(end.along) });
  const inward = exactRationalFromFloat64(inwardLdu);
  const start = exactPlanPoint(end.origin);
  const centre = {
    x: addExactRational(start.x, multiplyExactRational(direction.x, inward)),
    z: addExactRational(start.z, multiplyExactRational(direction.z, inward)),
  };
  const endSleeperSpan = spanAcross(distinctPlanPoints(end.endSleeper), centre, normal, direction);
  return { centre, normal, endSleeperSpan };
}

function scanIntervals(
  polygons: ReadonlyArray<ReadonlyArray<ExactPlanPoint>>,
  line: ScanLine,
): ReadonlyArray<Interval> {
  return polygons.flatMap((polygon) => {
    const interval = crossingInterval(polygon, line.centre, line.normal);
    if (interval === null) return [];
    const clipped = {
      from: greater(interval.from, line.endSleeperSpan.from),
      to: lesser(interval.to, line.endSleeperSpan.to),
    };
    return compareExactRational(clipped.from, clipped.to) <= 0 ? [clipped] : [];
  });
}

function railPairIntervals(
  intervals: ReadonlyArray<Interval>,
): readonly [Interval, Interval] | null {
  const merged = mergedIntervals(intervals);
  const [nearInterval, farInterval] = merged;
  return merged.length === 2 && nearInterval !== undefined && farInterval !== undefined
    ? [nearInterval, farInterval]
    : null;
}

function intervalMidpoint(interval: Interval): ExactRational {
  return divideExactRational(addExactRational(interval.from, interval.to), TWO);
}

function railSectionFromIntervals(intervals: ReadonlyArray<Interval>): RailSection | null {
  const pair = railPairIntervals(intervals);
  if (pair === null) return null;
  const [nearInterval, farInterval] = pair;
  const nearCentre = intervalMidpoint(nearInterval);
  const farCentre = intervalMidpoint(farInterval);
  return {
    railCentresLdu: [nearCentre, farCentre],
    railHalfSpacingLdu: divideExactRational(subtractExactRational(farCentre, nearCentre), TWO),
    railCentreOffsetLdu: divideExactRational(addExactRational(farCentre, nearCentre), TWO),
  };
}

export function railSection(heads: RailHeads, end: ScanEnd, inwardLdu: number): RailSection | null {
  return railSectionFromIntervals(scanIntervals(heads.polygons, scanLine(end, inwardLdu)));
}

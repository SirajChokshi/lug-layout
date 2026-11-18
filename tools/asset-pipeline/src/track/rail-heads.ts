import {
  addExactRational,
  compareExactDecimal,
  compareExactRational,
  divideExactRational,
  EXACT_DECIMAL_ZERO,
  exactRational,
  exactRationalEquals,
  exactRationalFromDecimal,
  exactRationalFromFloat64,
  multiplyExactRational,
  parseExactDecimal,
  subtractExactDecimal,
  subtractExactRational,
  type ExactDecimal,
  type ExactRational,
} from "@brr/math";
import { exactPolygons } from "../ldraw/exact-walk.ts";
import type { LdrawLibrary } from "../ldraw/library.ts";

const LATERAL_SCAN_LDU = 90;
const RAIL_TOP_PROBE_RADIUS_LDU = 70;
const RAIL_LEVEL_BAND_LDU = parseExactDecimal("0.25");
export const RAIL_SECTION_INWARD_LDU = 20;

export interface PlanPoint {
  readonly x: number;
  readonly z: number;
}

interface ExactPlanPoint {
  readonly x: ExactRational;
  readonly z: ExactRational;
}

export interface RailHeads {
  readonly topY: ExactDecimal;
  readonly polygons: ReadonlyArray<ReadonlyArray<ExactPlanPoint>>;
}

export interface RailSection {
  readonly railCentresLdu: ReadonlyArray<ExactRational>;
  readonly halfSpacingLdu: ExactRational;
  readonly centreOffsetLdu: ExactRational;
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
const PROBE_RADIUS_SQUARED = exactRational(BigInt(RAIL_TOP_PROBE_RADIUS_LDU ** 2), 1n);
const SCAN_FROM = exactRational(BigInt(-LATERAL_SCAN_LDU), 1n);
const SCAN_TO = exactRational(BigInt(LATERAL_SCAN_LDU), 1n);

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

function headsAtLevel(flat: ReadonlyArray<FlatPolygon>, level: ExactDecimal): RailHeads {
  const withinBand = (y: ExactDecimal) => {
    const gap = subtractExactDecimal(y, level);
    const magnitude =
      compareExactDecimal(gap, EXACT_DECIMAL_ZERO) < 0 ? subtractExactDecimal(level, y) : gap;
    return compareExactDecimal(magnitude, RAIL_LEVEL_BAND_LDU) <= 0;
  };
  return {
    topY: level,
    polygons: flat.filter((polygon) => withinBand(polygon.y)).map((polygon) => polygon.outline),
  };
}

function nearOrigin(polygon: FlatPolygon, origin: ExactPlanPoint): boolean {
  return polygon.outline.some((point) => {
    const offset = sub(point, origin);
    const squared = addExactRational(
      multiplyExactRational(offset.x, offset.x),
      multiplyExactRational(offset.z, offset.z),
    );
    return compareExactRational(squared, PROBE_RADIUS_SQUARED) <= 0;
  });
}

export function railHeadsAtEnd(
  flat: ReadonlyArray<FlatPolygon>,
  origin: PlanPoint,
  along: number,
): RailHeads | null {
  const exactOrigin = exactPlanPoint(origin);
  const levels = flat
    .filter((polygon) => nearOrigin(polygon, exactOrigin))
    .map((polygon) => polygon.y)
    .toSorted(compareExactDecimal)
    .filter(
      (y, index, sorted) => index === 0 || compareExactDecimal(y, sorted[index - 1] ?? y) !== 0,
    );
  for (const level of levels) {
    const heads = headsAtLevel(flat, level);
    if (railSection(heads, origin, along, RAIL_SECTION_INWARD_LDU) !== null) return heads;
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

function mergedRuns(intervals: ReadonlyArray<Interval>): ReadonlyArray<Interval> {
  const runs: Interval[] = [];
  for (const interval of intervals.toSorted((a, b) => compareExactRational(a.from, b.from))) {
    const last = runs.at(-1);
    if (last !== undefined && compareExactRational(interval.from, last.to) <= 0) {
      runs[runs.length - 1] = { from: last.from, to: greater(last.to, interval.to) };
    } else {
      runs.push(interval);
    }
  }
  return runs.filter((run) => compareExactRational(run.from, run.to) < 0);
}

export function railSection(
  heads: RailHeads,
  origin: PlanPoint,
  along: number,
  inwardLdu: number,
): RailSection | null {
  const direction = exactPlanPoint({ x: Math.cos(along), z: Math.sin(along) });
  const normal = exactPlanPoint({ x: -Math.sin(along), z: Math.cos(along) });
  const inward = exactRationalFromFloat64(inwardLdu);
  const start = exactPlanPoint(origin);
  const centre = {
    x: addExactRational(start.x, multiplyExactRational(direction.x, inward)),
    z: addExactRational(start.z, multiplyExactRational(direction.z, inward)),
  };
  const intervals = heads.polygons.flatMap((polygon) => {
    const interval = crossingInterval(polygon, centre, normal);
    if (interval === null) return [];
    const clipped = { from: greater(interval.from, SCAN_FROM), to: lesser(interval.to, SCAN_TO) };
    return compareExactRational(clipped.from, clipped.to) <= 0 ? [clipped] : [];
  });
  const railCentresLdu = mergedRuns(intervals).map((run) =>
    divideExactRational(addExactRational(run.from, run.to), TWO),
  );
  const [near, far] = railCentresLdu;
  if (railCentresLdu.length !== 2 || near === undefined || far === undefined) return null;
  return {
    railCentresLdu,
    halfSpacingLdu: divideExactRational(subtractExactRational(far, near), TWO),
    centreOffsetLdu: divideExactRational(addExactRational(far, near), TWO),
  };
}

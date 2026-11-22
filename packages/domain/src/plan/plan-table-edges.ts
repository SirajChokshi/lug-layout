import type { LduRect } from "./plan-region.ts";

export const ALONG_X = 0;
export const ALONG_Z = 1;
export const EDGE_FLOATS = 4;
export const EDGE_AXIS = 0;
export const EDGE_LINE = 1;
export const EDGE_FROM = 2;
export const EDGE_TO = 3;
export const SEAM_FLOATS = 5;
export const SEAM_PAIR = 4;

export interface NamedSurface {
  readonly name: string;
  readonly surface: LduRect;
}

export interface TableSeams {
  readonly edges: Float64Array;
  readonly pairs: ReadonlyArray<string>;
}

type Interval = readonly [number, number];

interface TableEdge {
  readonly axis: number;
  readonly line: number;
  readonly from: number;
  readonly to: number;
  readonly outward: -1 | 1;
}

function edgesOf(rect: LduRect): ReadonlyArray<TableEdge> {
  return [
    { axis: ALONG_X, line: rect.minZ, from: rect.minX, to: rect.maxX, outward: -1 },
    { axis: ALONG_X, line: rect.maxZ, from: rect.minX, to: rect.maxX, outward: 1 },
    { axis: ALONG_Z, line: rect.minX, from: rect.minZ, to: rect.maxZ, outward: -1 },
    { axis: ALONG_Z, line: rect.maxX, from: rect.minZ, to: rect.maxZ, outward: 1 },
  ];
}

function across(rect: LduRect, axis: number): Interval {
  return axis === ALONG_X ? [rect.minZ, rect.maxZ] : [rect.minX, rect.maxX];
}

function along(rect: LduRect, axis: number): Interval {
  return axis === ALONG_X ? [rect.minX, rect.maxX] : [rect.minZ, rect.maxZ];
}

function coversOutward(other: LduRect, edge: TableEdge): boolean {
  const [low, high] = across(other, edge.axis);
  return edge.outward < 0
    ? low < edge.line && high >= edge.line
    : high > edge.line && low <= edge.line;
}

function meetsLine(obstacle: LduRect, edge: TableEdge): boolean {
  const [low, high] = across(obstacle, edge.axis);
  return low <= edge.line && edge.line <= high;
}

function subtract(intervals: ReadonlyArray<Interval>, cut: Interval): Interval[] {
  const [low, high] = cut;
  const kept: Interval[] = [];
  for (const [from, to] of intervals) {
    const before = Math.min(to, low);
    if (from < before) kept.push([from, before]);
    const after = Math.max(from, high);
    if (after < to) kept.push([after, to]);
  }
  return kept;
}

export function freeTableEdges(
  surfaces: ReadonlyArray<LduRect>,
  obstacles: ReadonlyArray<LduRect>,
): Float64Array {
  const free: number[] = [];
  surfaces.forEach((table, i) => {
    for (const edge of edgesOf(table)) {
      let open: Interval[] = edge.from < edge.to ? [[edge.from, edge.to]] : [];
      surfaces.forEach((other, j) => {
        if (j !== i && coversOutward(other, edge)) open = subtract(open, along(other, edge.axis));
      });
      for (const obstacle of obstacles) {
        if (meetsLine(obstacle, edge)) open = subtract(open, along(obstacle, edge.axis));
      }
      for (const [from, to] of open) free.push(edge.axis, edge.line, from, to);
    }
  });
  return Float64Array.from(free);
}

function seamBetween(a: LduRect, b: LduRect, axis: number): readonly [number, Interval] | null {
  const [aLow, aHigh] = across(a, axis);
  const [bLow, bHigh] = across(b, axis);
  const line = aHigh === bLow ? aHigh : bHigh === aLow ? bHigh : null;
  if (line === null) return null;
  const [aFrom, aTo] = along(a, axis);
  const [bFrom, bTo] = along(b, axis);
  const from = Math.max(aFrom, bFrom);
  const to = Math.min(aTo, bTo);
  return from < to ? [line, [from, to]] : null;
}

export function tableSeams(tables: ReadonlyArray<NamedSurface>): TableSeams {
  const edges: number[] = [];
  const pairs: string[] = [];
  tables.forEach((a, i) => {
    tables.slice(i + 1).forEach((b) => {
      for (const axis of [ALONG_X, ALONG_Z]) {
        const seam = seamBetween(a.surface, b.surface, axis);
        if (!seam) continue;
        const [line, [from, to]] = seam;
        edges.push(axis, line, from, to, pairs.length);
        pairs.push(`"${a.name}" and "${b.name}"`);
      }
    });
  });
  return { edges: Float64Array.from(edges), pairs };
}

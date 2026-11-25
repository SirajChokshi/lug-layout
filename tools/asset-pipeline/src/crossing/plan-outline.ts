import { withoutDegeneratePieces } from "@brr/domain/degenerate-outline";
import { OUTLINE_UNITS_PER_LDU, type PlanOutline } from "@brr/schema/bundle";
import type { PlacedPolygon } from "../ldraw/walk.ts";

export type PlanPoint = readonly [number, number];
export type PlanRing = ReadonlyArray<PlanPoint>;

export interface BakedOutline {
  readonly rings: PlanOutline;
  readonly roundedLdu: number;
}

const GRID_CELL_UNITS = 20 * OUTLINE_UNITS_PER_LDU;
const MAX_UNITS = 2 ** 52;
const REPORTED_LDU_STEPS = 1e12;

interface Point {
  readonly x: bigint;
  readonly z: bigint;
  readonly d: bigint;
}

interface Triangle {
  readonly a: Point;
  readonly b: Point;
  readonly c: Point;
}

interface Segment {
  readonly a: Point;
  readonly b: Point;
  readonly splits: Point[];
}

interface Directed {
  readonly from: Point;
  readonly to: Point;
  used: boolean;
}

class UnitGrid {
  roundedLdu = 0;

  units(coordinate: number): bigint {
    const scaled = Math.round(coordinate * OUTLINE_UNITS_PER_LDU);
    if (!Number.isSafeInteger(scaled) || Math.abs(scaled) >= MAX_UNITS) {
      throw new Error(`plan coordinate ${coordinate} LDU is out of the outline's range`);
    }
    this.roundedLdu = Math.max(
      this.roundedLdu,
      Math.abs(coordinate - scaled / OUTLINE_UNITS_PER_LDU),
    );
    return BigInt(scaled);
  }
}

function whole(x: bigint, z: bigint): Point {
  return { x, z, d: 1n };
}

function gcd(a: bigint, b: bigint): bigint {
  let p = a < 0n ? -a : a;
  let q = b < 0n ? -b : b;
  while (q !== 0n) [p, q] = [q, p % q];
  return p;
}

function normalized(x: bigint, z: bigint, d: bigint): Point {
  const flip = d < 0n ? -1n : 1n;
  const g = gcd(gcd(x, z), d) || 1n;
  return { x: (flip * x) / g, z: (flip * z) / g, d: (flip * d) / g };
}

function key(p: Point): string {
  return `${p.x}/${p.z}/${p.d}`;
}

function sign(value: bigint): number {
  return value > 0n ? 1 : value < 0n ? -1 : 0;
}

function orient(a: Point, b: Point, c: Point): number {
  const abx = b.x * a.d - a.x * b.d;
  const abz = b.z * a.d - a.z * b.d;
  const acx = c.x * a.d - a.x * c.d;
  const acz = c.z * a.d - a.z * c.d;
  return sign(abx * acz - abz * acx) * sign(b.d) * sign(c.d);
}

function compareAlong(a: Point, b: Point, p: Point, q: Point): number {
  const dx = b.x * a.d - a.x * b.d;
  const dz = b.z * a.d - a.z * b.d;
  const along = (r: Point) => (r.x * a.d - a.x * r.d) * dx + (r.z * a.d - a.z * r.d) * dz;
  return sign(along(p) * q.d - along(q) * p.d) * sign(p.d) * sign(q.d);
}

function strictlyBetween(a: Point, b: Point, p: Point): boolean {
  return compareAlong(a, b, a, p) < 0 && compareAlong(a, b, p, b) < 0;
}

function sameSpot(p: Point, q: Point): boolean {
  return p.x * q.d === q.x * p.d && p.z * q.d === q.z * p.d;
}

function crossing(s: Segment, t: Segment): Point | null {
  const rx = s.b.x - s.a.x;
  const rz = s.b.z - s.a.z;
  const qx = t.b.x - t.a.x;
  const qz = t.b.z - t.a.z;
  const denominator = rx * qz - rz * qx;
  if (denominator === 0n) return null;
  const ax = t.a.x - s.a.x;
  const az = t.a.z - s.a.z;
  const tNumerator = ax * qz - az * qx;
  return normalized(
    s.a.x * denominator + tNumerator * rx,
    s.a.z * denominator + tNumerator * rz,
    denominator,
  );
}

function splitPair(s: Segment, t: Segment): void {
  const o1 = orient(s.a, s.b, t.a);
  const o2 = orient(s.a, s.b, t.b);
  const o3 = orient(t.a, t.b, s.a);
  const o4 = orient(t.a, t.b, s.b);
  if (o1 === 0 && o2 === 0) {
    for (const p of [t.a, t.b]) if (strictlyBetween(s.a, s.b, p)) s.splits.push(p);
    for (const p of [s.a, s.b]) if (strictlyBetween(t.a, t.b, p)) t.splits.push(p);
    return;
  }
  if (o1 * o2 > 0 || o3 * o4 > 0) return;
  if (o1 === 0) {
    if (strictlyBetween(s.a, s.b, t.a)) s.splits.push(t.a);
    return;
  }
  if (o2 === 0) {
    if (strictlyBetween(s.a, s.b, t.b)) s.splits.push(t.b);
    return;
  }
  if (o3 === 0) {
    if (strictlyBetween(t.a, t.b, s.a)) t.splits.push(s.a);
    return;
  }
  if (o4 === 0) {
    if (strictlyBetween(t.a, t.b, s.b)) t.splits.push(s.b);
    return;
  }
  const p = crossing(s, t);
  if (!p) return;
  s.splits.push(p);
  t.splits.push(p);
}

class Grid<T> {
  private readonly cells = new Map<string, T[]>();

  add(item: T, minX: number, minZ: number, maxX: number, maxZ: number): void {
    for (const cell of this.cellsOver(minX, minZ, maxX, maxZ)) {
      const list = this.cells.get(cell);
      if (list) list.push(item);
      else this.cells.set(cell, [item]);
    }
  }

  near(minX: number, minZ: number, maxX: number, maxZ: number): ReadonlySet<T> {
    const found = new Set<T>();
    for (const cell of this.cellsOver(minX, minZ, maxX, maxZ)) {
      for (const item of this.cells.get(cell) ?? []) found.add(item);
    }
    return found;
  }

  private *cellsOver(minX: number, minZ: number, maxX: number, maxZ: number): Generator<string> {
    for (let x = Math.floor(minX / GRID_CELL_UNITS); x <= Math.floor(maxX / GRID_CELL_UNITS); x++) {
      for (
        let z = Math.floor(minZ / GRID_CELL_UNITS);
        z <= Math.floor(maxZ / GRID_CELL_UNITS);
        z++
      ) {
        yield `${x},${z}`;
      }
    }
  }
}

function bounds(points: ReadonlyArray<Point>): readonly [number, number, number, number] {
  const xs = points.map((p) => Number(p.x) / Number(p.d));
  const zs = points.map((p) => Number(p.z) / Number(p.d));
  return [Math.min(...xs) - 1, Math.min(...zs) - 1, Math.max(...xs) + 1, Math.max(...zs) + 1];
}

function planTriangles(polygons: ReadonlyArray<PlacedPolygon>, grid: UnitGrid): Triangle[] {
  const triangles: Triangle[] = [];
  for (const { vertices } of polygons) {
    const plan = vertices.map(([x, , z]) => whole(grid.units(x), grid.units(-z)));
    for (let i = 1; i + 1 < plan.length; i++) {
      const a = plan[0];
      const b = plan[i];
      const c = plan[i + 1];
      if (!a || !b || !c) continue;
      const turn = orient(a, b, c);
      if (turn > 0) triangles.push({ a, b, c });
      else if (turn < 0) triangles.push({ a, b: c, c: b });
    }
  }
  return triangles;
}

function uniqueSegments(triangles: ReadonlyArray<Triangle>): Segment[] {
  const byKey = new Map<string, Segment>();
  for (const { a, b, c } of triangles) {
    for (const [p, q] of [
      [a, b],
      [b, c],
      [c, a],
    ] as const) {
      const [lo, hi] = key(p) < key(q) ? [p, q] : [q, p];
      const k = `${key(lo)}|${key(hi)}`;
      if (!byKey.has(k)) byKey.set(k, { a: lo, b: hi, splits: [] });
    }
  }
  return [...byKey.values()];
}

function splitAll(segments: ReadonlyArray<Segment>): void {
  const grid = new Grid<number>();
  segments.forEach((segment, index) => grid.add(index, ...bounds([segment.a, segment.b])));
  segments.forEach((segment, index) => {
    for (const other of grid.near(...bounds([segment.a, segment.b]))) {
      if (other <= index) continue;
      const s = segments[other];
      if (s) splitPair(segment, s);
    }
  });
}

function pieces(segment: Segment): Array<readonly [Point, Point]> {
  const unique = new Map<string, Point>();
  for (const p of segment.splits) unique.set(key(p), p);
  const points = [...unique.values()].toSorted((p, q) => compareAlong(segment.a, segment.b, p, q));
  const chain = [segment.a, ...points, segment.b];
  const out: Array<readonly [Point, Point]> = [];
  for (let i = 0; i + 1 < chain.length; i++) {
    const p = chain[i];
    const q = chain[i + 1];
    if (p && q && !sameSpot(p, q)) out.push([p, q]);
  }
  return out;
}

function midpoint(p: Point, q: Point): Point {
  return normalized(p.x * q.d + q.x * p.d, p.z * q.d + q.z * p.d, 2n * p.d * q.d);
}

type Cover = "both" | "left" | "right" | "none";

function coverOf(t: Triangle, a: Point, b: Point, m: Point): Cover {
  const o1 = orient(t.a, t.b, m);
  const o2 = orient(t.b, t.c, m);
  const o3 = orient(t.c, t.a, m);
  if (o1 < 0 || o2 < 0 || o3 < 0) return "none";
  if (o1 > 0 && o2 > 0 && o3 > 0) return "both";
  const opposite = o1 === 0 ? t.c : o2 === 0 ? t.a : t.b;
  const side = orient(a, b, opposite);
  return side > 0 ? "left" : side < 0 ? "right" : "none";
}

function boundaryEdges(
  triangles: ReadonlyArray<Triangle>,
  segments: ReadonlyArray<Segment>,
): Directed[] {
  const grid = new Grid<Triangle>();
  for (const t of triangles) grid.add(t, ...bounds([t.a, t.b, t.c]));
  const seen = new Set<string>();
  const edges: Directed[] = [];
  for (const segment of segments) {
    for (const [a, b] of pieces(segment)) {
      const k = key(a) < key(b) ? `${key(a)}|${key(b)}` : `${key(b)}|${key(a)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const m = midpoint(a, b);
      let left = false;
      let right = false;
      for (const t of grid.near(...bounds([m]))) {
        const cover = coverOf(t, a, b, m);
        if (cover === "both") {
          left = true;
          right = true;
          break;
        }
        if (cover === "left") left = true;
        if (cover === "right") right = true;
        if (left && right) break;
      }
      if (left === right) continue;
      edges.push(left ? { from: a, to: b, used: false } : { from: b, to: a, used: false });
    }
  }
  return edges;
}

function halfTurnFrom(origin: Point, reference: Point, p: Point): number {
  const side = orient(origin, reference, p);
  if (side < 0) return 0;
  if (side > 0) return 1;
  return compareAlong(origin, reference, origin, p) < 0 ? 1 : 0;
}

function turnsBefore(origin: Point, reference: Point, p: Point, q: Point): boolean {
  const ph = halfTurnFrom(origin, reference, p);
  const qh = halfTurnFrom(origin, reference, q);
  if (ph !== qh) return ph < qh;
  return orient(origin, p, q) < 0;
}

function chainRings(edges: ReadonlyArray<Directed>): Point[][] {
  const outgoing = new Map<string, Directed[]>();
  for (const edge of edges) {
    const k = key(edge.from);
    const list = outgoing.get(k);
    if (list) list.push(edge);
    else outgoing.set(k, [edge]);
  }
  const rings: Point[][] = [];
  for (const start of edges) {
    if (start.used) continue;
    const ring: Point[] = [];
    let edge: Directed = start;
    for (;;) {
      edge.used = true;
      ring.push(edge.from);
      if (sameSpot(edge.to, start.from)) break;
      const candidates = (outgoing.get(key(edge.to)) ?? []).filter((next) => !next.used);
      if (candidates.length === 0) throw new Error("the plan outline's boundary does not close");
      const corner = edge.to;
      const back = edge.from;
      edge = candidates.reduce((best, next) =>
        turnsBefore(corner, back, next.to, best.to) ? next : best,
      );
    }
    rings.push(ring);
  }
  return rings;
}

function withoutStraightVertices(ring: ReadonlyArray<Point>): Point[] {
  let points = [...ring];
  let changed = true;
  while (changed && points.length > 3) {
    changed = false;
    for (let i = 0; i < points.length; i++) {
      const prev = points[(i + points.length - 1) % points.length];
      const here = points[i];
      const next = points[(i + 1) % points.length];
      if (!prev || !here || !next) continue;
      if (orient(prev, here, next) === 0) {
        points = points.filter((_, j) => j !== i);
        changed = true;
        break;
      }
    }
  }
  return points;
}

function nearestUnit(numerator: bigint, denominator: bigint): bigint {
  const twice = 2n * numerator + (numerator < 0n ? -denominator : denominator);
  return twice / (2n * denominator);
}

function residualLdu(numerator: bigint, denominator: bigint, unit: bigint): number {
  const offset = Number(numerator - unit * denominator) / Number(denominator);
  return Math.abs(offset) / OUTLINE_UNITS_PER_LDU;
}

function signedArea(ring: PlanRing): number {
  let twice = 0;
  for (let i = 0; i < ring.length; i++) {
    const [ax, az] = ring[i] ?? [0, 0];
    const [bx, bz] = ring[(i + 1) % ring.length] ?? [0, 0];
    twice += ax * bz - bx * az;
  }
  return twice / 2;
}

export function planOutline(polygons: ReadonlyArray<PlacedPolygon>): BakedOutline {
  const grid = new UnitGrid();
  const triangles = planTriangles(polygons, grid);
  const segments = uniqueSegments(triangles);
  splitAll(segments);
  let roundedLdu = grid.roundedLdu;
  const rounded = chainRings(boundaryEdges(triangles, segments))
    .map(withoutStraightVertices)
    .map((ring) =>
      ring.map((p): [number, number] => {
        const x = nearestUnit(p.x, p.d);
        const z = nearestUnit(p.z, p.d);
        roundedLdu = Math.max(roundedLdu, residualLdu(p.x, p.d, x), residualLdu(p.z, p.d, z));
        return [Number(x), Number(z)];
      }),
    );
  const rings = withoutDegeneratePieces(rounded).toSorted(
    (a, b) => Math.abs(signedArea(b)) - Math.abs(signedArea(a)),
  );
  return { rings, roundedLdu: Math.round(roundedLdu * REPORTED_LDU_STEPS) / REPORTED_LDU_STEPS };
}

export function outlineAreaLdu2(rings: ReadonlyArray<PlanRing>): number {
  return rings.reduce((sum, ring) => sum + signedArea(ring), 0) / OUTLINE_UNITS_PER_LDU ** 2;
}

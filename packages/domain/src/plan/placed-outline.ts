import {
  addZeta16,
  conjugateZeta16,
  multiplyZeta16,
  rotateZeta16,
  STUD_LDU,
  subtractZeta16,
  ZETA16_ORDER,
  zeta16,
  zeta16ImaginarySign,
  zeta16RealSign,
  type Pose16,
  type Rot90,
  type Sign,
  type Zeta16,
} from "@brr/math";
import { OUTLINE_UNITS_PER_LDU } from "@brr/schema/bundle";
import type { LduRect } from "./plan-region.ts";

export type OutlinePoint = readonly [number, number];
export type OutlineRing = ReadonlyArray<OutlinePoint>;

export type PlanAxis = "x" | "z";

export interface AxisEdge {
  readonly axis: PlanAxis;
  readonly at: number;
  readonly from: number;
  readonly to: number;
  readonly inside: -1 | 1;
}

interface Vertex {
  readonly exact: Zeta16;
  readonly x: number;
  readonly z: number;
  readonly whole: boolean;
}

const ONE = BigInt(OUTLINE_UNITS_PER_LDU);
const UNIT = OUTLINE_UNITS_PER_LDU;
const QUARTER_TURN_STEPS = ZETA16_ORDER / 4;
const STEP_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const RELATIVE_ERROR = 1e-12;
const EXACT_PRODUCT_LIMIT = 2 ** 25;
function exactLdu(ldu: number): bigint {
  return BigInt(Math.round(ldu * UNIT));
}

function exactUnits(units: number): bigint {
  if (!Number.isSafeInteger(units)) throw new Error(`outline vertex ${units} is not a whole unit`);
  return BigInt(units);
}

function planValue(x: bigint, z: bigint): Zeta16 {
  return zeta16([x, 0n, 0n, 0n, z, 0n, 0n, 0n]);
}

function scaled(value: Zeta16, by: bigint): Zeta16 {
  return zeta16(value.map((coefficient) => coefficient * by));
}

function isWholeLdu(exact: Zeta16): boolean {
  const [c0, c1, c2, c3, c4, c5, c6, c7] = exact;
  return (
    c1 === 0n &&
    c2 === 0n &&
    c3 === 0n &&
    c5 === 0n &&
    c6 === 0n &&
    c7 === 0n &&
    c0 % ONE === 0n &&
    c4 % ONE === 0n &&
    c0 / ONE < BigInt(EXACT_PRODUCT_LIMIT) &&
    -c0 / ONE < BigInt(EXACT_PRODUCT_LIMIT) &&
    c4 / ONE < BigInt(EXACT_PRODUCT_LIMIT) &&
    -c4 / ONE < BigInt(EXACT_PRODUCT_LIMIT)
  );
}

function vertexOf(exact: Zeta16): Vertex {
  if (isWholeLdu(exact)) {
    return { exact, x: Number(exact[0] / ONE), z: Number(exact[4] / ONE), whole: true };
  }
  let x = 0;
  let z = 0;
  exact.forEach((coefficient, power) => {
    const c = Number(coefficient) / UNIT;
    x += c * Math.cos(power * STEP_RADIANS);
    z += c * Math.sin(power * STEP_RADIANS);
  });
  return { exact, x, z, whole: false };
}

function tolerance(...values: ReadonlyArray<number>): number {
  let magnitude = 1;
  for (const value of values) magnitude = Math.max(magnitude, Math.abs(value));
  return RELATIVE_ERROR * magnitude;
}

function orient(a: Vertex, b: Vertex, c: Vertex): Sign {
  const ux = b.x - a.x;
  const uz = b.z - a.z;
  const wx = c.x - a.x;
  const wz = c.z - a.z;
  const value = ux * wz - uz * wx;
  if (a.whole && b.whole && c.whole) return value > 0 ? 1 : value < 0 ? -1 : 0;
  const slack = tolerance(a.x, a.z, b.x, b.z, c.x, c.z);
  if (
    Math.abs(value) >
    4 * slack * (Math.abs(ux) + Math.abs(uz) + Math.abs(wx) + Math.abs(wz) + slack)
  ) {
    return value > 0 ? 1 : -1;
  }
  const u = subtractZeta16(b.exact, a.exact);
  const w = subtractZeta16(c.exact, a.exact);
  return zeta16ImaginarySign(multiplyZeta16(conjugateZeta16(u), w));
}

function dot(a: Vertex, b: Vertex, c: Vertex, d: Vertex): Sign {
  const ux = b.x - a.x;
  const uz = b.z - a.z;
  const wx = d.x - c.x;
  const wz = d.z - c.z;
  const value = ux * wx + uz * wz;
  if (a.whole && b.whole && c.whole && d.whole) return value > 0 ? 1 : value < 0 ? -1 : 0;
  const slack = tolerance(a.x, a.z, b.x, b.z, c.x, c.z, d.x, d.z);
  if (
    Math.abs(value) >
    4 * slack * (Math.abs(ux) + Math.abs(uz) + Math.abs(wx) + Math.abs(wz) + slack)
  ) {
    return value > 0 ? 1 : -1;
  }
  const u = subtractZeta16(b.exact, a.exact);
  const w = subtractZeta16(d.exact, c.exact);
  return zeta16RealSign(multiplyZeta16(conjugateZeta16(u), w));
}

function zOrder(a: Vertex, b: Vertex): Sign {
  const value = a.z - b.z;
  if (a.whole && b.whole) return value > 0 ? 1 : value < 0 ? -1 : 0;
  if (Math.abs(value) > 4 * tolerance(a.z, b.z)) return value > 0 ? 1 : -1;
  return zeta16ImaginarySign(subtractZeta16(a.exact, b.exact));
}

function withinExactRange(x: number, z: number): boolean {
  return Math.abs(x) < EXACT_PRODUCT_LIMIT && Math.abs(z) < EXACT_PRODUCT_LIMIT;
}

function doubled(v: Vertex): Vertex {
  const x = 2 * v.x;
  const z = 2 * v.z;
  return { exact: scaled(v.exact, 2n), x, z, whole: v.whole && withinExactRange(x, z) };
}

function sum(a: Vertex, b: Vertex): Vertex {
  const x = a.x + b.x;
  const z = a.z + b.z;
  return {
    exact: addZeta16(a.exact, b.exact),
    x,
    z,
    whole: a.whole && b.whole && withinExactRange(x, z),
  };
}

function strictlyWithin(a: Vertex, b: Vertex, p: Vertex): boolean {
  return dot(a, b, a, p) > 0 && dot(b, a, b, p) > 0;
}

function collinearOverlap(a: Vertex, b: Vertex, c: Vertex, d: Vertex): boolean {
  const pastA = dot(a, b, a, c) > 0 || dot(a, b, a, d) > 0;
  const beforeB = dot(a, b, b, c) < 0 || dot(a, b, b, d) < 0;
  return pastA && beforeB;
}

function boundsOf(rings: ReadonlyArray<ReadonlyArray<Vertex>>): LduRect {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const ring of rings) {
    for (const v of ring) {
      minX = Math.min(minX, v.x);
      minZ = Math.min(minZ, v.z);
      maxX = Math.max(maxX, v.x);
      maxZ = Math.max(maxZ, v.z);
    }
  }
  const pad = tolerance(minX, minZ, maxX, maxZ);
  return { minX: minX - pad, minZ: minZ - pad, maxX: maxX + pad, maxZ: maxZ + pad };
}

function boundsMeet(a: LduRect, b: LduRect): boolean {
  return a.minX <= b.maxX && b.minX <= a.maxX && a.minZ <= b.maxZ && b.minZ <= a.maxZ;
}

function edgeBounds(a: Vertex, b: Vertex): LduRect {
  const pad = tolerance(a.x, a.z, b.x, b.z);
  return {
    minX: Math.min(a.x, b.x) - pad,
    minZ: Math.min(a.z, b.z) - pad,
    maxX: Math.max(a.x, b.x) + pad,
    maxZ: Math.max(a.z, b.z) + pad,
  };
}

function wholeLdu(value: Zeta16, axis: PlanAxis, approx: number): number | null {
  const candidate = Math.round(approx);
  const offset =
    axis === "x" ? planValue(BigInt(candidate) * ONE, 0n) : planValue(0n, BigInt(candidate) * ONE);
  const residual = subtractZeta16(value, offset);
  const sign = axis === "x" ? zeta16RealSign(residual) : zeta16ImaginarySign(residual);
  return sign === 0 ? candidate : null;
}

function lduCorner(x: number, z: number): Vertex {
  return vertexOf(planValue(exactLdu(x), exactLdu(z)));
}

interface Edge {
  readonly a: Vertex;
  readonly b: Vertex;
  readonly box: LduRect;
  readonly zeroLength: boolean;
}

function sameExact(a: Vertex, b: Vertex): boolean {
  return a.exact.every((coefficient, power) => coefficient === b.exact[power]);
}

function edgesOf(rings: ReadonlyArray<ReadonlyArray<Vertex>>): ReadonlyArray<Edge> {
  const edges: Edge[] = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % ring.length];
      if (a && b) edges.push({ a, b, box: edgeBounds(a, b), zeroLength: sameExact(a, b) });
    }
  }
  return edges;
}

function boxHolds(box: LduRect, point: Vertex): boolean {
  return point.x >= box.minX && point.x <= box.maxX && point.z >= box.minZ && point.z <= box.maxZ;
}

export class PlacedOutline {
  readonly bounds: LduRect;
  private edgeList: ReadonlyArray<Edge> | null = null;
  private doubledEdgeList: ReadonlyArray<Edge> | null = null;
  private vertexList: ReadonlyArray<Vertex> | null = null;

  private constructor(private readonly rings: ReadonlyArray<ReadonlyArray<Vertex>>) {
    this.bounds = boundsOf(rings);
  }

  private edges(): ReadonlyArray<Edge> {
    this.edgeList ??= edgesOf(this.rings);
    return this.edgeList;
  }

  private doubledEdges(): ReadonlyArray<Edge> {
    this.doubledEdgeList ??= edgesOf(this.rings.map((ring) => ring.map(doubled)));
    return this.doubledEdgeList;
  }

  private hasZeroLengthEdge(): boolean {
    return this.edges().some((edge) => edge.zeroLength);
  }

  private vertices(): ReadonlyArray<Vertex> {
    this.vertexList ??= this.rings.flat();
    return this.vertexList;
  }

  lduRings(): ReadonlyArray<OutlineRing> {
    return this.rings.map((ring) => ring.map((v): OutlinePoint => [v.x, v.z]));
  }

  static ofTrackPiece(pieceRings: ReadonlyArray<OutlineRing>, pose: Pose16): PlacedOutline {
    const origin = scaled(pose.position, BigInt(STUD_LDU) * ONE);
    return new PlacedOutline(
      pieceRings.map((ring) =>
        ring.map(([x, z]) =>
          vertexOf(
            addZeta16(origin, rotateZeta16(planValue(exactUnits(x), exactUnits(z)), pose.heading)),
          ),
        ),
      ),
    );
  }

  static onLattice(
    rings: ReadonlyArray<OutlineRing>,
    x: number,
    z: number,
    rot: Rot90,
  ): PlacedOutline {
    if (!Number.isInteger(x) || !Number.isInteger(z)) {
      throw new Error(`a lattice outline needs whole LDU, got ${x}, ${z}`);
    }
    const origin = planValue(BigInt(x) * ONE, BigInt(z) * ONE);
    const heading = (ZETA16_ORDER - QUARTER_TURN_STEPS * rot) % ZETA16_ORDER;
    return new PlacedOutline(
      rings.map((ring) =>
        ring.map(([px, pz]) =>
          vertexOf(
            addZeta16(origin, rotateZeta16(planValue(exactUnits(px), exactUnits(pz)), heading)),
          ),
        ),
      ),
    );
  }

  static ofRect(rect: LduRect): PlacedOutline {
    return new PlacedOutline([
      [
        lduCorner(rect.minX, rect.minZ),
        lduCorner(rect.maxX, rect.minZ),
        lduCorner(rect.maxX, rect.maxZ),
        lduCorner(rect.minX, rect.maxZ),
      ],
    ]);
  }

  overlaps(other: PlacedOutline): boolean {
    if (!boundsMeet(this.bounds, other.bounds)) return false;
    const theirs = other.edges();
    for (const { a, b, box } of this.edges()) {
      if (!boundsMeet(box, other.bounds)) continue;
      for (const { a: c, b: d, box: theirBox } of theirs) {
        if (!boundsMeet(box, theirBox)) continue;
        const o1 = orient(a, b, c);
        const o2 = orient(a, b, d);
        if (o1 === 0 && o2 === 0) {
          if (collinearOverlap(a, b, c, d) && dot(a, b, c, d) > 0) return true;
          continue;
        }
        if (o1 * o2 >= 0) continue;
        if (orient(c, d, a) * orient(c, d, b) < 0) return true;
      }
    }
    return this.edgeEntersInterior(other) || other.edgeEntersInterior(this);
  }

  runsAlong(from: OutlinePoint, to: OutlinePoint): boolean {
    const f = vertexOf(planValue(exactLdu(from[0]), exactLdu(from[1])));
    const t = vertexOf(planValue(exactLdu(to[0]), exactLdu(to[1])));
    const box = edgeBounds(f, t);
    for (const { a, b, box: edgeBox } of this.edges()) {
      if (!boundsMeet(box, edgeBox)) continue;
      if (orient(f, t, a) !== 0 || orient(f, t, b) !== 0) continue;
      if (collinearOverlap(f, t, a, b)) return true;
    }
    return false;
  }

  axisEdges(): ReadonlyArray<AxisEdge> {
    const edges: AxisEdge[] = [];
    for (const { a, b } of this.edges()) {
      for (const axis of ["x", "z"] as const) {
        const at = wholeLdu(a.exact, axis, axis === "x" ? a.x : a.z);
        if (at === null || wholeLdu(b.exact, axis, axis === "x" ? b.x : b.z) !== at) continue;
        const [lo, hi] = axis === "x" ? [a.z, b.z] : [a.x, b.x];
        const forward = hi > lo ? 1 : -1;
        const inside = axis === "x" ? -forward : forward;
        edges.push({
          axis,
          at,
          from: Math.min(lo, hi),
          to: Math.max(lo, hi),
          inside: inside > 0 ? 1 : -1,
        });
      }
    }
    return edges;
  }

  private onBoundary(point: Vertex, edges: ReadonlyArray<Edge>): boolean {
    for (const { a: c, b: d, box, zeroLength } of edges) {
      if (!zeroLength && !boxHolds(box, point)) continue;
      if (orient(c, d, point) === 0 && dot(c, d, c, point) >= 0 && dot(d, c, d, point) >= 0) {
        return true;
      }
    }
    return false;
  }

  private contains(point: Vertex, edges: ReadonlyArray<Edge>): boolean {
    let inside = false;
    for (const { a, b, box } of edges) {
      if (box.minZ > point.z || box.maxZ < point.z) continue;
      const aAbove = zOrder(a, point) > 0;
      const bAbove = zOrder(b, point) > 0;
      if (aAbove === bAbove) continue;
      const side = orient(a, b, point);
      if (bAbove ? side > 0 : side < 0) inside = !inside;
    }
    return inside;
  }

  private edgeEntersInterior(other: PlacedOutline): boolean {
    if (other.hasZeroLengthEdge()) return false;
    const otherVertices = other.vertices();
    for (const { a, b, box } of this.edges()) {
      if (!boundsMeet(box, other.bounds)) continue;
      const within = otherVertices.filter(
        (q) => boxHolds(box, q) && orient(a, b, q) === 0 && strictlyWithin(a, b, q),
      );
      const events =
        within.length === 0 ? [a, b] : [a, ...within, b].toSorted((p, q) => dot(a, b, p, q) * -1);
      for (let i = 0; i + 1 < events.length; i++) {
        const s = events[i];
        const t = events[i + 1];
        if (!s || !t) continue;
        const middle = sum(s, t);
        const otherDoubled = other.doubledEdges();
        if (this.onBoundary(middle, otherDoubled)) continue;
        if (this.contains(middle, otherDoubled)) return true;
      }
    }
    return false;
  }
}

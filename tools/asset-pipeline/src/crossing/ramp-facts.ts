import { STUD_LDU } from "@brr/math";
import type { CrossingRamp, PlanAxis, PlanBox } from "@brr/schema/bundle";
import type { PlacedPolygon } from "../ldraw/walk.ts";
import { CERTIFIED_RESIDUAL_LIMIT_LDU } from "../track/track-ends.ts";

type Point3 = readonly [number, number, number];
type Triangle3 = readonly [Point3, Point3, Point3];

const IDENTIFICATION_LDU = CERTIFIED_RESIDUAL_LIMIT_LDU;

const NORMAL_DIGITS = 6;
const OFFSET_DIGITS = 3;
const HALF_STUD_LDU = STUD_LDU / 2;

export interface StudSize {
  readonly radius: number;
  readonly height: number;
}

interface Plane {
  readonly normal: Point3;
  readonly triangles: Triangle3[];
  minY: number;
  maxY: number;
}

export function bundleTriangles(polygons: ReadonlyArray<PlacedPolygon>): Triangle3[] {
  const triangles: Triangle3[] = [];
  for (const { vertices } of polygons) {
    const points = vertices.map(([x, y, z]): Point3 => [x, -y + 0, -z + 0]);
    for (let i = 1; i + 1 < points.length; i++) {
      const a = points[0];
      const b = points[i];
      const c = points[i + 1];
      if (a && b && c) triangles.push([a, b, c]);
    }
  }
  return triangles;
}

export function measureStud(polygons: ReadonlyArray<PlacedPolygon>): StudSize {
  const triangles = bundleTriangles(polygons);
  let radius = 0;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const triangle of triangles) {
    for (const [x, y, z] of triangle) {
      radius = Math.max(radius, Math.hypot(x, z));
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { radius, height: maxY - minY };
}

function rounded(value: number, digits: number): string {
  const text = value.toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
}

function unitNormal([a, b, c]: Triangle3): Point3 | null {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n: Point3 = [
    (u[1] ?? 0) * (w[2] ?? 0) - (u[2] ?? 0) * (w[1] ?? 0),
    (u[2] ?? 0) * (w[0] ?? 0) - (u[0] ?? 0) * (w[2] ?? 0),
    (u[0] ?? 0) * (w[1] ?? 0) - (u[1] ?? 0) * (w[0] ?? 0),
  ];
  const length = Math.hypot(...n);
  if (length === 0) return null;
  const up = n[1] < 0 ? -1 : 1;
  return [(up * n[0]) / length, (up * n[1]) / length, (up * n[2]) / length];
}

function tiltedPlanes(triangles: ReadonlyArray<Triangle3>): Plane[] {
  const planes = new Map<string, Plane>();
  for (const triangle of triangles) {
    const normal = unitNormal(triangle);
    if (!normal) continue;
    const [nx, ny, nz] = normal;
    const horizontal = Math.hypot(nx, nz);
    if (ny <= IDENTIFICATION_LDU || horizontal <= IDENTIFICATION_LDU) continue;
    if (Math.abs(nx) > IDENTIFICATION_LDU && Math.abs(nz) > IDENTIFICATION_LDU) continue;
    const [p] = triangle;
    const offset = nx * p[0] + ny * p[1] + nz * p[2];
    const key = [
      rounded(nx, NORMAL_DIGITS),
      rounded(ny, NORMAL_DIGITS),
      rounded(nz, NORMAL_DIGITS),
      rounded(offset, OFFSET_DIGITS),
    ].join("|");
    const plane = planes.get(key) ?? {
      normal,
      triangles: [],
      minY: Number.POSITIVE_INFINITY,
      maxY: Number.NEGATIVE_INFINITY,
    };
    plane.triangles.push(triangle);
    for (const [, y] of triangle) {
      plane.minY = Math.min(plane.minY, y);
      plane.maxY = Math.max(plane.maxY, y);
    }
    planes.set(key, plane);
  }
  return [...planes.values()];
}

function sameDirection(a: Point3, b: Point3): boolean {
  return a.every((value, axis) => Math.abs(value - (b[axis] ?? 0)) <= IDENTIFICATION_LDU);
}

function planBox(triangles: ReadonlyArray<Triangle3>): PlanBox {
  let minX = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;
  for (const triangle of triangles) {
    for (const [x, , z] of triangle) {
      minX = Math.min(minX, x);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxZ = Math.max(maxZ, z);
    }
  }
  return { minX, minZ, maxX, maxZ };
}

function along(axis: PlanAxis, [x, , z]: Point3): number {
  return axis === "x" ? x : z;
}

function clipToSlab(triangle: Triangle3, low: number, high: number): ReadonlyArray<Point3> {
  let points: ReadonlyArray<Point3> = triangle;
  for (const [limit, keepBelow] of [
    [high, true],
    [low, false],
  ] as const) {
    const kept: Point3[] = [];
    for (let i = 0; i < points.length; i++) {
      const p = points[i];
      const q = points[(i + 1) % points.length];
      if (!p || !q) continue;
      const pIn = keepBelow ? p[1] <= limit : p[1] >= limit;
      const qIn = keepBelow ? q[1] <= limit : q[1] >= limit;
      if (pIn) kept.push(p);
      if (pIn !== qIn) {
        const t = (limit - p[1]) / (q[1] - p[1]);
        kept.push([p[0] + t * (q[0] - p[0]), limit, p[2] + t * (q[2] - p[2])]);
      }
    }
    points = kept;
  }
  return points;
}

function distanceToSegment(px: number, pz: number, a: Point3, b: Point3): number {
  const dx = b[0] - a[0];
  const dz = b[2] - a[2];
  const lengthSquared = dx * dx + dz * dz;
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[2]) * dz) / lengthSquared));
  return Math.hypot(px - (a[0] + t * dx), pz - (a[2] + t * dz));
}

function planDistance(px: number, pz: number, polygon: ReadonlyArray<Point3>): number {
  let inside = polygon.length >= 3;
  let sign = 0;
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (!a || !b) continue;
    nearest = Math.min(nearest, distanceToSegment(px, pz, a, b));
    const cross = (b[0] - a[0]) * (pz - a[2]) - (b[2] - a[2]) * (px - a[0]);
    const side = Math.sign(cross);
    if (side !== 0) {
      if (sign !== 0 && side !== sign) inside = false;
      sign = side;
    }
  }
  return inside && sign !== 0 ? 0 : nearest;
}

function antiStuds(
  triangles: ReadonlyArray<Triangle3>,
  footprint: PlanBox,
  undersideY: number,
  stud: StudSize,
): Array<[number, number]> {
  const top = undersideY + stud.height;
  const slab = triangles
    .filter((t) => Math.min(t[0][1], t[1][1], t[2][1]) < top)
    .map((t) => clipToSlab(t, undersideY, top))
    .filter((polygon) => polygon.length > 0);
  const found: Array<[number, number]> = [];
  for (let x = footprint.minX + HALF_STUD_LDU; x < footprint.maxX; x += STUD_LDU) {
    for (let z = footprint.minZ + HALF_STUD_LDU; z < footprint.maxZ; z += STUD_LDU) {
      let nearest = Number.POSITIVE_INFINITY;
      for (const polygon of slab) nearest = Math.min(nearest, planDistance(x, z, polygon));
      if (Math.abs(nearest - stud.radius) <= IDENTIFICATION_LDU) found.push([x + 0, z + 0]);
    }
  }
  return found;
}

export function rampFacts(
  part: string,
  title: string,
  polygons: ReadonlyArray<PlacedPolygon>,
  stud: StudSize,
): CrossingRamp | null {
  const triangles = bundleTriangles(polygons);
  if (triangles.length === 0) return null;
  const planes = tiltedPlanes(triangles);
  const highest = Math.max(...planes.map((plane) => plane.maxY));
  const tops = planes.filter((plane) => Math.abs(plane.maxY - highest) <= IDENTIFICATION_LDU);
  const [top] = tops;
  if (!top || tops.some((plane) => !sameDirection(plane.normal, top.normal))) return null;
  const [nx, , nz] = top.normal;
  const axis: PlanAxis = Math.abs(nx) > Math.abs(nz) ? "x" : "z";
  const toward = (axis === "x" ? nx : nz) > 0 ? -1 : 1;
  const footprint = planBox(triangles);
  const slope = top.triangles.flat();
  const slopeFrom = Math.min(...slope.map((p) => along(axis, p)));
  const slopeTo = Math.max(...slope.map((p) => along(axis, p)));
  const downhillBoundary =
    toward > 0
      ? axis === "x"
        ? footprint.minX
        : footprint.minZ
      : axis === "x"
        ? footprint.maxX
        : footprint.maxZ;
  const slopeDownhill = toward > 0 ? slopeFrom : slopeTo;
  if (Math.abs(slopeDownhill - downhillBoundary) > IDENTIFICATION_LDU) return null;
  const undersideY = Math.min(...triangles.flat().map(([, y]) => y));
  const studs = antiStuds(triangles, footprint, undersideY, stud);
  if (studs.length === 0) return null;
  return {
    part,
    title,
    undersideY,
    lowEdgeLdu: top.minY - undersideY,
    highEdgeLdu: top.maxY - undersideY,
    runLdu: slopeTo - slopeFrom,
    rise: { axis, toward },
    footprint,
    antiStuds: studs,
  };
}

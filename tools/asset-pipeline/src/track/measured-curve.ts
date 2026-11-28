import type { LdrawLibrary } from "../ldraw/library.ts";
import { walkPart } from "../ldraw/walk.ts";
import type { PlanPoint } from "./rail-heads.ts";

const LONG_EDGE_LDU = 8;
const PARALLEL_BISECTORS = 0.02;
const VOTE_CELLS = 1000;
const VOTE_REACH_PER_EXTENT = 20;
const VOTE_WINDOW_CELLS = 2;
const RING_GAP_LDU = 2e-4;
const RING_SPREAD_LDU = 2e-4;
const RING_MIN_VERTICES = 6;
const REFINE_PASSES = 8;
const PLAN_FLAT_LDU = 1e-3;
const RADIAL_FACE = 1e-3;
const PARALLEL_FACE = 1e-4;

export interface MeasuredEnd {
  readonly radialAngle: number;
  readonly outward: number;
  readonly faceOffsetLdu: number;
  readonly faceAcross: readonly [PlanPoint, PlanPoint];
}

export interface CurveMeasurement {
  readonly centre: PlanPoint;
  readonly innermostRingLdu: number;
  readonly outermostRingLdu: number;
  readonly rings: number;
  readonly ringVertices: number;
  readonly centrelineRadiusLdu: number;
  readonly mirroredRingPairs: number;
  readonly ends: readonly [MeasuredEnd, MeasuredEnd];
}

interface Face {
  readonly from: PlanPoint;
  readonly to: PlanPoint;
  readonly height: number;
}

interface PartGeometry {
  readonly xs: Float64Array;
  readonly zs: Float64Array;
  readonly bisectors: Float64Array;
  readonly faces: ReadonlyArray<Face>;
}

function planKey(x: number, z: number): string {
  return `${x},${z}`;
}

function verticalFace(vertices: ReadonlyArray<readonly [number, number, number]>): Face | null {
  let from: PlanPoint | null = null;
  let to: PlanPoint | null = null;
  let farthest = 0;
  for (const a of vertices) {
    for (const b of vertices) {
      const distance = Math.hypot(b[0] - a[0], b[2] - a[2]);
      if (distance > farthest) {
        farthest = distance;
        from = { x: a[0], z: a[2] };
        to = { x: b[0], z: b[2] };
      }
    }
  }
  if (from === null || to === null || farthest === 0) return null;
  const tx = (to.x - from.x) / farthest;
  const tz = (to.z - from.z) / farthest;
  const flat = vertices.every(
    ([x, , z]) => Math.abs((x - from.x) * tz - (z - from.z) * tx) <= PLAN_FLAT_LDU,
  );
  const ys = vertices.map(([, y]) => y);
  const height = Math.max(...ys) - Math.min(...ys);
  return flat && height > 0 ? { from, to, height } : null;
}

function partGeometry(library: LdrawLibrary, part: string): PartGeometry {
  const points = new Map<string, PlanPoint>();
  const edges = new Map<string, readonly [PlanPoint, PlanPoint]>();
  const faces: Face[] = [];
  const { missingFiles } = walkPart(library, `${part}.dat`, {
    polygon: ({ vertices }) => {
      vertices.forEach((vertex, index) => {
        const a = { x: vertex[0], z: vertex[2] };
        points.set(planKey(a.x, a.z), a);
        const next = vertices[(index + 1) % vertices.length];
        if (next === undefined) return;
        const b = { x: next[0], z: next[2] };
        if (Math.hypot(b.x - a.x, b.z - a.z) < LONG_EDGE_LDU) return;
        const [p, q] = planKey(a.x, a.z) < planKey(b.x, b.z) ? [a, b] : [b, a];
        edges.set(`${planKey(p.x, p.z)};${planKey(q.x, q.z)}`, [p, q]);
      });
      const face = verticalFace(vertices);
      if (face) faces.push(face);
    },
  });
  if (missingFiles.size > 0) {
    throw new Error(`${part} needs files the library lacks: ${[...missingFiles].join(", ")}`);
  }
  const all = [...points.values()];
  const bisectors = new Float64Array(edges.size * 3);
  let at = 0;
  for (const [a, b] of edges.values()) {
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    const dx = (b.x - a.x) / length;
    const dz = (b.z - a.z) / length;
    bisectors[at] = dx;
    bisectors[at + 1] = dz;
    bisectors[at + 2] = (dx * (a.x + b.x)) / 2 + (dz * (a.z + b.z)) / 2;
    at += 3;
  }
  return {
    xs: Float64Array.from(all, (p) => p.x),
    zs: Float64Array.from(all, (p) => p.z),
    bisectors,
    faces,
  };
}

function median(values: ReadonlyArray<number>): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
}

function forEachIntersection(bisectors: Float64Array, visit: (x: number, z: number) => void): void {
  const count = bisectors.length / 3;
  for (let i = 0; i < count; i++) {
    const ax = bisectors[i * 3] ?? 0;
    const az = bisectors[i * 3 + 1] ?? 0;
    const ar = bisectors[i * 3 + 2] ?? 0;
    for (let j = i + 1; j < count; j++) {
      const bx = bisectors[j * 3] ?? 0;
      const bz = bisectors[j * 3 + 1] ?? 0;
      const br = bisectors[j * 3 + 2] ?? 0;
      const det = ax * bz - az * bx;
      if (Math.abs(det) <= PARALLEL_BISECTORS) continue;
      visit((ar * bz - br * az) / det, (ax * br - bx * ar) / det);
    }
  }
}

function votedCentre(geometry: PartGeometry): PlanPoint | null {
  const { xs, zs } = geometry;
  const midX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const midZ = (Math.max(...zs) + Math.min(...zs)) / 2;
  const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs));
  const reach = extent * VOTE_REACH_PER_EXTENT;
  const cell = (2 * reach) / VOTE_CELLS;
  const votes = new Uint32Array(VOTE_CELLS * VOTE_CELLS);
  const cellOf = (x: number, z: number): number => {
    const i = Math.floor((x - midX + reach) / cell);
    const k = Math.floor((z - midZ + reach) / cell);
    return i < 0 || k < 0 || i >= VOTE_CELLS || k >= VOTE_CELLS ? -1 : i * VOTE_CELLS + k;
  };
  forEachIntersection(geometry.bisectors, (x, z) => {
    const index = cellOf(x, z);
    if (index >= 0) votes[index] = (votes[index] ?? 0) + 1;
  });
  let best = 0;
  for (let index = 1; index < votes.length; index++) {
    if ((votes[index] ?? 0) > (votes[best] ?? 0)) best = index;
  }
  if ((votes[best] ?? 0) === 0) return null;
  const peakX = midX - reach + (Math.floor(best / VOTE_CELLS) + 0.5) * cell;
  const peakZ = midZ - reach + ((best % VOTE_CELLS) + 0.5) * cell;
  const window = VOTE_WINDOW_CELLS * cell;
  const nearX: number[] = [];
  const nearZ: number[] = [];
  forEachIntersection(geometry.bisectors, (x, z) => {
    if (Math.abs(x - peakX) <= window && Math.abs(z - peakZ) <= window) {
      nearX.push(x);
      nearZ.push(z);
    }
  });
  return { x: median(nearX), z: median(nearZ) };
}

interface Rings {
  readonly members: ReadonlyArray<ReadonlyArray<number>>;
  readonly radii: ReadonlyArray<number>;
}

function axisAngle(geometry: PartGeometry, centre: PlanPoint): number {
  const { xs, zs } = geometry;
  let sumX = 0;
  let sumZ = 0;
  for (let i = 0; i < xs.length; i++) {
    sumX += (xs[i] ?? 0) - centre.x;
    sumZ += (zs[i] ?? 0) - centre.z;
  }
  return Math.atan2(sumZ, sumX);
}

function relativeAngles(geometry: PartGeometry, centre: PlanPoint): Float64Array {
  const { xs, zs } = geometry;
  const axis = axisAngle(geometry, centre);
  return Float64Array.from(xs, (x, i) => {
    const angle = Math.atan2((zs[i] ?? 0) - centre.z, x - centre.x) - axis;
    return Math.atan2(Math.sin(angle), Math.cos(angle));
  });
}

function cleanRings(geometry: PartGeometry, centre: PlanPoint): Rings {
  const { xs, zs } = geometry;
  const radius = Float64Array.from(xs, (x, i) => Math.hypot(x - centre.x, (zs[i] ?? 0) - centre.z));
  const angle = relativeAngles(geometry, centre);
  const span = Math.max(...angle) - Math.min(...angle);
  const order = [...radius.keys()].toSorted((a, b) => (radius[a] ?? 0) - (radius[b] ?? 0));
  const members: number[][] = [];
  let run: number[] = [];
  const close = (): void => {
    const radii = run.map((i) => radius[i] ?? 0);
    const angles = run.map((i) => angle[i] ?? 0);
    if (
      run.length >= RING_MIN_VERTICES &&
      Math.max(...angles) - Math.min(...angles) >= span / 2 &&
      Math.max(...radii) - Math.min(...radii) <= RING_SPREAD_LDU
    ) {
      members.push(run);
    }
    run = [];
  };
  for (const index of order) {
    const last = run.at(-1);
    if (last !== undefined && (radius[index] ?? 0) - (radius[last] ?? 0) > RING_GAP_LDU) close();
    run.push(index);
  }
  close();
  return {
    members,
    radii: members.map((ring) => ring.reduce((sum, i) => sum + (radius[i] ?? 0), 0) / ring.length),
  };
}

function sharedCentre(geometry: PartGeometry, rings: Rings, near: PlanPoint): PlanPoint {
  const { xs, zs } = geometry;
  let xx = 0;
  let xz = 0;
  let zz = 0;
  let xs2 = 0;
  let zs2 = 0;
  for (const ring of rings.members) {
    const local = ring.map((i) => {
      const x = (xs[i] ?? 0) - near.x;
      const z = (zs[i] ?? 0) - near.z;
      return { x, z, s: x * x + z * z };
    });
    const meanX = local.reduce((sum, p) => sum + p.x, 0) / local.length;
    const meanZ = local.reduce((sum, p) => sum + p.z, 0) / local.length;
    const meanS = local.reduce((sum, p) => sum + p.s, 0) / local.length;
    for (const p of local) {
      const x = p.x - meanX;
      const z = p.z - meanZ;
      const s = p.s - meanS;
      xx += x * x;
      xz += x * z;
      zz += z * z;
      xs2 += x * s;
      zs2 += z * s;
    }
  }
  const det = xx * zz - xz * xz;
  return {
    x: near.x + (xs2 * zz - zs2 * xz) / det / 2,
    z: near.z + (zs2 * xx - xs2 * xz) / det / 2,
  };
}

function mirroredRadius(radii: ReadonlyArray<number>): { radius: number; pairs: number } {
  const midpoints: number[] = [];
  radii.forEach((a, i) => {
    for (const b of radii.slice(i + 1)) midpoints.push((a + b) / 2);
  });
  midpoints.sort((a, b) => a - b);
  let best = { from: 0, to: 0 };
  let from = 0;
  for (let to = 0; to < midpoints.length; to++) {
    while ((midpoints[to] ?? 0) - (midpoints[from] ?? 0) > RING_GAP_LDU) from++;
    if (to - from > best.to - best.from) best = { from, to };
  }
  return {
    radius: median(midpoints.slice(best.from, best.to + 1)),
    pairs: best.to - best.from + 1,
  };
}

interface RadialFace {
  readonly angle: number;
  readonly direction: number;
  readonly offset: number;
  readonly weight: number;
  readonly face: Face;
}

function radialFaces(faces: ReadonlyArray<Face>, centre: PlanPoint, axis: number): RadialFace[] {
  return faces.flatMap((face) => {
    const midX = (face.from.x + face.to.x) / 2 - centre.x;
    const midZ = (face.from.z + face.to.z) / 2 - centre.z;
    const distance = Math.hypot(midX, midZ);
    const length = Math.hypot(face.to.x - face.from.x, face.to.z - face.from.z);
    let tx = (face.to.x - face.from.x) / length;
    let tz = (face.to.z - face.from.z) / length;
    if (tx * midX + tz * midZ < 0) {
      tx = -tx;
      tz = -tz;
    }
    const across = (tx * midZ - tz * midX) / distance;
    if (Math.abs(across) > RADIAL_FACE) return [];
    const angle = Math.atan2(midZ, midX) - axis;
    return [
      {
        angle: Math.atan2(Math.sin(angle), Math.cos(angle)),
        direction: Math.atan2(tz, tx),
        offset: tx * midZ - tz * midX,
        weight: length * face.height,
        face,
      },
    ];
  });
}

function wrapped(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function measuredEnd(faces: ReadonlyArray<RadialFace>, extreme: RadialFace, sign: 1 | -1) {
  const parallel = faces.filter(
    (face) => Math.abs(wrapped(face.direction - extreme.direction)) <= PARALLEL_FACE,
  );
  const weight = parallel.reduce((sum, face) => sum + face.weight, 0);
  const direction =
    extreme.direction +
    parallel.reduce(
      (sum, face) => sum + wrapped(face.direction - extreme.direction) * face.weight,
      0,
    ) /
      weight;
  const main = parallel.reduce((a, b) => (b.weight > a.weight ? b : a));
  return {
    radialAngle: direction,
    outward: wrapped(direction + (sign * Math.PI) / 2),
    faceOffsetLdu: -sign * main.offset,
    faceAcross: [main.face.from, main.face.to] as const,
  };
}

export function measureCurve(library: LdrawLibrary, part: string): CurveMeasurement | null {
  const geometry = partGeometry(library, part);
  const voted = votedCentre(geometry);
  if (voted === null) return null;
  let centre = voted;
  let rings = cleanRings(geometry, centre);
  for (let pass = 0; pass < REFINE_PASSES && rings.members.length > 1; pass++) {
    centre = sharedCentre(geometry, rings, centre);
    rings = cleanRings(geometry, centre);
  }
  if (rings.members.length < 2) return null;
  const faces = radialFaces(geometry.faces, centre, axisAngle(geometry, centre));
  if (faces.length === 0) return null;
  const low = faces.reduce((a, b) => (b.angle < a.angle ? b : a));
  const high = faces.reduce((a, b) => (b.angle > a.angle ? b : a));
  const { radius, pairs } = mirroredRadius(rings.radii);
  return {
    centre,
    innermostRingLdu: Math.min(...rings.radii),
    outermostRingLdu: Math.max(...rings.radii),
    rings: rings.members.length,
    ringVertices: rings.members.reduce((sum, ring) => sum + ring.length, 0),
    centrelineRadiusLdu: radius,
    mirroredRingPairs: pairs,
    ends: [measuredEnd(faces, low, -1), measuredEnd(faces, high, 1)],
  };
}

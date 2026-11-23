export const SOLID_MATRIX_FLOATS = 12;
export const SOLID_BOX_FLOATS = 6;
export const SOLID_TRIANGLE_FLOATS = 9;

export interface StudSolid {
  readonly box: Float64Array;
  readonly triangles: Float64Array;
}

export interface PartSolid {
  readonly box: Float64Array;
  readonly triangles: Float64Array;
  readonly bodyTriangles: number;
  readonly studFrames: Float64Array;
  readonly studPrimitive: Uint8Array;
  readonly primitives: ReadonlyArray<StudSolid>;
}

const ROW = 4;
const AXES = 3;
const MAX = 3;
const INSIDE = 1;
const OUTSIDE = 0;
const ON_SURFACE = -1;
const DEGENERATE = -2;
const INITIAL_TRIANGLES = 256;
const GROWTH = 2;
const PROBE_RAYS = Float64Array.of(
  0.2838293811,
  0.9182612753,
  0.2763519473,
  -0.4213480125,
  0.8137529414,
  0.4002183071,
  0.3518520962,
  0.7253791128,
  -0.5915720381,
);

const sat = new Float64Array(24);
const SAT_CA = 0;
const SAT_EA = 3;
const SAT_CB = 12;
const SAT_EB = 15;
const inverseA = new Float64Array(SOLID_MATRIX_FLOATS);
const inverseB = new Float64Array(SOLID_MATRIX_FLOATS);
const bToA = new Float64Array(SOLID_MATRIX_FLOATS);
const aToB = new Float64Array(SOLID_MATRIX_FLOATS);
const bBoxInA = new Float64Array(SOLID_BOX_FLOATS);
const point = new Float64Array(AXES);
const probe = new Float64Array(AXES);
const probeFrom = new Float64Array(AXES);
const probeDirection = new Float64Array(AXES);
const nearPoint = new Float64Array(AXES);
const faceCentre = new Float64Array(AXES);
const studPoint = new Float64Array(AXES);
let movedB: Float64Array = new Float64Array(INITIAL_TRIANGLES * SOLID_TRIANGLE_FLOATS);
let keptA: Int32Array = new Int32Array(INITIAL_TRIANGLES);
let movedFrom: Int32Array = new Int32Array(INITIAL_TRIANGLES);

function grownFloats(array: Float64Array, needed: number): Float64Array {
  return needed <= array.length ? array : new Float64Array(Math.max(needed, array.length * GROWTH));
}

function grownInts(array: Int32Array, needed: number): Int32Array {
  return needed <= array.length ? array : new Int32Array(Math.max(needed, array.length * GROWTH));
}

export function invertAffine(m: ArrayLike<number>, at: number, out: Float64Array): boolean {
  const a = m[at] ?? 0;
  const b = m[at + 1] ?? 0;
  const c = m[at + 2] ?? 0;
  const d = m[at + 4] ?? 0;
  const e = m[at + 5] ?? 0;
  const f = m[at + 6] ?? 0;
  const g = m[at + 8] ?? 0;
  const h = m[at + 9] ?? 0;
  const k = m[at + 10] ?? 0;
  const ca = e * k - f * h;
  const cb = f * g - d * k;
  const cc = d * h - e * g;
  const det = a * ca + b * cb + c * cc;
  if (det === 0) return false;
  const tx = m[at + 3] ?? 0;
  const ty = m[at + 7] ?? 0;
  const tz = m[at + 11] ?? 0;
  out[0] = ca / det;
  out[1] = (c * h - b * k) / det;
  out[2] = (b * f - c * e) / det;
  out[4] = cb / det;
  out[5] = (a * k - c * g) / det;
  out[6] = (c * d - a * f) / det;
  out[8] = cc / det;
  out[9] = (b * g - a * h) / det;
  out[10] = (a * e - b * d) / det;
  out[3] = -(out[0] * tx + out[1] * ty + out[2] * tz);
  out[7] = -(out[4] * tx + out[5] * ty + out[6] * tz);
  out[11] = -(out[8] * tx + out[9] * ty + out[10] * tz);
  return true;
}

export function composeAffine(
  outer: ArrayLike<number>,
  outerAt: number,
  inner: ArrayLike<number>,
  innerAt: number,
  out: Float64Array,
  outAt: number,
): void {
  for (let row = 0; row < AXES; row++) {
    const r0 = outer[outerAt + row * ROW] ?? 0;
    const r1 = outer[outerAt + row * ROW + 1] ?? 0;
    const r2 = outer[outerAt + row * ROW + 2] ?? 0;
    for (let col = 0; col < ROW; col++) {
      out[outAt + row * ROW + col] =
        r0 * (inner[innerAt + col] ?? 0) +
        r1 * (inner[innerAt + ROW + col] ?? 0) +
        r2 * (inner[innerAt + 2 * ROW + col] ?? 0) +
        (col === MAX ? (outer[outerAt + row * ROW + MAX] ?? 0) : 0);
    }
  }
}

function transformPoint(
  m: ArrayLike<number>,
  at: number,
  source: ArrayLike<number>,
  sourceAt: number,
  out: Float64Array,
): void {
  const x = source[sourceAt] ?? 0;
  const y = source[sourceAt + 1] ?? 0;
  const z = source[sourceAt + 2] ?? 0;
  for (let row = 0; row < AXES; row++) {
    const r = at + row * ROW;
    out[row] = (m[r] ?? 0) * x + (m[r + 1] ?? 0) * y + (m[r + 2] ?? 0) * z + (m[r + MAX] ?? 0);
  }
}

export function posedBoxBounds(
  m: ArrayLike<number>,
  at: number,
  box: ArrayLike<number>,
  boxAt: number,
  out: Float64Array,
  outAt: number,
): void {
  for (let row = 0; row < AXES; row++) {
    const r = at + row * ROW;
    let lo = m[r + MAX] ?? 0;
    let hi = lo;
    for (let k = 0; k < AXES; k++) {
      const coefficient = m[r + k] ?? 0;
      const a = coefficient * (box[boxAt + k] ?? 0);
      const b = coefficient * (box[boxAt + MAX + k] ?? 0);
      lo += Math.min(a, b);
      hi += Math.max(a, b);
    }
    out[outAt + row] = lo;
    out[outAt + MAX + row] = hi;
  }
}

function writeParallelepiped(
  m: ArrayLike<number>,
  at: number,
  box: ArrayLike<number>,
  boxAt: number,
  centre: number,
  edges: number,
): void {
  const cx = ((box[boxAt] ?? 0) + (box[boxAt + MAX] ?? 0)) / 2;
  const cy = ((box[boxAt + 1] ?? 0) + (box[boxAt + MAX + 1] ?? 0)) / 2;
  const cz = ((box[boxAt + 2] ?? 0) + (box[boxAt + MAX + 2] ?? 0)) / 2;
  for (let row = 0; row < AXES; row++) {
    const r = at + row * ROW;
    sat[centre + row] =
      (m[r] ?? 0) * cx + (m[r + 1] ?? 0) * cy + (m[r + 2] ?? 0) * cz + (m[r + MAX] ?? 0);
  }
  for (let k = 0; k < AXES; k++) {
    const half = ((box[boxAt + MAX + k] ?? 0) - (box[boxAt + k] ?? 0)) / 2;
    for (let row = 0; row < AXES; row++) {
      sat[edges + k * AXES + row] = (m[at + row * ROW + k] ?? 0) * half;
    }
  }
}

function separatedOn(lx: number, ly: number, lz: number): boolean {
  if (lx === 0 && ly === 0 && lz === 0) return false;
  let radii = 0;
  for (let k = 0; k < AXES; k++) {
    const a = SAT_EA + k * AXES;
    const b = SAT_EB + k * AXES;
    radii += Math.abs((sat[a] ?? 0) * lx + (sat[a + 1] ?? 0) * ly + (sat[a + 2] ?? 0) * lz);
    radii += Math.abs((sat[b] ?? 0) * lx + (sat[b + 1] ?? 0) * ly + (sat[b + 2] ?? 0) * lz);
  }
  const dx = (sat[SAT_CB] ?? 0) - (sat[SAT_CA] ?? 0);
  const dy = (sat[SAT_CB + 1] ?? 0) - (sat[SAT_CA + 1] ?? 0);
  const dz = (sat[SAT_CB + 2] ?? 0) - (sat[SAT_CA + 2] ?? 0);
  return Math.abs(dx * lx + dy * ly + dz * lz) >= radii;
}

function separatedOnCross(p: number, q: number): boolean {
  const px = sat[p] ?? 0;
  const py = sat[p + 1] ?? 0;
  const pz = sat[p + 2] ?? 0;
  const qx = sat[q] ?? 0;
  const qy = sat[q + 1] ?? 0;
  const qz = sat[q + 2] ?? 0;
  return separatedOn(py * qz - pz * qy, pz * qx - px * qz, px * qy - py * qx);
}

function separatedOnFaces(edges: number): boolean {
  return (
    separatedOnCross(edges + AXES, edges + 2 * AXES) ||
    separatedOnCross(edges + 2 * AXES, edges) ||
    separatedOnCross(edges, edges + AXES)
  );
}

export function boxesCross(
  ma: ArrayLike<number>,
  maAt: number,
  boxA: ArrayLike<number>,
  boxAAt: number,
  mb: ArrayLike<number>,
  mbAt: number,
  boxB: ArrayLike<number>,
  boxBAt: number,
): boolean {
  writeParallelepiped(ma, maAt, boxA, boxAAt, SAT_CA, SAT_EA);
  writeParallelepiped(mb, mbAt, boxB, boxBAt, SAT_CB, SAT_EB);
  if (separatedOnFaces(SAT_EA) || separatedOnFaces(SAT_EB)) return false;
  for (let i = 0; i < AXES; i++) {
    for (let j = 0; j < AXES; j++) {
      if (separatedOnCross(SAT_EA + i * AXES, SAT_EB + j * AXES)) return false;
    }
  }
  return true;
}

function straddles(a: number, b: number, c: number): boolean {
  return (a > 0 || b > 0 || c > 0) && (a < 0 || b < 0 || c < 0);
}

const span = new Float64Array(2);
const SPAN_LO = 0;
const SPAN_HI = 1;

function crossingSpan(
  t0: number,
  t1: number,
  t2: number,
  d0: number,
  d1: number,
  d2: number,
): void {
  span[SPAN_LO] = Number.POSITIVE_INFINITY;
  span[SPAN_HI] = Number.NEGATIVE_INFINITY;
  spanEdge(t0, d0, t1, d1);
  spanEdge(t1, d1, t2, d2);
  spanEdge(t2, d2, t0, d0);
}

function spanEdge(ta: number, da: number, tb: number, db: number): void {
  if (da === 0) {
    span[SPAN_LO] = Math.min(span[SPAN_LO] ?? 0, ta);
    span[SPAN_HI] = Math.max(span[SPAN_HI] ?? 0, ta);
  }
  if ((da < 0 && db > 0) || (da > 0 && db < 0)) {
    const t = ta + ((tb - ta) * da) / (da - db);
    span[SPAN_LO] = Math.min(span[SPAN_LO] ?? 0, t);
    span[SPAN_HI] = Math.max(span[SPAN_HI] ?? 0, t);
  }
}

function trianglesCross(
  p: ArrayLike<number>,
  pAt: number,
  q: ArrayLike<number>,
  qAt: number,
): boolean {
  const p0x = p[pAt] ?? 0;
  const p0y = p[pAt + 1] ?? 0;
  const p0z = p[pAt + 2] ?? 0;
  const p1x = p[pAt + 3] ?? 0;
  const p1y = p[pAt + 4] ?? 0;
  const p1z = p[pAt + 5] ?? 0;
  const p2x = p[pAt + 6] ?? 0;
  const p2y = p[pAt + 7] ?? 0;
  const p2z = p[pAt + 8] ?? 0;
  const q0x = q[qAt] ?? 0;
  const q0y = q[qAt + 1] ?? 0;
  const q0z = q[qAt + 2] ?? 0;
  const q1x = q[qAt + 3] ?? 0;
  const q1y = q[qAt + 4] ?? 0;
  const q1z = q[qAt + 5] ?? 0;
  const q2x = q[qAt + 6] ?? 0;
  const q2y = q[qAt + 7] ?? 0;
  const q2z = q[qAt + 8] ?? 0;
  const ax = q1x - q0x;
  const ay = q1y - q0y;
  const az = q1z - q0z;
  const bx = q2x - q0x;
  const by = q2y - q0y;
  const bz = q2z - q0z;
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const dp0 = nx * (p0x - q0x) + ny * (p0y - q0y) + nz * (p0z - q0z);
  const dp1 = nx * (p1x - q0x) + ny * (p1y - q0y) + nz * (p1z - q0z);
  const dp2 = nx * (p2x - q0x) + ny * (p2y - q0y) + nz * (p2z - q0z);
  if (!straddles(dp0, dp1, dp2)) return false;
  const cx = p1x - p0x;
  const cy = p1y - p0y;
  const cz = p1z - p0z;
  const ex = p2x - p0x;
  const ey = p2y - p0y;
  const ez = p2z - p0z;
  const mx = cy * ez - cz * ey;
  const my = cz * ex - cx * ez;
  const mz = cx * ey - cy * ex;
  const dq0 = mx * (q0x - p0x) + my * (q0y - p0y) + mz * (q0z - p0z);
  const dq1 = mx * (q1x - p0x) + my * (q1y - p0y) + mz * (q1z - p0z);
  const dq2 = mx * (q2x - p0x) + my * (q2y - p0y) + mz * (q2z - p0z);
  if (!straddles(dq0, dq1, dq2)) return false;
  const lx = my * nz - mz * ny;
  const ly = mz * nx - mx * nz;
  const lz = mx * ny - my * nx;
  crossingSpan(
    lx * p0x + ly * p0y + lz * p0z,
    lx * p1x + ly * p1y + lz * p1z,
    lx * p2x + ly * p2y + lz * p2z,
    dp0,
    dp1,
    dp2,
  );
  const pLo = span[SPAN_LO] ?? 0;
  const pHi = span[SPAN_HI] ?? 0;
  crossingSpan(
    lx * q0x + ly * q0y + lz * q0z,
    lx * q1x + ly * q1y + lz * q1z,
    lx * q2x + ly * q2y + lz * q2z,
    dq0,
    dq1,
    dq2,
  );
  return Math.max(pLo, span[SPAN_LO] ?? 0) < Math.min(pHi, span[SPAN_HI] ?? 0);
}

function rayCrossings(
  triangles: Float64Array,
  from: number,
  to: number,
  p: Float64Array,
  ray: number,
): number {
  const px = p[0] ?? 0;
  const py = p[1] ?? 0;
  const pz = p[2] ?? 0;
  const dx = PROBE_RAYS[ray] ?? 0;
  const dy = PROBE_RAYS[ray + 1] ?? 0;
  const dz = PROBE_RAYS[ray + 2] ?? 0;
  let count = 0;
  for (let t = from; t < to; t++) {
    const o = t * SOLID_TRIANGLE_FLOATS;
    const v0x = triangles[o] ?? 0;
    const v0y = triangles[o + 1] ?? 0;
    const v0z = triangles[o + 2] ?? 0;
    const e1x = (triangles[o + 3] ?? 0) - v0x;
    const e1y = (triangles[o + 4] ?? 0) - v0y;
    const e1z = (triangles[o + 5] ?? 0) - v0z;
    const e2x = (triangles[o + 6] ?? 0) - v0x;
    const e2y = (triangles[o + 7] ?? 0) - v0y;
    const e2z = (triangles[o + 8] ?? 0) - v0z;
    const hx = dy * e2z - dz * e2y;
    const hy = dz * e2x - dx * e2z;
    const hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    const sx = px - v0x;
    const sy = py - v0y;
    const sz = pz - v0z;
    if (det === 0) {
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      if (nx === 0 && ny === 0 && nz === 0) continue;
      if (nx * sx + ny * sy + nz * sz === 0) return DEGENERATE;
      continue;
    }
    const u = (sx * hx + sy * hy + sz * hz) / det;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) / det;
    if (v < 0 || u + v > 1) continue;
    const along = (e2x * qx + e2y * qy + e2z * qz) / det;
    if (along < 0) continue;
    if (along === 0) return ON_SURFACE;
    if (u === 0 || v === 0 || u + v === 1) return DEGENERATE;
    count++;
  }
  return count;
}

function parity(triangles: Float64Array, from: number, to: number, p: Float64Array): number {
  for (let ray = 0; ray < PROBE_RAYS.length; ray += AXES) {
    const crossings = rayCrossings(triangles, from, to, p, ray);
    if (crossings === ON_SURFACE) return ON_SURFACE;
    if (crossings === DEGENERATE) continue;
    return crossings % 2 === 1 ? INSIDE : OUTSIDE;
  }
  return OUTSIDE;
}

function within(box: ArrayLike<number>, p: Float64Array): boolean {
  for (let axis = 0; axis < AXES; axis++) {
    const value = p[axis] ?? 0;
    if (value < (box[axis] ?? 0) || value > (box[MAX + axis] ?? 0)) return false;
  }
  return true;
}

function placeIn(solid: PartSolid, p: Float64Array): number {
  if (!within(solid.box, p)) return OUTSIDE;
  let place = parity(solid.triangles, 0, solid.bodyTriangles, p);
  if (place === INSIDE) return INSIDE;
  for (let s = 0; s < solid.studPrimitive.length; s++) {
    const primitive = solid.primitives[solid.studPrimitive[s] ?? 0];
    if (!primitive) continue;
    transformPoint(solid.studFrames, s * SOLID_MATRIX_FLOATS, p, 0, studPoint);
    if (!within(primitive.box, studPoint)) continue;
    const count = primitive.triangles.length / SOLID_TRIANGLE_FLOATS;
    const inStud = parity(primitive.triangles, 0, count, studPoint);
    if (inStud === INSIDE) return INSIDE;
    if (inStud === ON_SURFACE) place = ON_SURFACE;
  }
  return place;
}

function nearestAlong(
  triangles: Float64Array,
  skip: number,
  p: Float64Array,
  d: Float64Array,
): number {
  const px = p[0] ?? 0;
  const py = p[1] ?? 0;
  const pz = p[2] ?? 0;
  const dx = d[0] ?? 0;
  const dy = d[1] ?? 0;
  const dz = d[2] ?? 0;
  let nearest = Number.POSITIVE_INFINITY;
  const count = triangles.length / SOLID_TRIANGLE_FLOATS;
  for (let t = 0; t < count; t++) {
    if (t === skip) continue;
    const o = t * SOLID_TRIANGLE_FLOATS;
    const v0x = triangles[o] ?? 0;
    const v0y = triangles[o + 1] ?? 0;
    const v0z = triangles[o + 2] ?? 0;
    const e1x = (triangles[o + 3] ?? 0) - v0x;
    const e1y = (triangles[o + 4] ?? 0) - v0y;
    const e1z = (triangles[o + 5] ?? 0) - v0z;
    const e2x = (triangles[o + 6] ?? 0) - v0x;
    const e2y = (triangles[o + 7] ?? 0) - v0y;
    const e2z = (triangles[o + 8] ?? 0) - v0z;
    const hx = dy * e2z - dz * e2y;
    const hy = dz * e2x - dx * e2z;
    const hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (det === 0) continue;
    const sx = px - v0x;
    const sy = py - v0y;
    const sz = pz - v0z;
    const u = (sx * hx + sy * hy + sz * hz) / det;
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y;
    const qy = sz * e1x - sx * e1z;
    const qz = sx * e1y - sy * e1x;
    const v = (dx * qx + dy * qy + dz * qz) / det;
    if (v < 0 || u + v > 1) continue;
    const along = (e2x * qx + e2y * qy + e2z * qz) / det;
    if (along > 0) nearest = Math.min(nearest, along);
  }
  return nearest;
}

const insideProbes = new WeakMap<PartSolid, Float64Array>();
const UNPROBED = Number.POSITIVE_INFINITY;
const NO_PROBE = Number.NaN;

function insideNear(solid: PartSolid, t: number, out: Float64Array): boolean {
  let probes = insideProbes.get(solid);
  if (!probes) {
    probes = new Float64Array((solid.triangles.length / SOLID_TRIANGLE_FLOATS) * AXES);
    probes.fill(UNPROBED);
    insideProbes.set(solid, probes);
  }
  const at = t * AXES;
  if (probes[at] === UNPROBED) {
    if (probeInside(solid, t, probe)) probes.set(probe, at);
    else probes[at] = NO_PROBE;
  }
  if (Number.isNaN(probes[at])) return false;
  out[0] = probes[at] ?? 0;
  out[1] = probes[at + 1] ?? 0;
  out[2] = probes[at + 2] ?? 0;
  return true;
}

function probeInside(solid: PartSolid, t: number, out: Float64Array): boolean {
  const triangles = solid.triangles;
  const o = t * SOLID_TRIANGLE_FLOATS;
  writeCentroid(triangles, o, probeFrom);
  const e1x = (triangles[o + 3] ?? 0) - (triangles[o] ?? 0);
  const e1y = (triangles[o + 4] ?? 0) - (triangles[o + 1] ?? 0);
  const e1z = (triangles[o + 5] ?? 0) - (triangles[o + 2] ?? 0);
  const e2x = (triangles[o + 6] ?? 0) - (triangles[o] ?? 0);
  const e2y = (triangles[o + 7] ?? 0) - (triangles[o + 1] ?? 0);
  const e2z = (triangles[o + 8] ?? 0) - (triangles[o + 2] ?? 0);
  for (let side = 1; side >= -1; side -= 2) {
    probeDirection[0] = side * (e1y * e2z - e1z * e2y);
    probeDirection[1] = side * (e1z * e2x - e1x * e2z);
    probeDirection[2] = side * (e1x * e2y - e1y * e2x);
    const along = nearestAlong(triangles, t, probeFrom, probeDirection);
    if (!Number.isFinite(along)) continue;
    for (let axis = 0; axis < AXES; axis++) {
      out[axis] = (probeFrom[axis] ?? 0) + ((probeDirection[axis] ?? 0) * along) / 2;
    }
    if (placeIn(solid, out) === INSIDE) return true;
  }
  return false;
}

function crossesFromFace(
  own: PartSolid,
  t: number,
  other: PartSolid,
  toOther: Float64Array,
  centre: Float64Array,
): boolean {
  const place = placeIn(other, centre);
  if (place === INSIDE) return true;
  if (place !== ON_SURFACE || !insideNear(own, t, nearPoint)) return false;
  transformPoint(toOther, 0, nearPoint, 0, point);
  return placeIn(other, point) === INSIDE;
}

function triangleMeetsBox(
  triangles: Float64Array,
  o: number,
  box: ArrayLike<number>,
  boxAt: number,
): boolean {
  for (let axis = 0; axis < AXES; axis++) {
    const a = triangles[o + axis] ?? 0;
    const b = triangles[o + AXES + axis] ?? 0;
    const c = triangles[o + 2 * AXES + axis] ?? 0;
    if (Math.max(a, b, c) < (box[boxAt + axis] ?? 0)) return false;
    if (Math.min(a, b, c) > (box[boxAt + MAX + axis] ?? 0)) return false;
  }
  return true;
}

function triangleBoundsMeet(p: Float64Array, pAt: number, q: Float64Array, qAt: number): boolean {
  for (let axis = 0; axis < AXES; axis++) {
    const pLo = Math.min(p[pAt + axis] ?? 0, p[pAt + 3 + axis] ?? 0, p[pAt + 6 + axis] ?? 0);
    const pHi = Math.max(p[pAt + axis] ?? 0, p[pAt + 3 + axis] ?? 0, p[pAt + 6 + axis] ?? 0);
    const qLo = Math.min(q[qAt + axis] ?? 0, q[qAt + 3 + axis] ?? 0, q[qAt + 6 + axis] ?? 0);
    const qHi = Math.max(q[qAt + axis] ?? 0, q[qAt + 3 + axis] ?? 0, q[qAt + 6 + axis] ?? 0);
    if (pHi <= qLo || qHi <= pLo) return false;
  }
  return true;
}

function writeCentroid(triangles: Float64Array, o: number, out: Float64Array): void {
  for (let axis = 0; axis < AXES; axis++) {
    out[axis] =
      ((triangles[o + axis] ?? 0) +
        (triangles[o + AXES + axis] ?? 0) +
        (triangles[o + 2 * AXES + axis] ?? 0)) /
      AXES;
  }
}

export function solidsCross(
  a: PartSolid,
  ma: ArrayLike<number>,
  maAt: number,
  b: PartSolid,
  mb: ArrayLike<number>,
  mbAt: number,
): boolean {
  if (!invertAffine(ma, maAt, inverseA) || !invertAffine(mb, mbAt, inverseB)) return false;
  composeAffine(inverseA, 0, mb, mbAt, bToA, 0);
  composeAffine(inverseB, 0, ma, maAt, aToB, 0);
  posedBoxBounds(bToA, 0, b.box, 0, bBoxInA, 0);
  const aCount = a.triangles.length / SOLID_TRIANGLE_FLOATS;
  keptA = grownInts(keptA, aCount);
  let kept = 0;
  for (let t = 0; t < aCount; t++) {
    if (triangleMeetsBox(a.triangles, t * SOLID_TRIANGLE_FLOATS, bBoxInA, 0)) keptA[kept++] = t;
  }
  const bCount = b.triangles.length / SOLID_TRIANGLE_FLOATS;
  movedB = grownFloats(movedB, bCount * SOLID_TRIANGLE_FLOATS);
  movedFrom = grownInts(movedFrom, bCount);
  let moved = 0;
  for (let t = 0; t < bCount; t++) {
    const from = t * SOLID_TRIANGLE_FLOATS;
    const to = moved * SOLID_TRIANGLE_FLOATS;
    for (let v = 0; v < AXES; v++) {
      transformPoint(bToA, 0, b.triangles, from + v * AXES, point);
      movedB.set(point, to + v * AXES);
    }
    if (triangleMeetsBox(movedB, to, a.box, 0)) movedFrom[moved++] = t;
  }
  for (let i = 0; i < kept; i++) {
    const pAt = (keptA[i] ?? 0) * SOLID_TRIANGLE_FLOATS;
    for (let j = 0; j < moved; j++) {
      const qAt = j * SOLID_TRIANGLE_FLOATS;
      if (!triangleBoundsMeet(a.triangles, pAt, movedB, qAt)) continue;
      if (trianglesCross(a.triangles, pAt, movedB, qAt)) return true;
    }
  }
  for (let j = 0; j < moved; j++) {
    writeCentroid(movedB, j * SOLID_TRIANGLE_FLOATS, faceCentre);
    if (crossesFromFace(b, movedFrom[j] ?? 0, a, bToA, faceCentre)) return true;
  }
  for (let i = 0; i < kept; i++) {
    const t = keptA[i] ?? 0;
    writeCentroid(a.triangles, t * SOLID_TRIANGLE_FLOATS, point);
    transformPoint(aToB, 0, point, 0, faceCentre);
    if (crossesFromFace(a, t, b, aToB, faceCentre)) return true;
  }
  return false;
}

import { PLAN_TRIANGLE_FLOATS, REPRESENTATION_EPSILON_LDU } from "./cell-raster.ts";

export interface PlanBox {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

function projectOnto(
  ax: number,
  az: number,
  tri: Float64Array,
  o: number,
  out: Float64Array,
  slot: number,
): void {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < 3; k++) {
    const p = ax * (tri[o + 2 * k] ?? 0) + az * (tri[o + 2 * k + 1] ?? 0);
    if (p < lo) lo = p;
    if (p > hi) hi = p;
  }
  out[slot] = lo;
  out[slot + 1] = hi;
}

const span = new Float64Array(4);

function separatedOnEdgeNormals(
  a: Float64Array,
  oa: number,
  b: Float64Array,
  ob: number,
  edgesOf: Float64Array,
  oe: number,
): boolean {
  for (let k = 0; k < 3; k++) {
    const next = (k + 1) % 3;
    const ex = (edgesOf[oe + 2 * next] ?? 0) - (edgesOf[oe + 2 * k] ?? 0);
    const ez = (edgesOf[oe + 2 * next + 1] ?? 0) - (edgesOf[oe + 2 * k + 1] ?? 0);
    const length = Math.hypot(ex, ez);
    if (length === 0) continue;
    projectOnto(-ez, ex, a, oa, span, 0);
    projectOnto(-ez, ex, b, ob, span, 2);
    const depth = Math.min(span[1] ?? 0, span[3] ?? 0) - Math.max(span[0] ?? 0, span[2] ?? 0);
    if (depth <= REPRESENTATION_EPSILON_LDU * length) return true;
  }
  return false;
}

function trianglesOverlap(a: Float64Array, oa: number, b: Float64Array, ob: number): boolean {
  return (
    !separatedOnEdgeNormals(a, oa, b, ob, a, oa) && !separatedOnEdgeNormals(a, oa, b, ob, b, ob)
  );
}

function triangleBox(tri: Float64Array, o: number, out: Float64Array): void {
  out[0] = Math.min(tri[o] ?? 0, tri[o + 2] ?? 0, tri[o + 4] ?? 0);
  out[1] = Math.min(tri[o + 1] ?? 0, tri[o + 3] ?? 0, tri[o + 5] ?? 0);
  out[2] = Math.max(tri[o] ?? 0, tri[o + 2] ?? 0, tri[o + 4] ?? 0);
  out[3] = Math.max(tri[o + 1] ?? 0, tri[o + 3] ?? 0, tri[o + 5] ?? 0);
}

function inside(box: PlanBox, tri: Float64Array, o: number, scratch: Float64Array): boolean {
  triangleBox(tri, o, scratch);
  return (
    (scratch[0] ?? 0) < box.maxX &&
    (scratch[2] ?? 0) > box.minX &&
    (scratch[1] ?? 0) < box.maxZ &&
    (scratch[3] ?? 0) > box.minZ
  );
}

function trianglesIn(triangles: Float64Array, box: PlanBox): number[] {
  const scratch = new Float64Array(4);
  const offsets: number[] = [];
  for (let o = 0; o + PLAN_TRIANGLE_FLOATS <= triangles.length; o += PLAN_TRIANGLE_FLOATS) {
    if (inside(box, triangles, o, scratch)) offsets.push(o);
  }
  return offsets;
}

export function planTrianglesOverlap(a: Float64Array, b: Float64Array, within: PlanBox): boolean {
  const left = trianglesIn(a, within);
  const right = trianglesIn(b, within);
  const boxA = new Float64Array(4);
  const boxB = new Float64Array(4);
  for (const oa of left) {
    triangleBox(a, oa, boxA);
    for (const ob of right) {
      triangleBox(b, ob, boxB);
      if ((boxA[0] ?? 0) >= (boxB[2] ?? 0) || (boxB[0] ?? 0) >= (boxA[2] ?? 0)) continue;
      if ((boxA[1] ?? 0) >= (boxB[3] ?? 0) || (boxB[1] ?? 0) >= (boxA[3] ?? 0)) continue;
      if (trianglesOverlap(a, oa, b, ob)) return true;
    }
  }
  return false;
}

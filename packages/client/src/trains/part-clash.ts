import {
  SOLID_BOX_FLOATS,
  SOLID_MATRIX_FLOATS,
  boxesCross,
  composeAffine,
  posedBoxBounds,
  solidsCross,
} from "@brr/domain";
import { isRot90, rot90Cos, rot90Sin } from "@brr/math";
import type { IPartSolids } from "../catalog/part-solids.ts";
import type { Placeable } from "../edit/placeable.ts";

const MAX = 3;
const AXES = 3;
const GROWTH = 2;
export const NO_CLASH_PART = -1;
export const NO_SKIP: ReadonlySet<number> = new Set();

export type ClashKind = "clear" | "clash" | "waiting" | "missing";

export const CLASH_RANK: Readonly<Record<ClashKind, number>> = {
  clear: 0,
  waiting: 1,
  missing: 2,
  clash: 3,
};

export interface ClashOut {
  kind: ClashKind;
  part: number;
}

export function clashOut(): ClashOut {
  return { kind: "clear", part: NO_CLASH_PART };
}

export interface PosedParts {
  readonly count: number;
  readonly partIndex: ArrayLike<number>;
  readonly matrices: Float64Array;
  readonly boxes: Float64Array;
  readonly bounds: Float64Array;
}

export function emptyBounds(out: Float64Array): void {
  out.fill(Number.POSITIVE_INFINITY, 0, MAX);
  out.fill(Number.NEGATIVE_INFINITY, MAX, SOLID_BOX_FLOATS);
}

export function growBounds(out: Float64Array, box: ArrayLike<number>, at: number): void {
  for (let axis = 0; axis < AXES; axis++) {
    out[axis] = Math.min(out[axis] ?? 0, box[at + axis] ?? 0);
    out[MAX + axis] = Math.max(out[MAX + axis] ?? 0, box[at + MAX + axis] ?? 0);
  }
}

export function boundsMeet(
  a: ArrayLike<number>,
  aAt: number,
  b: ArrayLike<number>,
  bAt: number,
): boolean {
  for (let axis = 0; axis < AXES; axis++) {
    if ((a[aAt + MAX + axis] ?? 0) <= (b[bAt + axis] ?? 0)) return false;
    if ((b[bAt + MAX + axis] ?? 0) <= (a[aAt + axis] ?? 0)) return false;
  }
  return true;
}

function latticePoseMatrix(
  cos: number,
  sin: number,
  x: number,
  y: number,
  z: number,
  out: Float64Array,
): void {
  out.fill(0);
  out[0] = cos;
  out[2] = sin;
  out[3] = x;
  out[5] = 1;
  out[7] = y;
  out[8] = -sin;
  out[10] = cos;
  out[11] = z;
}

export class PosedPlaceable implements PosedParts {
  count = 0;
  partIndex: ArrayLike<number> = new Uint16Array(0);
  matrices = new Float64Array(0);
  boxes = new Float64Array(0);
  readonly bounds = new Float64Array(SOLID_BOX_FLOATS);
  private readonly pose = new Float64Array(SOLID_MATRIX_FLOATS);

  place(
    placeable: Placeable,
    x: number,
    z: number,
    yLdu: number,
    rot: number,
    solids: IPartSolids,
  ): void {
    if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
    const { partTransforms } = placeable;
    const count = partTransforms.count;
    if (this.matrices.length < count * SOLID_MATRIX_FLOATS) {
      this.matrices = new Float64Array(count * SOLID_MATRIX_FLOATS * GROWTH);
      this.boxes = new Float64Array(count * SOLID_BOX_FLOATS * GROWTH);
    }
    const pose = this.pose;
    latticePoseMatrix(rot90Cos(rot), rot90Sin(rot), x, yLdu, z, pose);
    this.count = count;
    this.partIndex = partTransforms.partIndex;
    emptyBounds(this.bounds);
    for (let i = 0; i < count; i++) {
      const m = i * SOLID_MATRIX_FLOATS;
      const b = i * SOLID_BOX_FLOATS;
      composeAffine(pose, 0, partTransforms.matrices, m, this.matrices, m);
      posedBoxBounds(
        this.matrices,
        m,
        solids.box(partTransforms.partIndex[i] ?? 0),
        0,
        this.boxes,
        b,
      );
      growBounds(this.bounds, this.boxes, b);
    }
  }
}

export class PartClash {
  private near = new Int32Array(0);

  constructor(private readonly solids: IPartSolids) {}

  first(
    a: PosedParts,
    aSkip: ReadonlySet<number>,
    b: PosedParts,
    bSkip: ReadonlySet<number>,
    out: ClashOut,
  ): void {
    out.kind = "clear";
    out.part = NO_CLASH_PART;
    if (!boundsMeet(a.bounds, 0, b.bounds, 0)) return;
    if (this.near.length < b.count) this.near = new Int32Array(b.count * GROWTH);
    let candidates = 0;
    for (let j = 0; j < b.count; j++) {
      if (bSkip.has(j) || !boundsMeet(b.boxes, j * SOLID_BOX_FLOATS, a.bounds, 0)) continue;
      this.near[candidates++] = j;
    }
    if (candidates === 0) return;
    for (let i = 0; i < a.count; i++) {
      const ab = i * SOLID_BOX_FLOATS;
      if (aSkip.has(i) || !boundsMeet(a.boxes, ab, b.bounds, 0)) continue;
      for (let c = 0; c < candidates; c++) {
        const j = this.near[c] ?? 0;
        if (!boundsMeet(a.boxes, ab, b.boxes, j * SOLID_BOX_FLOATS)) continue;
        if (this.pairClashes(a, i, b, j, out)) return;
      }
    }
  }

  private pairClashes(a: PosedParts, i: number, b: PosedParts, j: number, out: ClashOut): boolean {
    const solids = this.solids;
    const pa = a.partIndex[i] ?? 0;
    const pb = b.partIndex[j] ?? 0;
    const am = i * SOLID_MATRIX_FLOATS;
    const bm = j * SOLID_MATRIX_FLOATS;
    if (!boxesCross(a.matrices, am, solids.box(pa), 0, b.matrices, bm, solids.box(pb), 0)) {
      return false;
    }
    const ra = solids.readiness(pa);
    const rb = solids.readiness(pb);
    if (ra === "missing" || rb === "missing") {
      if (out.kind !== "missing") {
        out.kind = "missing";
        out.part = ra === "missing" ? pa : pb;
      }
      return false;
    }
    if (ra === "loading" || rb === "loading") {
      if (out.kind === "clear") out.kind = "waiting";
      return false;
    }
    if (!solidsCross(solids.solid(pa), a.matrices, am, solids.solid(pb), b.matrices, bm)) {
      return false;
    }
    out.kind = "clash";
    out.part = NO_CLASH_PART;
    return true;
  }
}

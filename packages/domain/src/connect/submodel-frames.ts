import { SIXTEENTHS_PER_LDU } from "@brr/math";
import { AXIS_FREE, AXIS_NEG_Z, VECTOR_FLOATS, axisDimension } from "./connector-table.ts";

export const IDENTIFICATION_RESIDUAL_LDU = 0.0005;
export const MODEL_ROOT = -1;
export const NO_FRAME = -2;
export const TRANSFORM_FLOATS = 12;
export const ALL_COORDINATES = 0b111;
const TRANSFORM_ROW = 4;
const TRANSLATION = 3;
const X = 0;
const Y = 1;
const Z = 2;

export interface SubmodelInstances {
  readonly count: number;
  readonly parent: ArrayLike<number>;
  readonly matrices: Float64Array;
  readonly ofPart: ArrayLike<number>;
}

export interface PartInstances {
  readonly count: number;
  readonly partIndex: ArrayLike<number>;
  readonly matrices: Float64Array;
  readonly submodels?: SubmodelInstances;
}

export class IdentifiedPoint {
  readonly sixteenths = new Int32Array(VECTOR_FLOATS);
  residual = 0;
}

export function coordinatesAcross(axis: number): number {
  if (!Number.isInteger(axis) || axis < 0 || axis > AXIS_NEG_Z) {
    throw new RangeError(`axis code ${axis} names no axis to take coordinates across`);
  }
  return ALL_COORDINATES & ~(1 << axisDimension(axis));
}

function checkTransform(transform: Float64Array): void {
  if (transform.length < TRANSFORM_FLOATS) {
    throw new RangeError(`a transform needs ${TRANSFORM_FLOATS} doubles, got ${transform.length}`);
  }
}

function identifiedAxis(x: number, y: number, z: number): number {
  const ux = Math.round(x);
  const uy = Math.round(y);
  const uz = Math.round(z);
  const unit = Math.abs(ux) + Math.abs(uy) + Math.abs(uz) === 1;
  const close =
    Math.abs(x - ux) <= IDENTIFICATION_RESIDUAL_LDU &&
    Math.abs(y - uy) <= IDENTIFICATION_RESIDUAL_LDU &&
    Math.abs(z - uz) <= IDENTIFICATION_RESIDUAL_LDU;
  if (!unit || !close) return AXIS_FREE;
  const dimension = ux !== 0 ? X : uy !== 0 ? Y : Z;
  const negative = ux + uy + uz < 0 ? 1 : 0;
  return dimension * 2 + negative;
}

export function identifyDirection(
  transform: Float64Array,
  x: number,
  y: number,
  z: number,
): number {
  checkTransform(transform);
  const t = transform;
  return identifiedAxis(
    (t[0] ?? 0) * x + (t[1] ?? 0) * y + (t[2] ?? 0) * z,
    (t[4] ?? 0) * x + (t[5] ?? 0) * y + (t[6] ?? 0) * z,
    (t[8] ?? 0) * x + (t[9] ?? 0) * y + (t[10] ?? 0) * z,
  );
}

export function identifyPoint(
  transform: Float64Array,
  x: number,
  y: number,
  z: number,
  coordinates: number,
  out: IdentifiedPoint,
): boolean {
  checkTransform(transform);
  if (!Number.isInteger(coordinates) || coordinates <= 0 || coordinates > ALL_COORDINATES) {
    throw new RangeError(`coordinates ${coordinates} must be a non-empty subset of x, y and z`);
  }
  const t = transform;
  const sx =
    ((t[0] ?? 0) * x + (t[1] ?? 0) * y + (t[2] ?? 0) * z + (t[3] ?? 0)) * SIXTEENTHS_PER_LDU;
  const sy =
    ((t[4] ?? 0) * x + (t[5] ?? 0) * y + (t[6] ?? 0) * z + (t[7] ?? 0)) * SIXTEENTHS_PER_LDU;
  const sz =
    ((t[8] ?? 0) * x + (t[9] ?? 0) * y + (t[10] ?? 0) * z + (t[11] ?? 0)) * SIXTEENTHS_PER_LDU;
  const ix = Math.round(sx);
  const iy = Math.round(sy);
  const iz = Math.round(sz);
  const wantX = (coordinates & (1 << X)) !== 0;
  const wantY = (coordinates & (1 << Y)) !== 0;
  const wantZ = (coordinates & (1 << Z)) !== 0;
  const residual =
    Math.hypot(wantX ? sx - ix : 0, wantY ? sy - iy : 0, wantZ ? sz - iz : 0) / SIXTEENTHS_PER_LDU;
  out.residual = residual;
  out.sixteenths.fill(0);
  if (!(residual <= IDENTIFICATION_RESIDUAL_LDU)) return false;
  if (wantX) out.sixteenths[X] = ix;
  if (wantY) out.sixteenths[Y] = iy;
  if (wantZ) out.sixteenths[Z] = iz;
  return true;
}

function invertAffine(m: Float64Array, o: number, out: Float64Array, at: number): boolean {
  const a = m[o] ?? 0;
  const b = m[o + 1] ?? 0;
  const c = m[o + 2] ?? 0;
  const d = m[o + 4] ?? 0;
  const e = m[o + 5] ?? 0;
  const f = m[o + 6] ?? 0;
  const g = m[o + 8] ?? 0;
  const h = m[o + 9] ?? 0;
  const i = m[o + 10] ?? 0;
  const cofactorA = e * i - f * h;
  const cofactorB = f * g - d * i;
  const cofactorC = d * h - e * g;
  const determinant = a * cofactorA + b * cofactorB + c * cofactorC;
  if (determinant === 0 || !Number.isFinite(determinant)) return false;
  out[at] = cofactorA / determinant;
  out[at + 1] = (c * h - b * i) / determinant;
  out[at + 2] = (b * f - c * e) / determinant;
  out[at + 4] = cofactorB / determinant;
  out[at + 5] = (a * i - c * g) / determinant;
  out[at + 6] = (c * d - a * f) / determinant;
  out[at + 8] = cofactorC / determinant;
  out[at + 9] = (b * g - a * h) / determinant;
  out[at + 10] = (a * e - b * d) / determinant;
  const tx = m[o + 3] ?? 0;
  const ty = m[o + 7] ?? 0;
  const tz = m[o + 11] ?? 0;
  for (let r = 0; r < VECTOR_FLOATS; r++) {
    const row = at + r * TRANSFORM_ROW;
    out[row + TRANSLATION] = -(
      (out[row] ?? 0) * tx +
      (out[row + 1] ?? 0) * ty +
      (out[row + 2] ?? 0) * tz
    );
  }
  return true;
}

function compose(
  outer: Float64Array,
  oo: number,
  inner: Float64Array,
  io: number,
  out: Float64Array,
): void {
  for (let r = 0; r < VECTOR_FLOATS; r++) {
    const row = r * TRANSFORM_ROW;
    const a0 = outer[oo + row] ?? 0;
    const a1 = outer[oo + row + 1] ?? 0;
    const a2 = outer[oo + row + 2] ?? 0;
    for (let k = 0; k < TRANSFORM_ROW; k++) {
      out[row + k] =
        a0 * (inner[io + k] ?? 0) +
        a1 * (inner[io + TRANSFORM_ROW + k] ?? 0) +
        a2 * (inner[io + 2 * TRANSFORM_ROW + k] ?? 0) +
        (k === TRANSLATION ? (outer[oo + row + TRANSLATION] ?? 0) : 0);
    }
  }
}

function checkSubmodels(instances: PartInstances, submodels: SubmodelInstances): void {
  if (submodels.matrices.length < submodels.count * TRANSFORM_FLOATS) {
    throw new RangeError(
      `${submodels.count} sub-model instances need ${TRANSFORM_FLOATS} matrix doubles each`,
    );
  }
  for (let n = 0; n < submodels.count; n++) {
    const parent = submodels.parent[n];
    if (parent === undefined || !Number.isInteger(parent) || parent < MODEL_ROOT || parent >= n) {
      throw new RangeError(
        `sub-model instance ${n} names parent ${parent}; a parent is the model root or an earlier sub-model instance`,
      );
    }
  }
  for (let i = 0; i < instances.count; i++) {
    const owner = submodels.ofPart[i];
    if (
      owner === undefined ||
      !Number.isInteger(owner) ||
      owner < MODEL_ROOT ||
      owner >= submodels.count
    ) {
      throw new RangeError(
        `part instance ${i} names sub-model instance ${owner}, outside the ${submodels.count} given`,
      );
    }
  }
}

export class SubmodelFrames {
  private readonly count: number;
  private readonly nodes: number;
  private readonly matrices: Float64Array;
  private readonly parent: ArrayLike<number>;
  private readonly ofPart: ArrayLike<number> | null;
  private readonly depth: Uint32Array;
  private readonly inverse: Float64Array;
  private readonly invertible: Uint8Array;

  constructor(instances: PartInstances) {
    if (instances.matrices.length < instances.count * TRANSFORM_FLOATS) {
      throw new RangeError(
        `${instances.count} instances need ${TRANSFORM_FLOATS} matrix doubles each`,
      );
    }
    const submodels = instances.submodels;
    if (submodels) checkSubmodels(instances, submodels);
    const nodes = submodels?.count ?? 0;
    this.count = instances.count;
    this.nodes = nodes;
    this.matrices = instances.matrices;
    this.parent = submodels?.parent ?? [];
    this.ofPart = submodels ? submodels.ofPart : null;
    this.depth = new Uint32Array(nodes);
    this.inverse = new Float64Array(nodes * TRANSFORM_FLOATS);
    this.invertible = new Uint8Array(nodes);
    for (let n = 0; n < nodes; n++) {
      this.depth[n] = this.depthOf(this.parentOf(n)) + 1;
      const at = n * TRANSFORM_FLOATS;
      if (submodels && invertAffine(submodels.matrices, at, this.inverse, at)) {
        this.invertible[n] = 1;
      }
    }
  }

  lowestCommonFrame(a: number, b: number): number {
    let x = this.frameOf(a);
    let y = this.frameOf(b);
    while (x !== y) {
      if (this.depthOf(x) >= this.depthOf(y)) x = this.parentOf(x);
      else y = this.parentOf(y);
    }
    return x;
  }

  relate(instance: number, frame: number, out: Float64Array): boolean {
    checkTransform(out);
    let n = this.frameOf(instance);
    const o = instance * TRANSFORM_FLOATS;
    if (frame === MODEL_ROOT) {
      for (let k = 0; k < TRANSFORM_FLOATS; k++) out[k] = this.matrices[o + k] ?? 0;
      return true;
    }
    while (n !== MODEL_ROOT && n !== frame) n = this.parentOf(n);
    if (n !== frame) {
      throw new RangeError(`sub-model instance ${frame} doesn't hold part instance ${instance}`);
    }
    if (this.invertible[frame] !== 1) return false;
    compose(this.inverse, frame * TRANSFORM_FLOATS, this.matrices, o, out);
    return true;
  }

  frameOf(instance: number): number {
    if (!Number.isInteger(instance) || instance < 0 || instance >= this.count) {
      throw new RangeError(`part instance ${instance} is outside the ${this.count} given`);
    }
    return this.ofPart ? (this.ofPart[instance] ?? MODEL_ROOT) : MODEL_ROOT;
  }

  parentFrame(frame: number): number {
    if (frame === MODEL_ROOT) return NO_FRAME;
    if (!Number.isInteger(frame) || frame < 0 || frame >= this.nodes) {
      throw new RangeError(
        `frame ${frame} is neither the model root nor one of the ${this.nodes} sub-model instances`,
      );
    }
    return this.parentOf(frame);
  }

  private parentOf(node: number): number {
    return this.parent[node] ?? MODEL_ROOT;
  }

  private depthOf(node: number): number {
    return node === MODEL_ROOT ? 0 : (this.depth[node] ?? 0);
  }
}

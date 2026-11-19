import { PLATE_LDU } from "@brr/math";
import type { PartTechnic } from "@brr/schema/bundle";
import type { LatticePose } from "./connect/candidate-poses.ts";
import { turnCos, turnSin } from "./connect/lattice-frame.ts";
import { IDENTIFICATION_RESIDUAL_LDU, type PartInstances } from "./connect/submodel-frames.ts";

export const TECHNIC_HOLE = 1;
export const TECHNIC_SHAFT = 2;
export const TECHNIC_BOX_FLOATS = 6;
export const TECHNIC_WAIVER_INTS = 5;
export const NO_TECHNIC_ITEM = -1;
const AXES = 3;
const MATRIX_FLOATS = 12;
const MATRIX_ROW = 4;
const WAIVER_U = 1;
const WAIVER_V = 2;
const WAIVER_FROM = 3;
const WAIVER_TO = 4;

export interface TechnicSet {
  readonly count: number;
  readonly itemOfInstance: Int32Array;
  readonly kind: Uint8Array;
  readonly box: Float64Array;
  readonly featureStart: Int32Array;
  readonly axis: Uint8Array;
  readonly atU: Int32Array;
  readonly atV: Int32Array;
  readonly from: Int32Array;
  readonly bins: Int32Array;
  readonly radiusStart: Int32Array;
  readonly radii: Int32Array;
}

export function firstOtherAxis(axis: number): number {
  return axis === 0 ? 1 : 0;
}

export function secondOtherAxis(axis: number): number {
  return axis === 2 ? 1 : 2;
}

function identified(value: number): number {
  const whole = Math.round(value);
  return Math.abs(value - whole) <= IDENTIFICATION_RESIDUAL_LDU ? whole : value;
}

class SignedPermutation {
  private readonly linear = new Int8Array(AXES * AXES);
  private readonly offset = new Int32Array(AXES);

  quarterTurn(pose: LatticePose): this {
    const cos = turnCos(pose.rot);
    const sin = turnSin(pose.rot);
    this.linear.fill(0);
    this.linear[0] = cos;
    this.linear[2] = sin;
    this.linear[4] = 1;
    this.linear[6] = -sin;
    this.linear[8] = cos;
    this.offset[0] = pose.x;
    this.offset[1] = pose.yPlates * PLATE_LDU;
    this.offset[2] = pose.z;
    return this;
  }

  identify(matrices: ArrayLike<number>, instance: number): boolean {
    const o = instance * MATRIX_FLOATS;
    for (let row = 0; row < AXES; row++) {
      let entries = 0;
      for (let col = 0; col < AXES; col++) {
        const value = identified(matrices[o + row * MATRIX_ROW + col] ?? 0);
        if (value !== 0 && value !== 1 && value !== -1) return false;
        if (value !== 0) entries++;
        this.linear[row * AXES + col] = value;
      }
      const shift = identified(matrices[o + row * MATRIX_ROW + AXES] ?? 0);
      if (entries !== 1 || !Number.isInteger(shift)) return false;
      this.offset[row] = shift;
    }
    for (let axis = 0; axis < AXES; axis++) {
      if (this.imageOf(axis) < 0) return false;
    }
    return true;
  }

  turnBox(from: Float64Array, at: number, out: Float64Array): void {
    for (let row = 0; row < AXES; row++) {
      const axis = this.sourceOf(row);
      const sign = this.linear[row * AXES + axis] ?? 0;
      const lo = from[at + axis] ?? 0;
      const hi = from[at + AXES + axis] ?? 0;
      const shift = this.offset[row] ?? 0;
      out[at + row] = (sign > 0 ? lo : -hi) + shift;
      out[at + AXES + row] = (sign > 0 ? hi : -lo) + shift;
    }
  }

  turnFeature(from: TechnicSet, f: number, out: TechnicSet): void {
    const axis = from.axis[f] ?? 0;
    const atU = from.atU[f] ?? 0;
    const atV = from.atV[f] ?? 0;
    const start = from.from[f] ?? 0;
    const bins = from.bins[f] ?? 0;
    const x = axis === 0 ? 0 : atU;
    const y = axis === 0 ? atU : axis === 1 ? 0 : atV;
    const z = axis === 2 ? 0 : atV;
    const image = this.imageOf(axis);
    const sign = this.linear[image * AXES + axis] ?? 0;
    const shift = this.offset[image] ?? 0;
    out.axis[f] = image;
    out.atU[f] = this.apply(firstOtherAxis(image), x, y, z);
    out.atV[f] = this.apply(secondOtherAxis(image), x, y, z);
    out.from[f] = sign > 0 ? start + shift : shift - start - bins;
    const r = from.radiusStart[f] ?? 0;
    if (sign > 0) {
      for (let k = 0; k < bins; k++) out.radii[r + k] = from.radii[r + k] ?? 0;
      return;
    }
    for (let lo = r, hi = r + bins - 1; lo <= hi; lo++, hi--) {
      const low = from.radii[lo] ?? 0;
      out.radii[lo] = from.radii[hi] ?? 0;
      out.radii[hi] = low;
    }
  }

  private imageOf(axis: number): number {
    for (let row = 0; row < AXES; row++) {
      if ((this.linear[row * AXES + axis] ?? 0) !== 0) return row;
    }
    return -1;
  }

  private sourceOf(row: number): number {
    for (let axis = 0; axis < AXES; axis++) {
      if ((this.linear[row * AXES + axis] ?? 0) !== 0) return axis;
    }
    return -1;
  }

  private apply(row: number, x: number, y: number, z: number): number {
    const r = row * AXES;
    return (
      (this.linear[r] ?? 0) * x +
      (this.linear[r + 1] ?? 0) * y +
      (this.linear[r + 2] ?? 0) * z +
      (this.offset[row] ?? 0)
    );
  }
}

function profiles(technic: PartTechnic): number {
  return technic.holes.length > 0 ? technic.holes.length : (technic.shaft?.components.length ?? 0);
}

function profileBins(technic: PartTechnic): number {
  let bins = 0;
  for (const hole of technic.holes) bins += hole.radii.length;
  if (technic.holes.length > 0) return bins;
  for (const component of technic.shaft?.components ?? []) bins += component.radii.length;
  return bins;
}

function writeFeature(
  set: TechnicSet,
  f: number,
  r: number,
  axis: number,
  at: readonly [number, number],
  from: number,
  radii: ReadonlyArray<number>,
): void {
  set.axis[f] = axis;
  set.atU[f] = at[0];
  set.atV[f] = at[1];
  set.from[f] = from;
  set.bins[f] = radii.length;
  set.radiusStart[f] = r;
  set.radii.set(radii, r);
}

export function modelTechnic(
  parts: ReadonlyArray<PartTechnic | null>,
  instances: PartInstances,
  boxes: ArrayLike<number>,
): TechnicSet {
  const turn = new SignedPermutation();
  const itemOfInstance = new Int32Array(instances.count).fill(NO_TECHNIC_ITEM);
  let items = 0;
  let features = 0;
  let bins = 0;
  for (let i = 0; i < instances.count; i++) {
    const technic = parts[instances.partIndex[i] ?? -1] ?? null;
    if (!technic || profiles(technic) === 0 || !turn.identify(instances.matrices, i)) continue;
    itemOfInstance[i] = items++;
    features += profiles(technic);
    bins += profileBins(technic);
  }
  const set: TechnicSet = {
    count: items,
    itemOfInstance,
    kind: new Uint8Array(items),
    box: new Float64Array(items * TECHNIC_BOX_FLOATS),
    featureStart: new Int32Array(items + 1),
    axis: new Uint8Array(features),
    atU: new Int32Array(features),
    atV: new Int32Array(features),
    from: new Int32Array(features),
    bins: new Int32Array(features),
    radiusStart: new Int32Array(features),
    radii: new Int32Array(bins),
  };
  let f = 0;
  let r = 0;
  for (let i = 0; i < instances.count; i++) {
    const item = itemOfInstance[i] ?? NO_TECHNIC_ITEM;
    const technic = parts[instances.partIndex[i] ?? -1] ?? null;
    if (item === NO_TECHNIC_ITEM || !technic || !turn.identify(instances.matrices, i)) continue;
    set.kind[item] = technic.holes.length > 0 ? TECHNIC_HOLE : TECHNIC_SHAFT;
    for (let k = 0; k < TECHNIC_BOX_FLOATS; k++) {
      set.box[item * TECHNIC_BOX_FLOATS + k] = boxes[i * TECHNIC_BOX_FLOATS + k] ?? 0;
    }
    set.featureStart[item] = f;
    const first = f;
    if (technic.holes.length > 0) {
      for (const hole of technic.holes) {
        writeFeature(set, f++, r, hole.axis, hole.at, hole.from, hole.radii);
        r += hole.radii.length;
      }
    } else if (technic.shaft) {
      const { axis, at, components } = technic.shaft;
      for (const component of components) {
        writeFeature(set, f++, r, axis, at, component.from, component.radii);
        r += component.radii.length;
      }
    }
    for (let k = first; k < f; k++) turn.turnFeature(set, k, set);
  }
  set.featureStart[items] = f;
  return set;
}

export function technicScratch(local: TechnicSet): TechnicSet {
  return {
    count: local.count,
    itemOfInstance: local.itemOfInstance,
    kind: local.kind,
    box: new Float64Array(local.box.length),
    featureStart: local.featureStart,
    axis: new Uint8Array(local.axis.length),
    atU: new Int32Array(local.atU.length),
    atV: new Int32Array(local.atV.length),
    from: new Int32Array(local.from.length),
    bins: local.bins,
    radiusStart: local.radiusStart,
    radii: new Int32Array(local.radii.length),
  };
}

const placement = new SignedPermutation();

export function placeTechnicInto(local: TechnicSet, pose: LatticePose, out: TechnicSet): void {
  const turn = placement.quarterTurn(pose);
  for (let i = 0; i < local.count; i++) turn.turnBox(local.box, i * TECHNIC_BOX_FLOATS, out.box);
  for (let f = 0; f < local.axis.length; f++) turn.turnFeature(local, f, out);
}

function boxesOverlap(a: Float64Array, ao: number, b: Float64Array, bo: number): boolean {
  for (let k = 0; k < AXES; k++) {
    if ((a[ao + k] ?? 0) >= (b[bo + AXES + k] ?? 0)) return false;
    if ((b[bo + k] ?? 0) >= (a[ao + AXES + k] ?? 0)) return false;
  }
  return true;
}

function sameLine(a: TechnicSet, fa: number, b: TechnicSet, fb: number): boolean {
  return a.axis[fa] === b.axis[fb] && a.atU[fa] === b.atU[fb] && a.atV[fa] === b.atV[fb];
}

function onLine(waivers: Int32Array, w: number, hole: TechnicSet, h: number): boolean {
  const o = w * TECHNIC_WAIVER_INTS;
  return (
    waivers[o] === hole.axis[h] &&
    waivers[o + WAIVER_U] === hole.atU[h] &&
    waivers[o + WAIVER_V] === hole.atV[h]
  );
}

function firstOnLine(
  waivers: Int32Array,
  waiverCount: number,
  hole: TechnicSet,
  h: number,
): number {
  for (let w = 0; w < waiverCount; w++) if (onLine(waivers, w, hole, h)) return w;
  return waiverCount;
}

function waived(
  waivers: Int32Array,
  first: number,
  waiverCount: number,
  hole: TechnicSet,
  h: number,
  t: number,
): boolean {
  for (let w = first; w < waiverCount; w++) {
    const o = w * TECHNIC_WAIVER_INTS;
    if (
      (waivers[o + WAIVER_FROM] ?? 0) <= t &&
      t < (waivers[o + WAIVER_TO] ?? 0) &&
      onLine(waivers, w, hole, h)
    ) {
      return true;
    }
  }
  return false;
}

function coveredByOneWaiver(
  waivers: Int32Array,
  first: number,
  waiverCount: number,
  hole: TechnicSet,
  h: number,
  lo: number,
  hi: number,
): boolean {
  for (let w = first; w < waiverCount; w++) {
    const o = w * TECHNIC_WAIVER_INTS;
    if (
      (waivers[o + WAIVER_FROM] ?? 0) <= lo &&
      hi <= (waivers[o + WAIVER_TO] ?? 0) &&
      onLine(waivers, w, hole, h)
    ) {
      return true;
    }
  }
  return false;
}

function componentsFit(
  shaft: TechnicSet,
  si: number,
  hole: TechnicSet,
  h: number,
  waivers: Int32Array,
  waiverCount: number,
): boolean {
  const holeFrom = hole.from[h] ?? 0;
  const holeTo = holeFrom + (hole.bins[h] ?? 0);
  const holeRadii = hole.radiusStart[h] ?? 0;
  const firstWaiver = firstOnLine(waivers, waiverCount, hole, h);
  const end = shaft.featureStart[si + 1] ?? 0;
  for (let c = shaft.featureStart[si] ?? 0; c < end; c++) {
    const from = shaft.from[c] ?? 0;
    const lo = Math.max(from, holeFrom);
    const hi = Math.min(from + (shaft.bins[c] ?? 0), holeTo);
    if (coveredByOneWaiver(waivers, firstWaiver, waiverCount, hole, h, lo, hi)) continue;
    const radii = shaft.radiusStart[c] ?? 0;
    for (let t = lo; t < hi; t++) {
      const tooWide =
        (shaft.radii[radii + t - from] ?? 0) > (hole.radii[holeRadii + t - holeFrom] ?? 0);
      if (tooWide && !waived(waivers, firstWaiver, waiverCount, hole, h, t)) return false;
    }
  }
  return true;
}

function shaftFits(
  shaft: TechnicSet,
  si: number,
  hole: TechnicSet,
  hi: number,
  waivers: Int32Array,
  waiverCount: number,
): boolean {
  const line = shaft.featureStart[si] ?? 0;
  const end = hole.featureStart[hi + 1] ?? 0;
  for (let h = hole.featureStart[hi] ?? 0; h < end; h++) {
    if (sameLine(shaft, line, hole, h) && componentsFit(shaft, si, hole, h, waivers, waiverCount)) {
      return true;
    }
  }
  return false;
}

export function technicItemsOverlap(
  a: TechnicSet,
  ai: number,
  b: TechnicSet,
  bi: number,
  waivers: Int32Array,
  waiverCount: number,
): boolean {
  if (!boxesOverlap(a.box, ai * TECHNIC_BOX_FLOATS, b.box, bi * TECHNIC_BOX_FLOATS)) return false;
  const kindA = a.kind[ai];
  if (kindA === b.kind[bi]) return true;
  return kindA === TECHNIC_SHAFT
    ? !shaftFits(a, ai, b, bi, waivers, waiverCount)
    : !shaftFits(b, bi, a, ai, waivers, waiverCount);
}

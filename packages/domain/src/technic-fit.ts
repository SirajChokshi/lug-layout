export const TECHNIC_HOLE = 1;
export const TECHNIC_SHAFT = 2;
export type TechnicKind = typeof TECHNIC_HOLE | typeof TECHNIC_SHAFT;

export const TECHNIC_BOX_FLOATS = 6;
export const NO_PIN = 0;
const AXES = 3;
const ROTATION_FLOATS = 9;

export interface TechnicSet {
  readonly count: number;
  readonly kind: Uint8Array;
  readonly box: Float64Array;
  readonly featureStart: Int32Array;
  readonly axis: Uint8Array;
  readonly atU: Int32Array;
  readonly atV: Int32Array;
  readonly from: Int32Array;
  readonly bins: Int32Array;
  readonly radiusStart: Int32Array;
  readonly pinOrigin: Int32Array;
  readonly pinDirection: Int8Array;
  readonly radii: Int32Array;
}

export interface TechnicFeature {
  readonly axis: number;
  readonly at: readonly [number, number];
  readonly from: number;
  readonly radii: ArrayLike<number>;
  readonly pin: { readonly origin: number; readonly direction: number } | null;
}

export function firstOtherAxis(axis: number): number {
  return axis === 0 ? 1 : 0;
}

export function secondOtherAxis(axis: number): number {
  return axis === 2 ? 1 : 2;
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

function seated(shaft: TechnicSet, c: number, holeFrom: number, holeTo: number): boolean {
  const direction = shaft.pinDirection[c] ?? NO_PIN;
  if (direction === NO_PIN) return false;
  const origin = shaft.pinOrigin[c] ?? 0;
  const entersAtEnd =
    (direction === 1 && origin === holeFrom) || (direction === -1 && origin === holeTo);
  return entersAtEnd && (shaft.bins[c] ?? 0) <= holeTo - holeFrom;
}

function componentsFit(shaft: TechnicSet, si: number, hole: TechnicSet, h: number): boolean {
  const holeFrom = hole.from[h] ?? 0;
  const holeTo = holeFrom + (hole.bins[h] ?? 0);
  const holeRadii = hole.radiusStart[h] ?? 0;
  const end = shaft.featureStart[si + 1] ?? 0;
  for (let c = shaft.featureStart[si] ?? 0; c < end; c++) {
    if (seated(shaft, c, holeFrom, holeTo)) continue;
    const from = shaft.from[c] ?? 0;
    const lo = Math.max(from, holeFrom);
    const hi = Math.min(from + (shaft.bins[c] ?? 0), holeTo);
    const radii = shaft.radiusStart[c] ?? 0;
    for (let t = lo; t < hi; t++) {
      if ((shaft.radii[radii + t - from] ?? 0) > (hole.radii[holeRadii + t - holeFrom] ?? 0)) {
        return false;
      }
    }
  }
  return true;
}

function shaftFits(shaft: TechnicSet, si: number, hole: TechnicSet, hi: number): boolean {
  const line = shaft.featureStart[si] ?? 0;
  const end = hole.featureStart[hi + 1] ?? 0;
  for (let h = hole.featureStart[hi] ?? 0; h < end; h++) {
    if (sameLine(shaft, line, hole, h) && componentsFit(shaft, si, hole, h)) return true;
  }
  return false;
}

export function technicItemsOverlap(a: TechnicSet, ai: number, b: TechnicSet, bi: number): boolean {
  if (!boxesOverlap(a.box, ai * TECHNIC_BOX_FLOATS, b.box, bi * TECHNIC_BOX_FLOATS)) return false;
  const kindA = a.kind[ai];
  const kindB = b.kind[bi];
  if (kindA === kindB) return true;
  return kindA === TECHNIC_SHAFT ? !shaftFits(a, ai, b, bi) : !shaftFits(b, bi, a, ai);
}

export class SignedPermutation {
  readonly linear = new Int8Array(ROTATION_FLOATS);
  readonly offset = new Int32Array(AXES);

  static quarterTurn(cos: number, sin: number, x: number, y: number, z: number): SignedPermutation {
    return new SignedPermutation().set(cos, sin, x, y, z);
  }

  static of(linear: ArrayLike<number>, offset: ArrayLike<number>): SignedPermutation | null {
    const out = new SignedPermutation();
    for (let row = 0; row < AXES; row++) {
      let ones = 0;
      for (let col = 0; col < AXES; col++) {
        const v = linear[row * AXES + col] ?? 0;
        if (v !== 0 && v !== 1 && v !== -1) return null;
        if (v !== 0) ones++;
        out.linear[row * AXES + col] = v;
      }
      if (ones !== 1) return null;
      const t = offset[row] ?? 0;
      if (!Number.isInteger(t)) return null;
      out.offset[row] = t;
    }
    return out;
  }

  set(cos: number, sin: number, x: number, y: number, z: number): this {
    this.linear[0] = cos;
    this.linear[2] = sin;
    this.linear[4] = 1;
    this.linear[6] = -sin;
    this.linear[8] = cos;
    this.offset[0] = x;
    this.offset[1] = y;
    this.offset[2] = z;
    return this;
  }

  sourceAxis(row: number): number {
    for (let col = 0; col < AXES; col++) {
      if ((this.linear[row * AXES + col] ?? 0) !== 0) return col;
    }
    throw new Error(`row ${row} of the permutation is empty`);
  }

  imageAxis(axis: number): number {
    for (let row = 0; row < AXES; row++) {
      if ((this.linear[row * AXES + axis] ?? 0) !== 0) return row;
    }
    throw new Error(`axis ${axis} has no image under the permutation`);
  }

  entry(row: number, col: number): number {
    return this.linear[row * AXES + col] ?? 0;
  }

  apply(row: number, x: number, y: number, z: number): number {
    const r = row * AXES;
    return (
      (this.linear[r] ?? 0) * x +
      (this.linear[r + 1] ?? 0) * y +
      (this.linear[r + 2] ?? 0) * z +
      (this.offset[row] ?? 0)
    );
  }
}

export class TechnicSetBuilder {
  private readonly kind: number[] = [];
  private readonly box: number[] = [];
  private readonly featureStart: number[] = [0];
  private readonly axis: number[] = [];
  private readonly atU: number[] = [];
  private readonly atV: number[] = [];
  private readonly from: number[] = [];
  private readonly bins: number[] = [];
  private readonly radiusStart: number[] = [];
  private readonly pinOrigin: number[] = [];
  private readonly pinDirection: number[] = [];
  private readonly radii: number[] = [];
  private readonly corner = new Float64Array(AXES);

  get count(): number {
    return this.kind.length;
  }

  addItem(
    kind: TechnicKind,
    box: ArrayLike<number>,
    features: ReadonlyArray<TechnicFeature>,
  ): void {
    this.kind.push(kind);
    for (let k = 0; k < TECHNIC_BOX_FLOATS; k++) this.box.push(box[k] ?? 0);
    for (const feature of features) this.pushFeature(feature);
    this.featureStart.push(this.axis.length);
  }

  addPlaced(
    source: TechnicSet,
    item: number,
    transform: SignedPermutation,
    box: ArrayLike<number>,
  ): void {
    this.kind.push(source.kind[item] ?? TECHNIC_HOLE);
    for (let k = 0; k < TECHNIC_BOX_FLOATS; k++) this.box.push(box[k] ?? 0);
    const end = source.featureStart[item + 1] ?? 0;
    for (let f = source.featureStart[item] ?? 0; f < end; f++) {
      this.pushTransformed(source, f, transform);
    }
    this.featureStart.push(this.axis.length);
  }

  private pushFeature(feature: TechnicFeature): void {
    this.axis.push(feature.axis);
    this.atU.push(feature.at[0]);
    this.atV.push(feature.at[1]);
    this.from.push(feature.from);
    this.bins.push(feature.radii.length);
    this.radiusStart.push(this.radii.length);
    for (let i = 0; i < feature.radii.length; i++) this.radii.push(feature.radii[i] ?? 0);
    this.pinOrigin.push(feature.pin?.origin ?? 0);
    this.pinDirection.push(feature.pin?.direction ?? NO_PIN);
  }

  private pushTransformed(source: TechnicSet, f: number, transform: SignedPermutation): void {
    const axis = source.axis[f] ?? 0;
    const u = firstOtherAxis(axis);
    const v = secondOtherAxis(axis);
    this.corner.fill(0);
    this.corner[u] = source.atU[f] ?? 0;
    this.corner[v] = source.atV[f] ?? 0;
    const imageAxis = transform.imageAxis(axis);
    const sign = transform.entry(imageAxis, axis);
    const wu = firstOtherAxis(imageAxis);
    const wv = secondOtherAxis(imageAxis);
    const x = this.corner[0] ?? 0;
    const y = this.corner[1] ?? 0;
    const z = this.corner[2] ?? 0;
    const shift = transform.offset[imageAxis] ?? 0;
    const from = source.from[f] ?? 0;
    const bins = source.bins[f] ?? 0;
    const start = source.radiusStart[f] ?? 0;
    this.axis.push(imageAxis);
    this.atU.push(transform.apply(wu, x, y, z));
    this.atV.push(transform.apply(wv, x, y, z));
    this.from.push(sign > 0 ? from + shift : shift - from - bins);
    this.bins.push(bins);
    this.radiusStart.push(this.radii.length);
    for (let i = 0; i < bins; i++) {
      this.radii.push(source.radii[start + (sign > 0 ? i : bins - 1 - i)] ?? 0);
    }
    this.pinOrigin.push(sign * (source.pinOrigin[f] ?? 0) + shift);
    this.pinDirection.push(sign * (source.pinDirection[f] ?? NO_PIN));
  }

  build(): TechnicSet {
    return {
      count: this.kind.length,
      kind: Uint8Array.from(this.kind),
      box: Float64Array.from(this.box),
      featureStart: Int32Array.from(this.featureStart),
      axis: Uint8Array.from(this.axis),
      atU: Int32Array.from(this.atU),
      atV: Int32Array.from(this.atV),
      from: Int32Array.from(this.from),
      bins: Int32Array.from(this.bins),
      radiusStart: Int32Array.from(this.radiusStart),
      pinOrigin: Int32Array.from(this.pinOrigin),
      pinDirection: Int8Array.from(this.pinDirection),
      radii: Int32Array.from(this.radii),
    };
  }
}

export function technicScratch(local: TechnicSet): TechnicSet {
  return {
    count: local.count,
    kind: local.kind.slice(),
    box: new Float64Array(local.box.length),
    featureStart: local.featureStart.slice(),
    axis: new Uint8Array(local.axis.length),
    atU: new Int32Array(local.atU.length),
    atV: new Int32Array(local.atV.length),
    from: new Int32Array(local.from.length),
    bins: local.bins.slice(),
    radiusStart: local.radiusStart.slice(),
    pinOrigin: new Int32Array(local.pinOrigin.length),
    pinDirection: new Int8Array(local.pinDirection.length),
    radii: new Int32Array(local.radii.length),
  };
}

export function placeTechnicInto(
  local: TechnicSet,
  transform: SignedPermutation,
  out: TechnicSet,
): void {
  for (let i = 0; i < local.count; i++) {
    const o = i * TECHNIC_BOX_FLOATS;
    for (let row = 0; row < AXES; row++) {
      const axis = transform.sourceAxis(row);
      const sign = transform.entry(row, axis);
      const lo = local.box[o + axis] ?? 0;
      const hi = local.box[o + AXES + axis] ?? 0;
      const shift = transform.offset[row] ?? 0;
      out.box[o + row] = (sign > 0 ? lo : -hi) + shift;
      out.box[o + AXES + row] = (sign > 0 ? hi : -lo) + shift;
    }
  }
  for (let f = 0; f < local.axis.length; f++) {
    const axis = local.axis[f] ?? 0;
    const u = firstOtherAxis(axis);
    const v = secondOtherAxis(axis);
    const image = transform.imageAxis(axis);
    const sign = transform.entry(image, axis);
    const wu = firstOtherAxis(image);
    const wv = secondOtherAxis(image);
    const atU = local.atU[f] ?? 0;
    const atV = local.atV[f] ?? 0;
    const x = u === 0 ? atU : 0;
    const y = u === 1 ? atU : v === 1 ? atV : 0;
    const z = v === 2 ? atV : 0;
    const shift = transform.offset[image] ?? 0;
    const from = local.from[f] ?? 0;
    const bins = local.bins[f] ?? 0;
    const start = local.radiusStart[f] ?? 0;
    out.axis[f] = image;
    out.atU[f] = transform.apply(wu, x, y, z);
    out.atV[f] = transform.apply(wv, x, y, z);
    out.from[f] = sign > 0 ? from + shift : shift - from - bins;
    out.pinOrigin[f] = sign * (local.pinOrigin[f] ?? 0) + shift;
    out.pinDirection[f] = sign * (local.pinDirection[f] ?? NO_PIN);
    for (let k = 0; k < bins; k++) {
      out.radii[start + k] = local.radii[start + (sign > 0 ? k : bins - 1 - k)] ?? 0;
    }
  }
}

export function placeTechnic(local: TechnicSet, transform: SignedPermutation): TechnicSet {
  const out = technicScratch(local);
  placeTechnicInto(local, transform, out);
  return out;
}

export const EMPTY_TECHNIC: TechnicSet = new TechnicSetBuilder().build();

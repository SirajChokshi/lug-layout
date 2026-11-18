import {
  GENDER_FEMALE,
  GENDER_MALE,
  VECTOR_FLOATS,
  type ConnectorTable,
} from "./connector-table.ts";
import { axialOffsetEngages, profilesFit } from "./mating.ts";

export const IDENTIFICATION_RESIDUAL_LDU = 0.0005;
const MATRIX_FLOATS = 12;
const X = 0;
const Y = 1;
const Z = 2;

export interface PartInstances {
  readonly count: number;
  readonly partIndex: ArrayLike<number>;
  readonly matrices: ArrayLike<number>;
}

interface Frames {
  readonly profile: Uint8Array;
  readonly gender: Uint8Array;
  readonly radius: Float32Array;
  readonly reach: Float32Array;
  readonly origin: Int32Array;
  readonly axis: Int8Array;
  readonly instance: Uint32Array;
}

function allocateFrames(count: number): Frames {
  return {
    profile: new Uint8Array(count),
    gender: new Uint8Array(count),
    radius: new Float32Array(count),
    reach: new Float32Array(count),
    origin: new Int32Array(count * VECTOR_FLOATS),
    axis: new Int8Array(count * VECTOR_FLOATS),
    instance: new Uint32Array(count),
  };
}

function axisDimension(axis: Int8Array, connector: number): number {
  const o = connector * VECTOR_FLOATS;
  if (axis[o + X] !== 0) return X;
  return axis[o + Y] !== 0 ? Y : Z;
}

const LINE_KEYS = 4;
const ALONG = 3;

function axesOpposite(axis: Int8Array, a: number, b: number): boolean {
  const oa = a * VECTOR_FLOATS;
  const ob = b * VECTOR_FLOATS;
  return (
    axis[oa + X] === -(axis[ob + X] ?? 0) &&
    axis[oa + Y] === -(axis[ob + Y] ?? 0) &&
    axis[oa + Z] === -(axis[ob + Z] ?? 0)
  );
}

class InternalMates {
  readonly consumed: Uint8Array;
  private readonly keys: Int32Array;
  private readonly order: Uint32Array;

  constructor(
    private readonly frames: Frames,
    private readonly count: number,
  ) {
    this.consumed = new Uint8Array(count);
    this.keys = new Int32Array(count * LINE_KEYS);
    this.order = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const dimension = axisDimension(frames.axis, i);
      const o = i * VECTOR_FLOATS;
      const k = i * LINE_KEYS;
      this.keys[k] = dimension;
      this.keys[k + 1] = frames.origin[o + ((dimension + 1) % VECTOR_FLOATS)] ?? 0;
      this.keys[k + 2] = frames.origin[o + ((dimension + 2) % VECTOR_FLOATS)] ?? 0;
      this.keys[k + ALONG] = frames.origin[o + dimension] ?? 0;
      this.order[i] = i;
    }
    this.order.sort((a, b) => this.compare(a, b, LINE_KEYS));
  }

  consume(): number {
    let mates = 0;
    let start = 0;
    while (start < this.count) {
      const first = this.order[start] ?? 0;
      let end = start + 1;
      while (end < this.count && this.compare(first, this.order[end] ?? 0, ALONG) === 0) end++;
      for (let i = start; i < end; i++) {
        const male = this.order[i] ?? 0;
        if (this.consumed[male] === 1 || this.frames.gender[male] !== GENDER_MALE) continue;
        const female = this.partner(male, i, start, end);
        if (female < 0) continue;
        this.consumed[male] = 1;
        this.consumed[female] = 1;
        mates++;
      }
      start = end;
    }
    return mates;
  }

  private partner(male: number, at: number, start: number, end: number): number {
    const along = this.along(male);
    const reach = this.frames.reach[male] ?? 0;
    for (let j = at - 1; j >= start && along - this.along(this.order[j] ?? 0) <= reach; j--) {
      if (this.mates(male, this.order[j] ?? 0)) return this.order[j] ?? 0;
    }
    for (let j = at + 1; j < end && this.along(this.order[j] ?? 0) - along <= reach; j++) {
      if (this.mates(male, this.order[j] ?? 0)) return this.order[j] ?? 0;
    }
    return -1;
  }

  private mates(male: number, female: number): boolean {
    const frames = this.frames;
    if (this.consumed[female] === 1 || frames.gender[female] !== GENDER_FEMALE) return false;
    const fits = profilesFit(
      frames.profile[male] ?? 0,
      frames.radius[male] ?? 0,
      frames.profile[female] ?? 0,
      frames.radius[female] ?? 0,
    );
    if (!fits || !axesOpposite(frames.axis, male, female)) return false;
    const direction = frames.axis[male * VECTOR_FLOATS + (this.keys[male * LINE_KEYS] ?? 0)] ?? 0;
    const offset = (this.along(female) - this.along(male)) * direction;
    return axialOffsetEngages(offset, frames.reach[male] ?? 0, frames.reach[female] ?? 0);
  }

  private along(connector: number): number {
    return this.keys[connector * LINE_KEYS + ALONG] ?? 0;
  }

  private compare(a: number, b: number, fields: number): number {
    for (let f = 0; f < fields; f++) {
      const difference = (this.keys[a * LINE_KEYS + f] ?? 0) - (this.keys[b * LINE_KEYS + f] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  }
}

export class ModelConnectors {
  private constructor(
    readonly count: number,
    readonly profile: Uint8Array,
    readonly gender: Uint8Array,
    readonly radius: Float32Array,
    readonly reach: Float32Array,
    readonly origin: Int32Array,
    readonly axis: Int8Array,
    readonly instance: Uint32Array,
    readonly internalMates: number,
    readonly offLattice: number,
    readonly instancesWithoutConnectors: number,
  ) {}

  static fromParts(
    parts: ReadonlyArray<ConnectorTable | null>,
    instances: PartInstances,
  ): ModelConnectors {
    let total = 0;
    let withoutConnectors = 0;
    for (let i = 0; i < instances.count; i++) {
      const part = parts[instances.partIndex[i] ?? -1];
      if (part === undefined) {
        throw new RangeError(
          `instance ${i} names part ${instances.partIndex[i]}, outside the table`,
        );
      }
      if (part === null) withoutConnectors++;
      else total += part.count;
    }
    if (instances.matrices.length < instances.count * MATRIX_FLOATS) {
      throw new RangeError(`${instances.count} instances need ${MATRIX_FLOATS} matrix floats each`);
    }
    const frames = allocateFrames(total);
    let exact = 0;
    let offLattice = 0;
    const m = instances.matrices;
    for (let i = 0; i < instances.count; i++) {
      const part = parts[instances.partIndex[i] ?? -1];
      if (!part) continue;
      const o = i * MATRIX_FLOATS;
      for (let c = 0; c < part.count; c++) {
        const v = c * VECTOR_FLOATS;
        const px = part.origin[v + X] ?? 0;
        const py = part.origin[v + Y] ?? 0;
        const pz = part.origin[v + Z] ?? 0;
        const dx = part.axis[v + X] ?? 0;
        const dy = part.axis[v + Y] ?? 0;
        const dz = part.axis[v + Z] ?? 0;
        const r0 = m[o] ?? 0;
        const r1 = m[o + 1] ?? 0;
        const r2 = m[o + 2] ?? 0;
        const r4 = m[o + 4] ?? 0;
        const r5 = m[o + 5] ?? 0;
        const r6 = m[o + 6] ?? 0;
        const r8 = m[o + 8] ?? 0;
        const r9 = m[o + 9] ?? 0;
        const r10 = m[o + 10] ?? 0;
        const wx = r0 * px + r1 * py + r2 * pz + (m[o + 3] ?? 0);
        const wy = r4 * px + r5 * py + r6 * pz + (m[o + 7] ?? 0);
        const wz = r8 * px + r9 * py + r10 * pz + (m[o + 11] ?? 0);
        const ax = r0 * dx + r1 * dy + r2 * dz;
        const ay = r4 * dx + r5 * dy + r6 * dz;
        const az = r8 * dx + r9 * dy + r10 * dz;
        const ix = Math.round(wx);
        const iy = Math.round(wy);
        const iz = Math.round(wz);
        const ux = Math.round(ax);
        const uy = Math.round(ay);
        const uz = Math.round(az);
        const unitAxis = Math.abs(ux) + Math.abs(uy) + Math.abs(uz) === 1;
        const originResidual = Math.hypot(wx - ix, wy - iy, wz - iz);
        const axisResidual = Math.hypot(ax - ux, ay - uy, az - uz);
        if (
          !unitAxis ||
          originResidual > IDENTIFICATION_RESIDUAL_LDU ||
          axisResidual > IDENTIFICATION_RESIDUAL_LDU
        ) {
          offLattice++;
          continue;
        }
        const e = exact * VECTOR_FLOATS;
        frames.origin[e + X] = ix;
        frames.origin[e + Y] = iy;
        frames.origin[e + Z] = iz;
        frames.axis[e + X] = ux;
        frames.axis[e + Y] = uy;
        frames.axis[e + Z] = uz;
        frames.profile[exact] = part.profile[c] ?? 0;
        frames.gender[exact] = part.gender[c] ?? 0;
        frames.radius[exact] = part.radius[c] ?? 0;
        frames.reach[exact] = part.reach[c] ?? 0;
        frames.instance[exact] = i;
        exact++;
      }
    }
    const search = new InternalMates(frames, exact);
    const internalMates = search.consume();
    const consumed = search.consumed;
    const exposed = exact - 2 * internalMates;
    const out = allocateFrames(exposed);
    let n = 0;
    for (let i = 0; i < exact; i++) {
      if (consumed[i] === 1) continue;
      out.profile[n] = frames.profile[i] ?? 0;
      out.gender[n] = frames.gender[i] ?? 0;
      out.radius[n] = frames.radius[i] ?? 0;
      out.reach[n] = frames.reach[i] ?? 0;
      out.instance[n] = frames.instance[i] ?? 0;
      out.origin.set(
        frames.origin.subarray(i * VECTOR_FLOATS, (i + 1) * VECTOR_FLOATS),
        n * VECTOR_FLOATS,
      );
      out.axis.set(
        frames.axis.subarray(i * VECTOR_FLOATS, (i + 1) * VECTOR_FLOATS),
        n * VECTOR_FLOATS,
      );
      n++;
    }
    return new ModelConnectors(
      exposed,
      out.profile,
      out.gender,
      out.radius,
      out.reach,
      out.origin,
      out.axis,
      out.instance,
      internalMates,
      offLattice,
      withoutConnectors,
    );
  }
}

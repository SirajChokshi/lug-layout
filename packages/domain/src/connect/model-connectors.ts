import {
  AXIS_FREE,
  GENDER_FEMALE,
  GENDER_MALE,
  VECTOR_FLOATS,
  axisDimension,
  axisSign,
  oppositeAxis,
  type ConnectorTable,
} from "./connector-table.ts";
import { SIXTEENTHS_PER_LDU, ZETA16_COEFFICIENT_COUNT } from "@brr/math";
import type { TrackEnd } from "../track/end-gaps.ts";
import type { SnapMating } from "./mating.ts";

export const IDENTIFICATION_RESIDUAL_LDU = 0.0005;
const MATRIX_FLOATS = 12;
const X = 0;
const Y = 1;
const Z = 2;
const LINE_KEYS = 4;
const ALONG = 3;
const INT32_LIMIT = 2 ** 31;

export interface PartInstances {
  readonly count: number;
  readonly partIndex: ArrayLike<number>;
  readonly matrices: Float64Array;
}

interface Frames {
  readonly shape: Uint16Array;
  readonly gender: Uint8Array;
  readonly source: Uint8Array;
  readonly status: Uint8Array;
  readonly origin: Int32Array;
  readonly axis: Int8Array;
  readonly instance: Uint32Array;
}

function allocateFrames(count: number): Frames {
  return {
    shape: new Uint16Array(count),
    gender: new Uint8Array(count),
    source: new Uint8Array(count),
    status: new Uint8Array(count),
    origin: new Int32Array(count * VECTOR_FLOATS),
    axis: new Int8Array(count),
    instance: new Uint32Array(count),
  };
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

function axisVector(part: ConnectorTable, connector: number, out: Float64Array): void {
  const code = part.axis[connector] ?? AXIS_FREE;
  if (code === AXIS_FREE) {
    for (let k = 0; k < VECTOR_FLOATS; k++) {
      out[k] = part.axisFree[connector * VECTOR_FLOATS + k] ?? 0;
    }
    return;
  }
  out.fill(0);
  out[axisDimension(code)] = axisSign(code);
}

interface TrackEnds {
  readonly heading: Uint8Array;
  readonly position: Int32Array;
  readonly yPlates: Int32Array;
}

function exactTrackEnds(ends: ReadonlyArray<TrackEnd>): TrackEnds {
  const heading = new Uint8Array(ends.length);
  const position = new Int32Array(ends.length * ZETA16_COEFFICIENT_COUNT);
  const yPlates = new Int32Array(ends.length);
  for (let e = 0; e < ends.length; e++) {
    const end = ends[e];
    if (!end) continue;
    heading[e] = end.pose.heading;
    yPlates[e] = end.yPlates;
    for (let k = 0; k < ZETA16_COEFFICIENT_COUNT; k++) {
      const coefficient = Number(end.pose.position[k] ?? 0n);
      if (Math.abs(coefficient) >= INT32_LIMIT) {
        throw new RangeError(`track end ${e} has coefficient ${coefficient}, beyond int32 studs`);
      }
      position[e * ZETA16_COEFFICIENT_COUNT + k] = coefficient;
    }
  }
  return { heading, position, yPlates };
}

class InternalMates {
  readonly consumed: Uint8Array;
  private readonly reach: number;
  private readonly keys: Int32Array;
  private readonly order: Uint32Array;

  constructor(
    private readonly frames: Frames,
    private readonly count: number,
    private readonly mating: SnapMating,
  ) {
    this.consumed = new Uint8Array(count);
    this.reach = Math.ceil(mating.shapes.longest * SIXTEENTHS_PER_LDU);
    this.keys = new Int32Array(count * LINE_KEYS);
    this.order = new Uint32Array(count);
    for (let i = 0; i < count; i++) {
      const dimension = axisDimension(frames.axis[i] ?? 0);
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
    const reach = this.reach;
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
    const axis = frames.axis[male] ?? 0;
    if (frames.axis[female] !== oppositeAxis(axis)) return false;
    const offset = (this.along(female) - this.along(male)) * axisSign(axis);
    return this.mating.engages(frames.shape[male] ?? 0, frames.shape[female] ?? 0, offset);
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
    readonly shape: Uint16Array,
    readonly gender: Uint8Array,
    readonly source: Uint8Array,
    readonly status: Uint8Array,
    readonly origin: Int32Array,
    readonly axis: Int8Array,
    readonly instance: Uint32Array,
    readonly internalMates: number,
    readonly offLattice: number,
    readonly instancesWithoutConnectors: number,
    readonly trackEndCount: number,
    readonly trackHeading: Uint8Array,
    readonly trackPosition: Int32Array,
    readonly trackYPlates: Int32Array,
  ) {}

  static fromParts(
    parts: ReadonlyArray<ConnectorTable | null>,
    instances: PartInstances,
    mating: SnapMating,
    trackEnds: ReadonlyArray<TrackEnd> = [],
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
    const direction = new Float64Array(VECTOR_FLOATS);
    let exact = 0;
    let offLattice = 0;
    const m = instances.matrices;
    for (let i = 0; i < instances.count; i++) {
      const part = parts[instances.partIndex[i] ?? -1];
      if (!part) continue;
      const o = i * MATRIX_FLOATS;
      const r0 = m[o] ?? 0;
      const r1 = m[o + 1] ?? 0;
      const r2 = m[o + 2] ?? 0;
      const r4 = m[o + 4] ?? 0;
      const r5 = m[o + 5] ?? 0;
      const r6 = m[o + 6] ?? 0;
      const r8 = m[o + 8] ?? 0;
      const r9 = m[o + 9] ?? 0;
      const r10 = m[o + 10] ?? 0;
      for (let c = 0; c < part.count; c++) {
        const v = c * VECTOR_FLOATS;
        const px = part.origin[v + X] ?? 0;
        const py = part.origin[v + Y] ?? 0;
        const pz = part.origin[v + Z] ?? 0;
        const wx = r0 * px + r1 * py + r2 * pz + (m[o + 3] ?? 0);
        const wy = r4 * px + r5 * py + r6 * pz + (m[o + 7] ?? 0);
        const wz = r8 * px + r9 * py + r10 * pz + (m[o + 11] ?? 0);
        axisVector(part, c, direction);
        const dx = direction[X] ?? 0;
        const dy = direction[Y] ?? 0;
        const dz = direction[Z] ?? 0;
        const axis = identifiedAxis(
          r0 * dx + r1 * dy + r2 * dz,
          r4 * dx + r5 * dy + r6 * dz,
          r8 * dx + r9 * dy + r10 * dz,
        );
        const ix = Math.round(wx * SIXTEENTHS_PER_LDU);
        const iy = Math.round(wy * SIXTEENTHS_PER_LDU);
        const iz = Math.round(wz * SIXTEENTHS_PER_LDU);
        const residual =
          Math.hypot(
            wx * SIXTEENTHS_PER_LDU - ix,
            wy * SIXTEENTHS_PER_LDU - iy,
            wz * SIXTEENTHS_PER_LDU - iz,
          ) / SIXTEENTHS_PER_LDU;
        if (axis === AXIS_FREE || residual > IDENTIFICATION_RESIDUAL_LDU) {
          offLattice++;
          continue;
        }
        const e = exact * VECTOR_FLOATS;
        frames.origin[e + X] = ix;
        frames.origin[e + Y] = iy;
        frames.origin[e + Z] = iz;
        frames.axis[exact] = axis;
        frames.shape[exact] = part.shape[c] ?? 0;
        frames.gender[exact] = part.gender[c] ?? 0;
        frames.source[exact] = part.source[c] ?? 0;
        frames.status[exact] = part.status[c] ?? 0;
        frames.instance[exact] = i;
        exact++;
      }
    }
    const search = new InternalMates(frames, exact, mating);
    const internalMates = search.consume();
    const exposed = allocateFrames(exact - 2 * internalMates);
    let n = 0;
    for (let i = 0; i < exact; i++) {
      if (search.consumed[i] === 1) continue;
      exposed.shape[n] = frames.shape[i] ?? 0;
      exposed.gender[n] = frames.gender[i] ?? 0;
      exposed.source[n] = frames.source[i] ?? 0;
      exposed.status[n] = frames.status[i] ?? 0;
      exposed.axis[n] = frames.axis[i] ?? 0;
      exposed.instance[n] = frames.instance[i] ?? 0;
      for (let k = 0; k < VECTOR_FLOATS; k++) {
        exposed.origin[n * VECTOR_FLOATS + k] = frames.origin[i * VECTOR_FLOATS + k] ?? 0;
      }
      n++;
    }
    const track = exactTrackEnds(trackEnds);
    return new ModelConnectors(
      n,
      exposed.shape,
      exposed.gender,
      exposed.source,
      exposed.status,
      exposed.origin,
      exposed.axis,
      exposed.instance,
      internalMates,
      offLattice,
      withoutConnectors,
      trackEnds.length,
      track.heading,
      track.position,
      track.yPlates,
    );
  }
}

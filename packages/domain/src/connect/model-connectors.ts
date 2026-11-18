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
export const MODEL_ROOT = -1;
const MATRIX_FLOATS = 12;
const MATRIX_ROW = 4;
const TRANSLATION = 3;
const X = 0;
const Y = 1;
const Z = 2;
const LINE_KEYS = 4;
const ALONG = 3;
const INT32_LIMIT = 2 ** 31;

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

const direction = new Float64Array(VECTOR_FLOATS);
const sixteenths = new Int32Array(VECTOR_FLOATS);

function identifyPlaced(
  m: Float64Array,
  o: number,
  part: ConnectorTable,
  connector: number,
): number {
  const r0 = m[o] ?? 0;
  const r1 = m[o + 1] ?? 0;
  const r2 = m[o + 2] ?? 0;
  const r4 = m[o + 4] ?? 0;
  const r5 = m[o + 5] ?? 0;
  const r6 = m[o + 6] ?? 0;
  const r8 = m[o + 8] ?? 0;
  const r9 = m[o + 9] ?? 0;
  const r10 = m[o + 10] ?? 0;
  axisVector(part, connector, direction);
  const dx = direction[X] ?? 0;
  const dy = direction[Y] ?? 0;
  const dz = direction[Z] ?? 0;
  const axis = identifiedAxis(
    r0 * dx + r1 * dy + r2 * dz,
    r4 * dx + r5 * dy + r6 * dz,
    r8 * dx + r9 * dy + r10 * dz,
  );
  if (axis === AXIS_FREE) return AXIS_FREE;
  const v = connector * VECTOR_FLOATS;
  const px = part.origin[v + X] ?? 0;
  const py = part.origin[v + Y] ?? 0;
  const pz = part.origin[v + Z] ?? 0;
  const wx = (r0 * px + r1 * py + r2 * pz + (m[o + 3] ?? 0)) * SIXTEENTHS_PER_LDU;
  const wy = (r4 * px + r5 * py + r6 * pz + (m[o + 7] ?? 0)) * SIXTEENTHS_PER_LDU;
  const wz = (r8 * px + r9 * py + r10 * pz + (m[o + 11] ?? 0)) * SIXTEENTHS_PER_LDU;
  const ix = Math.round(wx);
  const iy = Math.round(wy);
  const iz = Math.round(wz);
  const residual = Math.hypot(wx - ix, wy - iy, wz - iz) / SIXTEENTHS_PER_LDU;
  if (!(residual <= IDENTIFICATION_RESIDUAL_LDU)) return AXIS_FREE;
  sixteenths[X] = ix;
  sixteenths[Y] = iy;
  sixteenths[Z] = iz;
  return axis;
}

function invertAffine(m: Float64Array, o: number, out: Float64Array): boolean {
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
  out[0] = cofactorA / determinant;
  out[1] = (c * h - b * i) / determinant;
  out[2] = (b * f - c * e) / determinant;
  out[4] = cofactorB / determinant;
  out[5] = (a * i - c * g) / determinant;
  out[6] = (c * d - a * f) / determinant;
  out[8] = cofactorC / determinant;
  out[9] = (b * g - a * h) / determinant;
  out[10] = (a * e - b * d) / determinant;
  const tx = m[o + 3] ?? 0;
  const ty = m[o + 7] ?? 0;
  const tz = m[o + 11] ?? 0;
  for (let r = 0; r < VECTOR_FLOATS; r++) {
    const row = r * MATRIX_ROW;
    out[row + TRANSLATION] = -(
      (out[row] ?? 0) * tx +
      (out[row + 1] ?? 0) * ty +
      (out[row + 2] ?? 0) * tz
    );
  }
  return true;
}

function compose(outer: Float64Array, inner: Float64Array, o: number, out: Float64Array): void {
  for (let r = 0; r < VECTOR_FLOATS; r++) {
    const row = r * MATRIX_ROW;
    const a0 = outer[row] ?? 0;
    const a1 = outer[row + 1] ?? 0;
    const a2 = outer[row + 2] ?? 0;
    for (let k = 0; k < MATRIX_ROW; k++) {
      out[row + k] =
        a0 * (inner[o + k] ?? 0) +
        a1 * (inner[o + MATRIX_ROW + k] ?? 0) +
        a2 * (inner[o + 2 * MATRIX_ROW + k] ?? 0) +
        (k === TRANSLATION ? (outer[row + TRANSLATION] ?? 0) : 0);
    }
  }
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

function checkSubmodels(instances: PartInstances, submodels: SubmodelInstances): void {
  if (submodels.matrices.length < submodels.count * MATRIX_FLOATS) {
    throw new RangeError(
      `${submodels.count} sub-model instances need ${MATRIX_FLOATS} matrix floats each`,
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

class InternalMates {
  readonly consumed: Uint8Array;
  private readonly reach: number;
  private readonly keys: Int32Array;
  private readonly order: Uint32Array;
  private readonly connector: Uint32Array;
  private readonly axis: Int8Array;
  private readonly branch: Int32Array;
  private size = 0;
  private readonly byLine = (a: number, b: number): number => this.compare(a, b, LINE_KEYS);

  constructor(
    private readonly frames: Frames,
    capacity: number,
    private readonly mating: SnapMating,
  ) {
    this.consumed = new Uint8Array(capacity);
    this.reach = Math.ceil(mating.shapes.longest * SIXTEENTHS_PER_LDU);
    this.keys = new Int32Array(capacity * LINE_KEYS);
    this.order = new Uint32Array(capacity);
    this.connector = new Uint32Array(capacity);
    this.axis = new Int8Array(capacity);
    this.branch = new Int32Array(capacity);
  }

  clear(): void {
    this.size = 0;
  }

  add(
    connector: number,
    axis: number,
    origin: ArrayLike<number>,
    at: number,
    branch: number,
  ): void {
    const n = this.size++;
    const dimension = axisDimension(axis);
    const k = n * LINE_KEYS;
    this.keys[k] = dimension;
    this.keys[k + 1] = origin[at + ((dimension + 1) % VECTOR_FLOATS)] ?? 0;
    this.keys[k + 2] = origin[at + ((dimension + 2) % VECTOR_FLOATS)] ?? 0;
    this.keys[k + ALONG] = origin[at + dimension] ?? 0;
    this.connector[n] = connector;
    this.axis[n] = axis;
    this.branch[n] = branch;
    this.order[n] = n;
  }

  consume(): number {
    const count = this.size;
    this.order.subarray(0, count).sort(this.byLine);
    let mates = 0;
    let start = 0;
    while (start < count) {
      const first = this.order[start] ?? 0;
      let end = start + 1;
      while (end < count && this.compare(first, this.order[end] ?? 0, ALONG) === 0) end++;
      for (let i = start; i < end; i++) {
        const male = this.order[i] ?? 0;
        const maleConnector = this.connector[male] ?? 0;
        if (this.consumed[maleConnector] === 1) continue;
        if (this.frames.gender[maleConnector] !== GENDER_MALE) continue;
        const female = this.partner(male, i, start, end);
        if (female < 0) continue;
        this.consumed[maleConnector] = 1;
        this.consumed[this.connector[female] ?? 0] = 1;
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
    const maleConnector = this.connector[male] ?? 0;
    const femaleConnector = this.connector[female] ?? 0;
    if (this.consumed[femaleConnector] === 1) return false;
    if (frames.gender[femaleConnector] !== GENDER_FEMALE) return false;
    if (this.branch[male] === this.branch[female]) return false;
    const axis = this.axis[male] ?? 0;
    if (this.axis[female] !== oppositeAxis(axis)) return false;
    const offset = (this.along(female) - this.along(male)) * axisSign(axis);
    return this.mating.engages(
      frames.shape[maleConnector] ?? 0,
      frames.shape[femaleConnector] ?? 0,
      offset,
    );
  }

  private along(candidate: number): number {
    return this.keys[candidate * LINE_KEYS + ALONG] ?? 0;
  }

  private compare(a: number, b: number, fields: number): number {
    for (let f = 0; f < fields; f++) {
      const difference = (this.keys[a * LINE_KEYS + f] ?? 0) - (this.keys[b * LINE_KEYS + f] ?? 0);
      if (difference !== 0) return difference;
    }
    return 0;
  }
}

function mateInSubmodelFrames(
  parts: ReadonlyArray<ConnectorTable | null>,
  instances: PartInstances,
  submodels: SubmodelInstances,
  firstConnector: Uint32Array,
  search: InternalMates,
): number {
  const nodes = submodels.count;
  const bucket = new Uint32Array(nodes + 1);
  for (let i = 0; i < instances.count; i++) {
    let n = submodels.ofPart[i] ?? MODEL_ROOT;
    while (n !== MODEL_ROOT) {
      bucket[n + 1] = (bucket[n + 1] ?? 0) + 1;
      n = submodels.parent[n] ?? MODEL_ROOT;
    }
  }
  for (let n = 0; n < nodes; n++) bucket[n + 1] = (bucket[n + 1] ?? 0) + (bucket[n] ?? 0);
  const member = new Uint32Array(bucket[nodes] ?? 0);
  const branch = new Int32Array(member.length);
  const filled = bucket.slice(0, nodes);
  for (let i = 0; i < instances.count; i++) {
    let below = MODEL_ROOT - i;
    let n = submodels.ofPart[i] ?? MODEL_ROOT;
    while (n !== MODEL_ROOT) {
      const e = filled[n] ?? 0;
      filled[n] = e + 1;
      member[e] = i;
      branch[e] = below;
      below = n;
      n = submodels.parent[n] ?? MODEL_ROOT;
    }
  }
  const inverse = new Float64Array(MATRIX_FLOATS);
  const relative = new Float64Array(MATRIX_FLOATS);
  let mates = 0;
  for (let n = nodes - 1; n >= 0; n--) {
    if (!invertAffine(submodels.matrices, n * MATRIX_FLOATS, inverse)) continue;
    search.clear();
    for (let e = bucket[n] ?? 0; e < (bucket[n + 1] ?? 0); e++) {
      const i = member[e] ?? 0;
      const part = parts[instances.partIndex[i] ?? -1];
      if (!part) continue;
      compose(inverse, instances.matrices, i * MATRIX_FLOATS, relative);
      const first = firstConnector[i] ?? 0;
      for (let c = 0; c < part.count; c++) {
        if (search.consumed[first + c] === 1) continue;
        const axis = identifyPlaced(relative, 0, part, c);
        if (axis !== AXIS_FREE) search.add(first + c, axis, sixteenths, 0, branch[e] ?? 0);
      }
    }
    mates += search.consume();
  }
  return mates;
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
    const submodels = instances.submodels;
    if (submodels) checkSubmodels(instances, submodels);
    const nested = submodels && submodels.count > 0 ? submodels : null;
    const firstConnector = new Uint32Array(nested ? instances.count : 0);
    const frames = allocateFrames(total);
    const search = new InternalMates(frames, total, mating);
    let g = 0;
    for (let i = 0; i < instances.count; i++) {
      const part = parts[instances.partIndex[i] ?? -1];
      if (nested) firstConnector[i] = g;
      if (!part) continue;
      for (let c = 0; c < part.count; c++, g++) {
        frames.shape[g] = part.shape[c] ?? 0;
        frames.gender[g] = part.gender[c] ?? 0;
        frames.source[g] = part.source[c] ?? 0;
        frames.status[g] = part.status[c] ?? 0;
        frames.instance[g] = i;
        const axis = identifyPlaced(instances.matrices, i * MATRIX_FLOATS, part, c);
        frames.axis[g] = axis;
        if (axis === AXIS_FREE) continue;
        frames.origin.set(sixteenths, g * VECTOR_FLOATS);
        search.add(g, axis, sixteenths, 0, g);
      }
    }
    let internalMates = search.consume();
    if (nested) {
      internalMates += mateInSubmodelFrames(parts, instances, nested, firstConnector, search);
    }
    let offLattice = 0;
    for (let k = 0; k < total; k++) {
      if (search.consumed[k] === 0 && frames.axis[k] === AXIS_FREE) offLattice++;
    }
    const exposed = allocateFrames(total - 2 * internalMates - offLattice);
    let n = 0;
    for (let k = 0; k < total; k++) {
      if (search.consumed[k] === 1 || frames.axis[k] === AXIS_FREE) continue;
      exposed.shape[n] = frames.shape[k] ?? 0;
      exposed.gender[n] = frames.gender[k] ?? 0;
      exposed.source[n] = frames.source[k] ?? 0;
      exposed.status[n] = frames.status[k] ?? 0;
      exposed.axis[n] = frames.axis[k] ?? 0;
      exposed.instance[n] = frames.instance[k] ?? 0;
      for (let v = 0; v < VECTOR_FLOATS; v++) {
        exposed.origin[n * VECTOR_FLOATS + v] = frames.origin[k * VECTOR_FLOATS + v] ?? 0;
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

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
import {
  ALL_COORDINATES,
  IdentifiedPoint,
  MODEL_ROOT,
  SubmodelFrames,
  TRANSFORM_FLOATS,
  identifyDirection,
  identifyPoint,
  type PartInstances,
  type SubmodelInstances,
} from "./submodel-frames.ts";

const X = 0;
const Y = 1;
const Z = 2;
const LINE_KEYS = 4;
const ALONG = 3;
const INT32_LIMIT = 2 ** 31;

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

function identifyConnector(
  transform: Float64Array,
  part: ConnectorTable,
  connector: number,
  point: IdentifiedPoint,
): number {
  axisVector(part, connector, direction);
  const axis = identifyDirection(
    transform,
    direction[X] ?? 0,
    direction[Y] ?? 0,
    direction[Z] ?? 0,
  );
  if (axis === AXIS_FREE) return AXIS_FREE;
  const v = connector * VECTOR_FLOATS;
  const identified = identifyPoint(
    transform,
    part.origin[v + X] ?? 0,
    part.origin[v + Y] ?? 0,
    part.origin[v + Z] ?? 0,
    ALL_COORDINATES,
    point,
  );
  return identified ? axis : AXIS_FREE;
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
  private readonly connector: Uint32Array;
  private readonly axis: Int8Array;
  private size = 0;
  private pairFrame: number | null = null;
  private readonly byLine = (a: number, b: number): number => this.compare(a, b, LINE_KEYS);

  constructor(
    private readonly frames: Frames,
    capacity: number,
    private readonly mating: SnapMating,
    private readonly submodelFrames: SubmodelFrames,
  ) {
    this.consumed = new Uint8Array(capacity);
    this.reach = Math.ceil(mating.shapes.longest * SIXTEENTHS_PER_LDU);
    this.keys = new Int32Array(capacity * LINE_KEYS);
    this.order = new Uint32Array(capacity);
    this.connector = new Uint32Array(capacity);
    this.axis = new Int8Array(capacity);
  }

  clear(): void {
    this.size = 0;
  }

  add(connector: number, axis: number, origin: Int32Array): void {
    const n = this.size++;
    const dimension = axisDimension(axis);
    const k = n * LINE_KEYS;
    this.keys[k] = dimension;
    this.keys[k + 1] = origin[(dimension + 1) % VECTOR_FLOATS] ?? 0;
    this.keys[k + 2] = origin[(dimension + 2) % VECTOR_FLOATS] ?? 0;
    this.keys[k + ALONG] = origin[dimension] ?? 0;
    this.connector[n] = connector;
    this.axis[n] = axis;
    this.order[n] = n;
  }

  consume(pairFrame: number | null): number {
    this.pairFrame = pairFrame;
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
    const axis = this.axis[male] ?? 0;
    if (this.axis[female] !== oppositeAxis(axis)) return false;
    if (this.pairFrame !== null && !this.sharesPairFrame(maleConnector, femaleConnector)) {
      return false;
    }
    const offset = (this.along(female) - this.along(male)) * axisSign(axis);
    return this.mating.engages(
      frames.shape[maleConnector] ?? 0,
      frames.shape[femaleConnector] ?? 0,
      offset,
    );
  }

  private sharesPairFrame(maleConnector: number, femaleConnector: number): boolean {
    const a = this.frames.instance[maleConnector] ?? 0;
    const b = this.frames.instance[femaleConnector] ?? 0;
    return a !== b && this.submodelFrames.lowestCommonFrame(a, b) === this.pairFrame;
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
  submodelFrames: SubmodelFrames,
  firstConnector: Uint32Array,
  search: InternalMates,
): number {
  const nodes = submodels.count;
  const bucket = new Uint32Array(nodes + 1);
  for (let i = 0; i < instances.count; i++) {
    for (let n = submodelFrames.frameOf(i); n !== MODEL_ROOT; n = submodelFrames.parentFrame(n)) {
      bucket[n + 1] = (bucket[n + 1] ?? 0) + 1;
    }
  }
  for (let n = 0; n < nodes; n++) bucket[n + 1] = (bucket[n + 1] ?? 0) + (bucket[n] ?? 0);
  const member = new Uint32Array(bucket[nodes] ?? 0);
  const filled = bucket.slice(0, nodes);
  for (let i = 0; i < instances.count; i++) {
    for (let n = submodelFrames.frameOf(i); n !== MODEL_ROOT; n = submodelFrames.parentFrame(n)) {
      const e = filled[n] ?? 0;
      filled[n] = e + 1;
      member[e] = i;
    }
  }
  const transform = new Float64Array(TRANSFORM_FLOATS);
  const point = new IdentifiedPoint();
  let mates = 0;
  for (let n = nodes - 1; n >= 0; n--) {
    search.clear();
    for (let e = bucket[n] ?? 0; e < (bucket[n + 1] ?? 0); e++) {
      const i = member[e] ?? 0;
      const part = parts[instances.partIndex[i] ?? -1];
      if (!part || !submodelFrames.relate(i, n, transform)) continue;
      const first = firstConnector[i] ?? 0;
      for (let c = 0; c < part.count; c++) {
        if (search.consumed[first + c] === 1) continue;
        const axis = identifyConnector(transform, part, c, point);
        if (axis !== AXIS_FREE) search.add(first + c, axis, point.sixteenths);
      }
    }
    mates += search.consume(n);
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
    const submodelFrames = new SubmodelFrames(instances);
    const submodels = instances.submodels;
    const nested = submodels && submodels.count > 0 ? submodels : null;
    const firstConnector = new Uint32Array(nested ? instances.count : 0);
    const frames = allocateFrames(total);
    const search = new InternalMates(frames, total, mating, submodelFrames);
    const transform = new Float64Array(TRANSFORM_FLOATS);
    const point = new IdentifiedPoint();
    let g = 0;
    for (let i = 0; i < instances.count; i++) {
      const part = parts[instances.partIndex[i] ?? -1];
      if (nested) firstConnector[i] = g;
      if (!part) continue;
      submodelFrames.relate(i, MODEL_ROOT, transform);
      for (let c = 0; c < part.count; c++, g++) {
        frames.shape[g] = part.shape[c] ?? 0;
        frames.gender[g] = part.gender[c] ?? 0;
        frames.source[g] = part.source[c] ?? 0;
        frames.status[g] = part.status[c] ?? 0;
        frames.instance[g] = i;
        const axis = identifyConnector(transform, part, c, point);
        frames.axis[g] = axis;
        if (axis === AXIS_FREE) continue;
        frames.origin.set(point.sixteenths, g * VECTOR_FLOATS);
        search.add(g, axis, point.sixteenths);
      }
    }
    let internalMates = search.consume(null);
    if (nested) {
      internalMates += mateInSubmodelFrames(
        parts,
        instances,
        nested,
        submodelFrames,
        firstConnector,
        search,
      );
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

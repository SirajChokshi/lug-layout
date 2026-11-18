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
import { WORLD_TRACK_FRAME, type TrackEnd } from "../track/end-gaps.ts";
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

export const NO_INSTANCE = -1;
const X = 0;
const Y = 1;
const Z = 2;
const LINE_KEYS = 4;
const ALONG = 3;
const INT32_LIMIT = 2 ** 31;
const PART_FRAME = Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0);

type Pass = "model" | "submodel" | "part";

interface Frames {
  readonly shape: Uint16Array;
  readonly gender: Uint8Array;
  readonly source: Uint8Array;
  readonly status: Uint8Array;
  readonly origin: Int32Array;
  readonly axis: Int8Array;
  readonly instance: Uint32Array;
  readonly piece: Uint16Array;
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
    piece: new Uint16Array(count),
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
  readonly instance: Int32Array;
}

function exactTrackEnds(ends: ReadonlyArray<TrackEnd>): TrackEnds {
  const heading = new Uint8Array(ends.length);
  const position = new Int32Array(ends.length * ZETA16_COEFFICIENT_COUNT);
  const yPlates = new Int32Array(ends.length);
  const instance = new Int32Array(ends.length).fill(NO_INSTANCE);
  for (let e = 0; e < ends.length; e++) {
    const end = ends[e];
    if (!end) continue;
    if (end.frame.id !== WORLD_TRACK_FRAME.id) {
      throw new RangeError(`track end ${e} is in run frame ${end.frame.id}, which never joins`);
    }
    heading[e] = end.pose.heading;
    yPlates[e] = end.yPlates;
    if (end.instance !== undefined) {
      if (!Number.isInteger(end.instance) || end.instance < 0) {
        throw new RangeError(
          `track end ${e} names instance ${end.instance}, not an instance index`,
        );
      }
      instance[e] = end.instance;
    }
    for (let k = 0; k < ZETA16_COEFFICIENT_COUNT; k++) {
      const coefficient = Number(end.pose.position[k] ?? 0n);
      if (Math.abs(coefficient) >= INT32_LIMIT) {
        throw new RangeError(`track end ${e} has coefficient ${coefficient}, beyond int32 studs`);
      }
      position[e * ZETA16_COEFFICIENT_COUNT + k] = coefficient;
    }
  }
  return { heading, position, yPlates, instance };
}

class InternalMates {
  readonly consumed: Uint8Array;
  private readonly reach: number;
  private readonly keys: Int32Array;
  private readonly order: Uint32Array;
  private readonly connector: Uint32Array;
  private readonly axis: Int8Array;
  private size = 0;
  private pass: Pass = "model";
  private pairFrame = MODEL_ROOT;
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

  consume(pass: Pass, pairFrame = MODEL_ROOT): number {
    this.pass = pass;
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
        if (this.frames.gender[this.connector[male] ?? 0] !== GENDER_MALE) continue;
        mates += this.occupyAlong(male, i, start, end);
      }
      start = end;
    }
    return mates;
  }

  private occupyAlong(male: number, at: number, start: number, end: number): number {
    const along = this.along(male);
    const reach = this.reach;
    let mates = 0;
    for (let j = at - 1; j >= start && along - this.along(this.order[j] ?? 0) <= reach; j--) {
      mates += this.occupy(male, this.order[j] ?? 0);
    }
    for (let j = at + 1; j < end && this.along(this.order[j] ?? 0) - along <= reach; j++) {
      mates += this.occupy(male, this.order[j] ?? 0);
    }
    return mates;
  }

  private occupy(male: number, female: number): number {
    if (!this.mates(male, female)) return 0;
    this.consumed[this.connector[male] ?? 0] = 1;
    this.consumed[this.connector[female] ?? 0] = 1;
    return 1;
  }

  private mates(male: number, female: number): boolean {
    const frames = this.frames;
    const maleConnector = this.connector[male] ?? 0;
    const femaleConnector = this.connector[female] ?? 0;
    if (frames.gender[femaleConnector] !== GENDER_FEMALE) return false;
    const axis = this.axis[male] ?? 0;
    if (this.axis[female] !== oppositeAxis(axis)) return false;
    if (!this.admits(maleConnector, femaleConnector)) return false;
    const offset = (this.along(female) - this.along(male)) * axisSign(axis);
    return this.mating.engages(
      frames.shape[maleConnector] ?? 0,
      frames.shape[femaleConnector] ?? 0,
      offset,
    );
  }

  private admits(maleConnector: number, femaleConnector: number): boolean {
    const frames = this.frames;
    const a = frames.instance[maleConnector] ?? 0;
    const b = frames.instance[femaleConnector] ?? 0;
    if (a === b && frames.piece[maleConnector] === frames.piece[femaleConnector]) return false;
    const judgedInModelFrame =
      frames.axis[maleConnector] !== AXIS_FREE && frames.axis[femaleConnector] !== AXIS_FREE;
    switch (this.pass) {
      case "model":
        return true;
      case "part":
        return a === b && !judgedInModelFrame;
      case "submodel":
        return (
          a !== b &&
          !judgedInModelFrame &&
          this.submodelFrames.lowestCommonFrame(a, b) === this.pairFrame
        );
      default: {
        const exhaustive: never = this.pass;
        throw new Error(`unhandled pass ${String(exhaustive)}`);
      }
    }
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

function leavesModelFrame(part: ConnectorTable, first: number, modelFrameAxis: Int8Array): boolean {
  for (let c = 0; c < part.count; c++) {
    if (modelFrameAxis[first + c] === AXIS_FREE) return true;
  }
  return false;
}

function holdsConnectorOffModelFrame(
  parts: ReadonlyArray<ConnectorTable | null>,
  instances: PartInstances,
  members: Uint32Array,
  firstConnector: Uint32Array,
  modelFrameAxis: Int8Array,
): boolean {
  for (let e = 0; e < members.length; e++) {
    const i = members[e] ?? 0;
    const part = parts[instances.partIndex[i] ?? -1];
    if (part && leavesModelFrame(part, firstConnector[i] ?? 0, modelFrameAxis)) return true;
  }
  return false;
}

function mateInSubmodelFrames(
  parts: ReadonlyArray<ConnectorTable | null>,
  instances: PartInstances,
  submodels: SubmodelInstances,
  submodelFrames: SubmodelFrames,
  firstConnector: Uint32Array,
  modelFrameAxis: Int8Array,
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
    const members = member.subarray(bucket[n] ?? 0, bucket[n + 1] ?? 0);
    if (!holdsConnectorOffModelFrame(parts, instances, members, firstConnector, modelFrameAxis)) {
      continue;
    }
    search.clear();
    for (let e = bucket[n] ?? 0; e < (bucket[n + 1] ?? 0); e++) {
      const i = member[e] ?? 0;
      const part = parts[instances.partIndex[i] ?? -1];
      if (!part || !submodelFrames.relate(i, n, transform)) continue;
      const first = firstConnector[i] ?? 0;
      for (let c = 0; c < part.count; c++) {
        const axis = identifyConnector(transform, part, c, point);
        if (axis !== AXIS_FREE) search.add(first + c, axis, point.sixteenths);
      }
    }
    mates += search.consume("submodel", n);
  }
  return mates;
}

function hasSeveralPieces(part: ConnectorTable | null | undefined): boolean {
  if (!part) return false;
  const first = part.piece[0] ?? 0;
  for (let c = 1; c < part.count; c++) if (part.piece[c] !== first) return true;
  return false;
}

function mateInPartFrames(
  parts: ReadonlyArray<ConnectorTable | null>,
  instances: PartInstances,
  firstConnector: Uint32Array,
  modelFrameAxis: Int8Array,
  search: InternalMates,
): number {
  const pieced = new Uint8Array(parts.length);
  for (let p = 0; p < parts.length; p++) pieced[p] = hasSeveralPieces(parts[p]) ? 1 : 0;
  const point = new IdentifiedPoint();
  let mates = 0;
  for (let i = 0; i < instances.count; i++) {
    const index = instances.partIndex[i] ?? -1;
    const part = parts[index];
    if (!part || pieced[index] !== 1) continue;
    const first = firstConnector[i] ?? 0;
    if (!leavesModelFrame(part, first, modelFrameAxis)) continue;
    search.clear();
    for (let c = 0; c < part.count; c++) {
      const axis = identifyConnector(PART_FRAME, part, c, point);
      if (axis !== AXIS_FREE) search.add(first + c, axis, point.sixteenths);
    }
    mates += search.consume("part");
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
    readonly trackInstance: Int32Array,
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
    const firstConnector = new Uint32Array(instances.count);
    const frames = allocateFrames(total);
    const search = new InternalMates(frames, total, mating, submodelFrames);
    const transform = new Float64Array(TRANSFORM_FLOATS);
    const point = new IdentifiedPoint();
    let g = 0;
    for (let i = 0; i < instances.count; i++) {
      const part = parts[instances.partIndex[i] ?? -1];
      firstConnector[i] = g;
      if (!part) continue;
      submodelFrames.relate(i, MODEL_ROOT, transform);
      for (let c = 0; c < part.count; c++, g++) {
        frames.shape[g] = part.shape[c] ?? 0;
        frames.gender[g] = part.gender[c] ?? 0;
        frames.source[g] = part.source[c] ?? 0;
        frames.status[g] = part.status[c] ?? 0;
        frames.instance[g] = i;
        frames.piece[g] = part.piece[c] ?? 0;
        const axis = identifyConnector(transform, part, c, point);
        frames.axis[g] = axis;
        if (axis === AXIS_FREE) continue;
        frames.origin.set(point.sixteenths, g * VECTOR_FLOATS);
        search.add(g, axis, point.sixteenths);
      }
    }
    let internalMates = search.consume("model");
    if (nested) {
      internalMates += mateInSubmodelFrames(
        parts,
        instances,
        nested,
        submodelFrames,
        firstConnector,
        frames.axis,
        search,
      );
    }
    internalMates += mateInPartFrames(parts, instances, firstConnector, frames.axis, search);
    let occupied = 0;
    let offLattice = 0;
    for (let k = 0; k < total; k++) {
      if (search.consumed[k] === 1) occupied++;
      else if (frames.axis[k] === AXIS_FREE) offLattice++;
    }
    const exposed = allocateFrames(total - occupied - offLattice);
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
      track.instance,
    );
  }
}

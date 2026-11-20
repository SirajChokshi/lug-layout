import {
  connectorOriginLdu,
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
import {
  MATE_PASS_MODEL,
  MATE_PASS_PART,
  MATE_PASS_SUBMODEL,
  MatePairs,
  type MatePass,
} from "./mate-pairs.ts";
import { SPAN_FLOATS, SPAN_FROM, SPAN_TO, type SnapMating } from "./mating.ts";
import { CAP_FAR, CAP_ROOT, type SnapShapes } from "./snap-shapes.ts";
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
const INITIAL_MATES = 64;

interface Frames {
  readonly shape: Uint16Array;
  readonly gender: Uint8Array;
  readonly source: Uint8Array;
  readonly status: Uint8Array;
  readonly origin: Int32Array;
  readonly axis: Int8Array;
  readonly instance: Uint32Array;
  readonly connector: Uint32Array;
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
    connector: new Uint32Array(count),
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
  const identified = identifyPoint(
    transform,
    connectorOriginLdu(part, connector, X),
    connectorOriginLdu(part, connector, Y),
    connectorOriginLdu(part, connector, Z),
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

function doubled<A extends Uint8Array | Uint16Array | Uint32Array | Int32Array | Float64Array>(
  array: A,
  allocate: (length: number) => A,
): A {
  const next = allocate(array.length * 2);
  next.set(array);
  return next;
}

class MateRecorder {
  private male = new Uint32Array(INITIAL_MATES);
  private female = new Uint32Array(INITIAL_MATES);
  private pass = new Uint8Array(INITIAL_MATES);
  private offset = new Int32Array(INITIAL_MATES);
  private size = 0;

  get count(): number {
    return this.size;
  }

  append(male: number, female: number, pass: MatePass, offset: number): void {
    if (this.size === this.male.length) {
      this.male = doubled(this.male, (length) => new Uint32Array(length));
      this.female = doubled(this.female, (length) => new Uint32Array(length));
      this.pass = doubled(this.pass, (length) => new Uint8Array(length));
      this.offset = doubled(this.offset, (length) => new Int32Array(length));
    }
    const k = this.size++;
    this.male[k] = male;
    this.female[k] = female;
    this.pass[k] = pass;
    this.offset[k] = offset;
  }

  private orderByMale(connectors: number): Uint32Array {
    const count = this.size;
    const end = new Uint32Array(connectors + 1);
    for (let k = 0; k < count; k++) {
      const bucket = (this.male[k] ?? 0) + 1;
      end[bucket] = (end[bucket] ?? 0) + 1;
    }
    for (let c = 0; c < connectors; c++) end[c + 1] = (end[c + 1] ?? 0) + (end[c] ?? 0);
    const order = new Uint32Array(count);
    for (let k = 0; k < count; k++) {
      const m = this.male[k] ?? 0;
      const at = end[m] ?? 0;
      order[at] = k;
      end[m] = at + 1;
    }
    return order;
  }

  private sortEachMaleByFemale(order: Uint32Array): void {
    const male = this.male;
    const female = this.female;
    for (let i = 1; i < order.length; i++) {
      const r = order[i] ?? 0;
      const m = male[r] ?? 0;
      const f = female[r] ?? 0;
      let j = i - 1;
      for (; j >= 0; j--) {
        const s = order[j] ?? 0;
        if (male[s] !== m || (female[s] ?? 0) < f) break;
        order[j + 1] = s;
      }
      order[j + 1] = r;
    }
  }

  pairs(
    frames: Frames,
    parts: ReadonlyArray<ConnectorTable | null>,
    instances: PartInstances,
  ): MatePairs {
    const count = this.size;
    const order = this.orderByMale(frames.instance.length);
    this.sortEachMaleByFemale(order);
    const male = this.male;
    const female = this.female;
    const maleInstance = new Uint32Array(count);
    const femaleInstance = new Uint32Array(count);
    const maleConnector = new Uint32Array(count);
    const femaleConnector = new Uint32Array(count);
    const pass = new Uint8Array(count);
    const mateAxis = new Int8Array(count);
    const mateOffset = new Int32Array(count);
    for (let k = 0; k < count; k++) {
      const r = order[k] ?? 0;
      const m = male[r] ?? 0;
      const f = female[r] ?? 0;
      const instance = frames.instance[m] ?? 0;
      const local = frames.connector[m] ?? 0;
      maleInstance[k] = instance;
      femaleInstance[k] = frames.instance[f] ?? 0;
      maleConnector[k] = local;
      femaleConnector[k] = frames.connector[f] ?? 0;
      pass[k] = this.pass[r] ?? MATE_PASS_MODEL;
      mateAxis[k] = parts[instances.partIndex[instance] ?? -1]?.axis[local] ?? AXIS_FREE;
      mateOffset[k] = this.offset[r] ?? 0;
    }
    return new MatePairs(
      maleInstance,
      femaleInstance,
      maleConnector,
      femaleConnector,
      pass,
      mateAxis,
      mateOffset,
    );
  }
}

const NO_ENGAGED_TIP = 0;
const NO_ENGAGED_ENTRANCE = Number.POSITIVE_INFINITY;

class InternalMates {
  readonly matedInside: Uint8Array;
  readonly maleEngagedTo: Float64Array;
  readonly femaleEngagedFrom: Float64Array;
  private readonly span = new Float64Array(SPAN_FLOATS);
  readonly records = new MateRecorder();
  private readonly reach: number;
  private readonly keys: Int32Array;
  private readonly order: Uint32Array;
  private readonly connector: Uint32Array;
  private readonly axis: Int8Array;
  private size = 0;
  private pass: MatePass = MATE_PASS_MODEL;
  private pairFrame = MODEL_ROOT;
  private readonly byLine = (a: number, b: number): number => this.compare(a, b, LINE_KEYS);

  constructor(
    private readonly frames: Frames,
    capacity: number,
    private readonly mating: SnapMating,
    private readonly submodelFrames: SubmodelFrames,
  ) {
    this.matedInside = new Uint8Array(capacity);
    this.maleEngagedTo = new Float64Array(capacity).fill(NO_ENGAGED_TIP);
    this.femaleEngagedFrom = new Float64Array(capacity).fill(NO_ENGAGED_ENTRANCE);
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

  consume(pass: MatePass, pairFrame = MODEL_ROOT): void {
    this.pass = pass;
    this.pairFrame = pairFrame;
    const count = this.size;
    this.order.subarray(0, count).sort(this.byLine);
    let start = 0;
    while (start < count) {
      const first = this.order[start] ?? 0;
      let end = start + 1;
      while (end < count && this.compare(first, this.order[end] ?? 0, ALONG) === 0) end++;
      for (let i = start; i < end; i++) {
        const male = this.order[i] ?? 0;
        if (this.frames.gender[this.connector[male] ?? 0] !== GENDER_MALE) continue;
        this.occupyAlong(male, i, start, end);
      }
      start = end;
    }
  }

  private occupyAlong(male: number, at: number, start: number, end: number): void {
    const along = this.along(male);
    const reach = this.reach;
    for (let j = at - 1; j >= start && along - this.along(this.order[j] ?? 0) <= reach; j--) {
      this.occupy(male, this.order[j] ?? 0);
    }
    for (let j = at + 1; j < end && this.along(this.order[j] ?? 0) - along <= reach; j++) {
      this.occupy(male, this.order[j] ?? 0);
    }
  }

  private occupy(male: number, female: number): void {
    const frames = this.frames;
    const maleConnector = this.connector[male] ?? 0;
    const femaleConnector = this.connector[female] ?? 0;
    if (frames.gender[femaleConnector] !== GENDER_FEMALE) return;
    const axis = this.axis[male] ?? 0;
    if (this.axis[female] !== oppositeAxis(axis)) return;
    if (!this.admits(maleConnector, femaleConnector)) return;
    const offset = (this.along(female) - this.along(male)) * axisSign(axis);
    const maleShape = frames.shape[maleConnector] ?? 0;
    const femaleShape = frames.shape[femaleConnector] ?? 0;
    if (!this.mating.engages(maleShape, femaleShape, offset)) return;
    this.mating.engagedSpan(maleShape, femaleShape, offset, this.span);
    this.maleEngagedTo[maleConnector] = Math.max(
      this.maleEngagedTo[maleConnector] ?? NO_ENGAGED_TIP,
      this.span[SPAN_TO] ?? 0,
    );
    this.femaleEngagedFrom[femaleConnector] = Math.min(
      this.femaleEngagedFrom[femaleConnector] ?? NO_ENGAGED_ENTRANCE,
      (this.span[SPAN_FROM] ?? 0) - offset,
    );
    this.matedInside[maleConnector] = 1;
    this.matedInside[femaleConnector] = 1;
    this.records.append(maleConnector, femaleConnector, this.pass, offset);
  }

  private admits(maleConnector: number, femaleConnector: number): boolean {
    const frames = this.frames;
    const a = frames.instance[maleConnector] ?? 0;
    const b = frames.instance[femaleConnector] ?? 0;
    if (a === b && frames.piece[maleConnector] === frames.piece[femaleConnector]) return false;
    const judgedInModelFrame =
      frames.axis[maleConnector] !== AXIS_FREE && frames.axis[femaleConnector] !== AXIS_FREE;
    switch (this.pass) {
      case MATE_PASS_MODEL:
        return true;
      case MATE_PASS_PART:
        return a === b && !judgedInModelFrame;
      case MATE_PASS_SUBMODEL:
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
): void {
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
    search.consume(MATE_PASS_SUBMODEL, n);
  }
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
): void {
  const pieced = new Uint8Array(parts.length);
  for (let p = 0; p < parts.length; p++) pieced[p] = hasSeveralPieces(parts[p]) ? 1 : 0;
  const point = new IdentifiedPoint();
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
    search.consume(MATE_PASS_PART);
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
    readonly connector: Uint32Array,
    readonly mates: MatePairs,
    readonly offLattice: number,
    readonly instancesWithoutConnectors: number,
    readonly trackEndCount: number,
    readonly trackHeading: Uint8Array,
    readonly trackPosition: Int32Array,
    readonly trackYPlates: Int32Array,
    readonly trackInstance: Int32Array,
  ) {}

  get internalMates(): number {
    return this.mates.count;
  }

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
        frames.connector[g] = c;
        frames.piece[g] = part.piece[c] ?? 0;
        const axis = identifyConnector(transform, part, c, point);
        frames.axis[g] = axis;
        if (axis === AXIS_FREE) continue;
        frames.origin.set(point.sixteenths, g * VECTOR_FLOATS);
        search.add(g, axis, point.sixteenths);
      }
    }
    search.consume(MATE_PASS_MODEL);
    if (nested) {
      mateInSubmodelFrames(
        parts,
        instances,
        nested,
        submodelFrames,
        firstConnector,
        frames.axis,
        search,
      );
    }
    mateInPartFrames(parts, instances, firstConnector, frames.axis, search);
    const shapes = mating.shapes;
    const stretch = new Float64Array(STRETCH_FLOATS);
    const cover = new ExactCover();
    const pieces = new OpenEndPieces();
    let whole = 0;
    let offLattice = 0;
    for (let i = 0; i < instances.count; i++) {
      const part = parts[instances.partIndex[i] ?? -1];
      if (!part) continue;
      const first = firstConnector[i] ?? 0;
      const end = first + part.count;
      const firstPiece = pieces.count;
      for (let k = first; k < end; k++) {
        if (search.matedInside[k] !== 1) {
          if (frames.axis[k] === AXIS_FREE) offLattice++;
          else whole++;
          continue;
        }
        if (frames.axis[k] === AXIS_FREE) continue;
        const found = freeStretch(shapes, frames, search, k, stretch);
        if (found === FREE_STRETCH_OFF_LATTICE) offLattice++;
        else if (found === FREE_STRETCH) {
          offLattice += exposeUncovered(
            shapes,
            frames,
            search.matedInside,
            cover,
            pieces,
            k,
            first,
            end,
            firstPiece,
            stretch,
          );
        }
      }
    }
    const exposed = allocateFrames(whole + pieces.count);
    let n = 0;
    let piece = 0;
    for (let k = 0; k < total; k++) {
      if (search.matedInside[k] !== 1) {
        if (frames.axis[k] !== AXIS_FREE) expose(exposed, n++, frames, k, frames.shape[k] ?? 0, 0);
        continue;
      }
      for (; piece < pieces.count && pieces.connector[piece] === k; piece++) {
        expose(exposed, n++, frames, k, pieces.shape[piece] ?? 0, pieces.from[piece] ?? 0);
      }
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
      exposed.connector,
      search.records.pairs(frames, parts, instances),
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

const FREE_STRETCH = 0;
const NO_FREE_STRETCH = -1;
const FREE_STRETCH_OFF_LATTICE = -2;
const STRETCH_FROM = 0;
const STRETCH_TO = 1;
const STRETCH_FLOATS = 2;
const INITIAL_PIECES = 16;

function freeStretch(
  shapes: SnapShapes,
  frames: Frames,
  search: InternalMates,
  k: number,
  out: Float64Array,
): number {
  const shape = frames.shape[k] ?? 0;
  const length = shapes.length(shape) * SIXTEENTHS_PER_LDU;
  if (frames.gender[k] === GENDER_MALE) {
    const engagedTo = search.maleEngagedTo[k] ?? NO_ENGAGED_TIP;
    if ((shapes.caps(shape) & CAP_FAR) !== 0 || engagedTo >= length) return NO_FREE_STRETCH;
    if (!Number.isInteger(engagedTo)) return FREE_STRETCH_OFF_LATTICE;
    out[STRETCH_FROM] = engagedTo;
    out[STRETCH_TO] = length;
    return FREE_STRETCH;
  }
  const engagedFrom = search.femaleEngagedFrom[k] ?? NO_ENGAGED_ENTRANCE;
  if (engagedFrom <= 0 || engagedFrom >= length) return NO_FREE_STRETCH;
  out[STRETCH_FROM] = 0;
  out[STRETCH_TO] = engagedFrom;
  return FREE_STRETCH;
}

function extentSign(gender: number, axis: number): number {
  return gender === GENDER_MALE ? axisSign(axis) : -axisSign(axis);
}

class OpenEndPieces {
  connector = new Uint32Array(INITIAL_PIECES);
  shape = new Uint16Array(INITIAL_PIECES);
  from = new Float64Array(INITIAL_PIECES);
  to = new Float64Array(INITIAL_PIECES);
  count = 0;

  append(connector: number, shape: number, from: number, to: number): void {
    if (this.count === this.connector.length) {
      this.connector = doubled(this.connector, (length) => new Uint32Array(length));
      this.shape = doubled(this.shape, (length) => new Uint16Array(length));
      this.from = doubled(this.from, (length) => new Float64Array(length));
      this.to = doubled(this.to, (length) => new Float64Array(length));
    }
    const p = this.count++;
    this.connector[p] = connector;
    this.shape[p] = shape;
    this.from[p] = from;
    this.to[p] = to;
  }
}

class ExactCover {
  private covered = new Float64Array(INITIAL_PIECES * STRETCH_FLOATS);
  private coveredCount = 0;
  private remainder = new Float64Array(INITIAL_PIECES * STRETCH_FLOATS);

  clear(): void {
    this.coveredCount = 0;
  }

  add(from: number, to: number): void {
    if ((this.coveredCount + 1) * STRETCH_FLOATS > this.covered.length) {
      this.covered = doubled(this.covered, (length) => new Float64Array(length));
    }
    let at = this.coveredCount++;
    while (at > 0 && (this.covered[(at - 1) * STRETCH_FLOATS + STRETCH_FROM] ?? 0) > from) {
      this.covered[at * STRETCH_FLOATS + STRETCH_FROM] =
        this.covered[(at - 1) * STRETCH_FLOATS + STRETCH_FROM] ?? 0;
      this.covered[at * STRETCH_FLOATS + STRETCH_TO] =
        this.covered[(at - 1) * STRETCH_FLOATS + STRETCH_TO] ?? 0;
      at--;
    }
    this.covered[at * STRETCH_FLOATS + STRETCH_FROM] = from;
    this.covered[at * STRETCH_FLOATS + STRETCH_TO] = to;
  }

  remainders(from: number, to: number): number {
    let count = 0;
    let cursor = from;
    for (let c = 0; c < this.coveredCount; c++) {
      const start = this.covered[c * STRETCH_FLOATS + STRETCH_FROM] ?? 0;
      if (start > cursor) count = this.keep(count, cursor, start);
      cursor = Math.max(cursor, this.covered[c * STRETCH_FLOATS + STRETCH_TO] ?? 0);
    }
    if (to > cursor) count = this.keep(count, cursor, to);
    return count;
  }

  remainderFrom(r: number): number {
    return this.remainder[r * STRETCH_FLOATS + STRETCH_FROM] ?? 0;
  }

  remainderTo(r: number): number {
    return this.remainder[r * STRETCH_FLOATS + STRETCH_TO] ?? 0;
  }

  private keep(count: number, from: number, to: number): number {
    if ((count + 1) * STRETCH_FLOATS > this.remainder.length) {
      this.remainder = doubled(this.remainder, (length) => new Float64Array(length));
    }
    this.remainder[count * STRETCH_FLOATS + STRETCH_FROM] = from;
    this.remainder[count * STRETCH_FLOATS + STRETCH_TO] = to;
    return count + 1;
  }
}

function coverExactly(
  shapes: SnapShapes,
  frames: Frames,
  cover: ExactCover,
  k: number,
  from: number,
  to: number,
  other: number,
  otherFrom: number,
  otherTo: number,
): void {
  const axis = frames.axis[k] ?? 0;
  if (frames.gender[other] !== frames.gender[k] || frames.axis[other] !== axis) return;
  const dimension = axisDimension(axis);
  const own = k * VECTOR_FLOATS;
  const theirs = other * VECTOR_FLOATS;
  for (let side = 1; side < VECTOR_FLOATS; side++) {
    const across = (dimension + side) % VECTOR_FLOATS;
    if (frames.origin[theirs + across] !== frames.origin[own + across]) return;
  }
  const shift =
    ((frames.origin[theirs + dimension] ?? 0) - (frames.origin[own + dimension] ?? 0)) *
    extentSign(frames.gender[k] ?? 0, axis);
  const start = Math.max(from, otherFrom + shift);
  const end = Math.min(to, otherTo + shift);
  if (!(end > start)) return;
  const compatible = shapes.sameSectionsOver(
    frames.shape[k] ?? 0,
    start / SIXTEENTHS_PER_LDU,
    frames.shape[other] ?? 0,
    (start - shift) / SIXTEENTHS_PER_LDU,
    (end - start) / SIXTEENTHS_PER_LDU,
  );
  if (compatible) cover.add(start, end);
}

function exposeUncovered(
  shapes: SnapShapes,
  frames: Frames,
  matedInside: Uint8Array,
  cover: ExactCover,
  pieces: OpenEndPieces,
  k: number,
  first: number,
  end: number,
  firstPiece: number,
  stretch: Float64Array,
): number {
  const from = stretch[STRETCH_FROM] ?? 0;
  const to = stretch[STRETCH_TO] ?? 0;
  cover.clear();
  for (let j = first; j < end; j++) {
    if (j === k || matedInside[j] === 1 || frames.axis[j] === AXIS_FREE) continue;
    const length = shapes.length(frames.shape[j] ?? 0) * SIXTEENTHS_PER_LDU;
    coverExactly(shapes, frames, cover, k, from, to, j, 0, length);
  }
  for (let p = firstPiece; p < pieces.count; p++) {
    const other = pieces.connector[p] ?? 0;
    coverExactly(shapes, frames, cover, k, from, to, other, pieces.from[p] ?? 0, pieces.to[p] ?? 0);
  }
  const male = frames.gender[k] === GENDER_MALE;
  const shape = frames.shape[k] ?? 0;
  const count = cover.remainders(from, to);
  let offLattice = 0;
  for (let r = 0; r < count; r++) {
    const start = cover.remainderFrom(r);
    const stop = cover.remainderTo(r);
    const offGrid =
      (start !== from && !Number.isInteger(start)) || (stop !== to && !Number.isInteger(stop));
    if (offGrid) {
      offLattice++;
      continue;
    }
    const closes = male ? CAP_ROOT | (stop < to ? CAP_FAR : 0) : CAP_FAR;
    pieces.append(
      k,
      shapes.clipped(shape, start / SIXTEENTHS_PER_LDU, stop / SIXTEENTHS_PER_LDU, closes),
      start,
      stop,
    );
  }
  return offLattice;
}

function expose(
  exposed: Frames,
  n: number,
  frames: Frames,
  k: number,
  shape: number,
  from: number,
): void {
  exposed.shape[n] = shape;
  exposed.gender[n] = frames.gender[k] ?? 0;
  exposed.source[n] = frames.source[k] ?? 0;
  exposed.status[n] = frames.status[k] ?? 0;
  exposed.axis[n] = frames.axis[k] ?? 0;
  exposed.instance[n] = frames.instance[k] ?? 0;
  exposed.connector[n] = frames.connector[k] ?? 0;
  for (let v = 0; v < VECTOR_FLOATS; v++) {
    exposed.origin[n * VECTOR_FLOATS + v] = frames.origin[k * VECTOR_FLOATS + v] ?? 0;
  }
  const axis = frames.axis[k] ?? 0;
  const at = n * VECTOR_FLOATS + axisDimension(axis);
  exposed.origin[at] = (exposed.origin[at] ?? 0) + extentSign(frames.gender[k] ?? 0, axis) * from;
}

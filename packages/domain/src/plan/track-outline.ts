import {
  HALF_TURN_16,
  QUARTER_TURN_16,
  STUD_LDU,
  ZETA16_COEFFICIENT_COUNT,
  composePose16,
  conjugateZeta16,
  multiplyZeta16,
  normalizeHeading16,
  subtractZeta16,
  zeta16,
  zeta16ImaginarySign,
  zeta16RealSign,
  type Pose16,
  type Sign,
  type Zeta16,
} from "@brr/math";
import { OUTLINE_UNITS_PER_LDU } from "@brr/schema/bundle";
import { dyadic, type ExactRect } from "./exact-rect.ts";
import type { OutlineRing } from "./placed-outline.ts";
import { ALONG_X, EDGE_AXIS, EDGE_FROM, EDGE_LINE, EDGE_TO } from "./plan-table-edges.ts";

interface ExactValue {
  readonly num: bigint;
  readonly shift: number;
}

const UNIT = OUTLINE_UNITS_PER_LDU;
const UNIT_BIG = BigInt(OUTLINE_UNITS_PER_LDU);
const ORIGIN_UNITS = BigInt(STUD_LDU) * UNIT_BIG;
const COS_EIGHTH = Math.sqrt(2 + Math.SQRT2) / 2;
const COS_QUARTER = Math.SQRT1_2;
const COS_THREE_EIGHTHS = Math.sqrt(2 - Math.SQRT2) / 2;
const ROUNDING = 16 * Number.EPSILON;
const SAFE_COEFFICIENT = 2 ** 50;
const SAFE_DIFFERENCE = 2 ** 51;
const SPLITTER = 2 ** 27 + 1;
const UNSURE = 2;
const HALF_ORDER = ZETA16_COEFFICIENT_COUNT;

const VERTEX_FLOATS = 6;
const AT_X = 0;
const AT_Z = 1;
const AT_X_ERROR = 2;
const AT_Z_ERROR = 3;
const AT_X_EXACT = 4;
const AT_Z_EXACT = 5;
const FIRST = 0;
const SECOND = VERTEX_FLOATS;

const MIN_X = 0;
const MAX_X = 1;
const MIN_Z = 2;
const MAX_Z = 3;
const PROBE_X = 4;
const PROBE_Z = 5;
const QUERY_VALUES = 6;
const CORNER_X: readonly number[] = [MIN_X, MAX_X, MAX_X, MIN_X];
const CORNER_Z: readonly number[] = [MIN_Z, MIN_Z, MAX_Z, MAX_Z];

const vertices = new Float64Array(2 * VERTEX_FLOATS);
const coefficients = new Float64Array(ZETA16_COEFFICIENT_COUNT);
const queryUnits = new Float64Array(QUERY_VALUES);
const queryErrors = new Float64Array(QUERY_VALUES);
const queryLdu = new Float64Array(QUERY_VALUES);
const queryExact: Array<ExactValue | null> = Array.from({ length: QUERY_VALUES }, () => null);
const terms = new Float64Array(4);
const expansion = new Float64Array(8);
const UNIT_HIGH = SPLITTER * UNIT - (SPLITTER * UNIT - UNIT);
const UNIT_LOW = UNIT - UNIT_HIGH;
let queryHasFloats = true;

function signOfTerms(count: number): Sign {
  let size = 0;
  for (let t = 0; t < count; t++) {
    let q = terms[t] ?? 0;
    for (let i = 0; i < size; i++) {
      const e = expansion[i] ?? 0;
      const sum = q + e;
      const bv = sum - q;
      const av = sum - bv;
      expansion[i] = q - av + (e - bv);
      q = sum;
    }
    expansion[size++] = q;
  }
  for (let i = size - 1; i >= 0; i--) {
    const value = expansion[i] ?? 0;
    if (value > 0) return 1;
    if (value < 0) return -1;
  }
  return 0;
}

function planValue(x: bigint, z: bigint): Zeta16 {
  return zeta16([x, 0n, 0n, 0n, z, 0n, 0n, 0n]);
}

function scaledBy(value: Zeta16, shift: number): Zeta16 {
  const factor = 1n << BigInt(shift);
  return zeta16(value.map((coefficient) => coefficient * factor));
}

function exactOfLdu(ldu: number): ExactValue {
  const { mantissa, exponent } = dyadic(ldu);
  return exponent >= 0
    ? { num: mantissa << BigInt(exponent), shift: 0 }
    : { num: mantissa, shift: -exponent };
}

function aligned(value: ExactValue, shift: number): bigint {
  return value.num * UNIT_BIG * (1n << BigInt(shift - value.shift));
}

function exactQueryValue(slot: number): ExactValue {
  const known = queryExact[slot];
  if (known) return known;
  const computed = exactOfLdu(queryLdu[slot] ?? Number.NaN);
  queryExact[slot] = computed;
  return computed;
}

function prepareQueryValue(slot: number): void {
  const ldu = queryLdu[slot] ?? Number.NaN;
  const units = ldu * UNIT;
  const scaled = SPLITTER * ldu;
  const high = scaled - (scaled - ldu);
  const low = ldu - high;
  queryUnits[slot] = units;
  queryErrors[slot] =
    low * UNIT_LOW - (units - high * UNIT_HIGH - low * UNIT_HIGH - high * UNIT_LOW);
  queryExact[slot] = null;
}

function compareCoordinate(at: number, axis: number, slot: number): number {
  const value = vertices[at + axis] ?? Number.NaN;
  const error = vertices[at + AT_X_ERROR + axis] ?? Number.NaN;
  const target = queryUnits[slot] ?? Number.NaN;
  const targetError = queryErrors[slot] ?? Number.NaN;
  if (vertices[at + AT_X_EXACT + axis] === 1 && targetError === 0) {
    return value > target ? 1 : value < target ? -1 : 0;
  }
  const difference = value - target;
  const bound = error + Math.abs(targetError) + ROUNDING * (Math.abs(value) + Math.abs(target));
  if (difference > bound) return 1;
  if (difference < -bound) return -1;
  return UNSURE;
}

function orientFloat(a: number, b: number, xSlot: number, zSlot: number): number {
  const ax = vertices[a + AT_X] ?? Number.NaN;
  const az = vertices[a + AT_Z] ?? Number.NaN;
  const bx = vertices[b + AT_X] ?? Number.NaN;
  const bz = vertices[b + AT_Z] ?? Number.NaN;
  const cx = queryUnits[xSlot] ?? Number.NaN;
  const cz = queryUnits[zSlot] ?? Number.NaN;
  const cxError = Math.abs(queryErrors[xSlot] ?? Number.NaN);
  const czError = Math.abs(queryErrors[zSlot] ?? Number.NaN);
  const ux = bx - ax;
  const uz = bz - az;
  const wx = cx - ax;
  const wz = cz - az;
  const integers =
    vertices[a + AT_X_EXACT] === 1 &&
    vertices[a + AT_Z_EXACT] === 1 &&
    vertices[b + AT_X_EXACT] === 1 &&
    vertices[b + AT_Z_EXACT] === 1 &&
    cxError === 0 &&
    czError === 0 &&
    Number.isInteger(cx) &&
    Number.isInteger(cz) &&
    Math.abs(cx) < SAFE_DIFFERENCE &&
    Math.abs(cz) < SAFE_DIFFERENCE;
  if (integers) {
    const first = ux * wz;
    const second = uz * wx;
    let scaled = SPLITTER * ux;
    const uxHigh = scaled - (scaled - ux);
    const uxLow = ux - uxHigh;
    scaled = SPLITTER * wz;
    const wzHigh = scaled - (scaled - wz);
    const wzLow = wz - wzHigh;
    scaled = SPLITTER * uz;
    const uzHigh = scaled - (scaled - uz);
    const uzLow = uz - uzHigh;
    scaled = SPLITTER * wx;
    const wxHigh = scaled - (scaled - wx);
    const wxLow = wx - wxHigh;
    terms[0] = first;
    terms[1] = uxLow * wzLow - (first - uxHigh * wzHigh - uxLow * wzHigh - uxHigh * wzLow);
    terms[2] = -second;
    terms[3] = -(uzLow * wxLow - (second - uzHigh * wxHigh - uzLow * wxHigh - uzHigh * wxLow));
    return signOfTerms(4);
  }
  const axError = vertices[a + AT_X_ERROR] ?? Number.NaN;
  const azError = vertices[a + AT_Z_ERROR] ?? Number.NaN;
  const uxError = axError + (vertices[b + AT_X_ERROR] ?? Number.NaN) + ROUNDING * Math.abs(ux);
  const uzError = azError + (vertices[b + AT_Z_ERROR] ?? Number.NaN) + ROUNDING * Math.abs(uz);
  const wxError = axError + cxError + ROUNDING * Math.abs(wx);
  const wzError = azError + czError + ROUNDING * Math.abs(wz);
  const value = ux * wz - uz * wx;
  const bound =
    (Math.abs(ux) + uxError) * wzError +
    (Math.abs(wz) + wzError) * uxError +
    (Math.abs(uz) + uzError) * wxError +
    (Math.abs(wx) + wxError) * uzError +
    ROUNDING * (Math.abs(ux * wz) + Math.abs(uz * wx));
  if (value > bound) return 1;
  if (value < -bound) return -1;
  return UNSURE;
}

interface LinePiece {
  readonly low: bigint;
  readonly high: bigint;
  readonly sign: number;
}

interface LineGroup {
  readonly pieces: LinePiece[];
  readonly points: Map<bigint, readonly [number, number]>;
}

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function lineGroups(rings: ReadonlyArray<OutlineRing>): ReadonlyArray<LineGroup> {
  const groups = new Map<string, LineGroup>();
  for (const ring of rings) {
    ring.forEach((a, i) => {
      const b = ring[(i + 1) % ring.length];
      if (!b || (a[0] === b[0] && a[1] === b[1])) return;
      const [ax, az] = [BigInt(a[0]), BigInt(a[1])];
      const [bx, bz] = [BigInt(b[0]), BigInt(b[1])];
      const step = gcd(bx - ax, bz - az);
      let ux = (bx - ax) / step;
      let uz = (bz - az) / step;
      const backwards = ux < 0n || (ux === 0n && uz < 0n);
      if (backwards) [ux, uz] = [-ux, -uz];
      const key = `${ux}:${uz}:${ux * az - uz * ax}`;
      const group: LineGroup = groups.get(key) ?? { pieces: [], points: new Map() };
      groups.set(key, group);
      const ta = ux * ax + uz * az;
      const tb = ux * bx + uz * bz;
      group.pieces.push({
        low: ta < tb ? ta : tb,
        high: ta < tb ? tb : ta,
        sign: backwards ? -1 : 1,
      });
      group.points.set(ta, a);
      group.points.set(tb, b);
    });
  }
  return [...groups.values()];
}

function netSegments(
  group: LineGroup,
): ReadonlyArray<readonly [readonly [number, number], readonly [number, number], number]> {
  const stops = [...group.points.keys()].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const segments: Array<readonly [readonly [number, number], readonly [number, number], number]> =
    [];
  let runStart: bigint | null = null;
  let runNet = 0;
  const close = (stop: bigint): void => {
    if (runStart === null || runNet === 0) return;
    const from = group.points.get(runStart);
    const to = group.points.get(stop);
    if (!from || !to) throw new Error("an outline edge lost its end points");
    segments.push(runNet > 0 ? [from, to, runNet] : [to, from, -runNet]);
  };
  for (let k = 0; k + 1 < stops.length; k++) {
    const low = stops[k] ?? 0n;
    const high = stops[k + 1] ?? 0n;
    let net = 0;
    for (const piece of group.pieces) if (piece.low <= low && high <= piece.high) net += piece.sign;
    if (net !== runNet) {
      close(low);
      runStart = low;
      runNet = net;
    }
  }
  close(stops[stops.length - 1] ?? 0n);
  return segments;
}

export class OutlineEdges {
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly from: Int32Array;
  readonly to: Int32Array;
  readonly weight: Int32Array;
  readonly extent: number;

  constructor(rings: ReadonlyArray<OutlineRing>) {
    for (const ring of rings) {
      for (const [px, pz] of ring) {
        if (!Number.isSafeInteger(px) || !Number.isSafeInteger(pz)) {
          throw new Error(`outline point ${px}, ${pz} is not a whole outline unit`);
        }
      }
    }
    const segments = lineGroups(rings).flatMap(netSegments);
    const index = new Map<string, number>();
    const points: Array<readonly [number, number]> = [];
    const vertex = (point: readonly [number, number]): number => {
      const key = `${point[0]}:${point[1]}`;
      const known = index.get(key);
      if (known !== undefined) return known;
      index.set(key, points.length);
      points.push(point);
      return points.length - 1;
    };
    this.from = Int32Array.from(segments, ([a]) => vertex(a));
    this.to = Int32Array.from(segments, ([, b]) => vertex(b));
    this.weight = Int32Array.from(segments, ([, , w]) => w);
    this.x = Float64Array.from(points, ([px]) => px);
    this.z = Float64Array.from(points, ([, pz]) => pz);
    this.extent = points.reduce((most, [px, pz]) => Math.max(most, Math.abs(px), Math.abs(pz)), 0);
  }
}

function seamNormal(heading: number, alongX: boolean): boolean {
  const across = alongX ? QUARTER_TURN_16 : 0;
  return heading === across || heading === across + HALF_TURN_16;
}

export class TrackOutline {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  private readonly origin = new Float64Array(ZETA16_COEFFICIENT_COUNT);
  private readonly position: Zeta16;
  private readonly floats: boolean;
  private readonly xPower: number;
  private readonly xSign: number;
  private readonly zPower: number;
  private readonly zSign: number;
  private readonly endHeading: Int32Array;
  private readonly endCoordinates: Float64Array;
  private readonly endErrors: Float64Array;
  private readonly endExact: Uint8Array;
  private readonly endPositions: ReadonlyArray<Zeta16>;

  constructor(
    readonly edges: OutlineEdges,
    pose: Pose16,
    ends: ReadonlyArray<Pose16>,
  ) {
    const heading = normalizeHeading16(pose.heading);
    this.xPower = heading % HALF_ORDER;
    this.xSign = heading < HALF_ORDER ? 1 : -1;
    const quarter = normalizeHeading16(heading + HALF_ORDER / 2);
    this.zPower = quarter % HALF_ORDER;
    this.zSign = quarter < HALF_ORDER ? 1 : -1;
    this.position = zeta16(pose.position.map((coefficient) => coefficient * ORIGIN_UNITS));
    let floats = edges.extent < SAFE_COEFFICIENT;
    this.position.forEach((coefficient, power) => {
      const value = Number(coefficient);
      this.origin[power] = value;
      if (!(Math.abs(value) < SAFE_COEFFICIENT)) floats = false;
    });
    this.floats = floats;
    let minX = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < edges.x.length; i++) {
      const [x, z] = this.approximateLdu(i);
      minX = Math.min(minX, x);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxZ = Math.max(maxZ, z);
    }
    this.minX = Math.floor(minX) - 1;
    this.minZ = Math.floor(minZ) - 1;
    this.maxX = Math.ceil(maxX) + 1;
    this.maxZ = Math.ceil(maxZ) + 1;
    const placedEnds = ends.map((end) => composePose16(pose, end));
    this.endHeading = Int32Array.from(placedEnds, (end) => end.heading);
    this.endPositions = placedEnds.map((end) => end.position);
    this.endCoordinates = new Float64Array(2 * ends.length);
    this.endErrors = new Float64Array(2 * ends.length);
    this.endExact = new Uint8Array(2 * ends.length);
    placedEnds.forEach((end, e) => this.placeEnd(e, end.position));
  }

  jointOnSeam(seams: Float64Array, seam: number): boolean {
    const alongX = seams[seam + EDGE_AXIS] === ALONG_X;
    const line = seams[seam + EDGE_LINE] ?? Number.NaN;
    const across = alongX ? AT_Z : AT_X;
    const along = alongX ? AT_X : AT_Z;
    for (let e = 0; e < this.endHeading.length; e++) {
      if (!seamNormal(this.endHeading[e] ?? -1, alongX)) continue;
      const at = 2 * e;
      if (this.endExact[at + across] !== 1 || this.endCoordinates[at + across] !== line) continue;
      if (this.endWithin(e, along, seams, seam)) return true;
    }
    return false;
  }

  private placeEnd(e: number, position: Zeta16): void {
    const [c0, c1, c2, c3, c4, c5, c6, c7] = position;
    const studs = BigInt(STUD_LDU);
    const axes = [
      [c0, c1 - c7, c2 - c6, c3 - c5],
      [c4, c1 + c7, c2 + c6, c3 + c5],
    ] as const;
    axes.forEach(([rational, first, second, third], axis) => {
      const at = 2 * e + axis;
      const exact = first === 0n && second === 0n && third === 0n;
      const weights =
        axis === AT_X
          ? [COS_EIGHTH, COS_QUARTER, COS_THREE_EIGHTHS]
          : [COS_THREE_EIGHTHS, COS_QUARTER, COS_EIGHTH];
      const irrational = [first, second, third].map((term) => Number(term * studs));
      this.endCoordinates[at] =
        Number(rational * studs) +
        irrational.reduce((total, term, k) => total + term * (weights[k] ?? Number.NaN), 0);
      this.endExact[at] = exact && Number.isSafeInteger(Number(rational * studs)) ? 1 : 0;
      this.endErrors[at] =
        this.endExact[at] === 1
          ? 0
          : ROUNDING *
            (Math.abs(Number(rational * studs)) +
              irrational.reduce((sum, t) => sum + Math.abs(t), 0));
    });
  }

  private endWithin(e: number, axis: number, seams: Float64Array, seam: number): boolean {
    const from = seams[seam + EDGE_FROM] ?? Number.NaN;
    const to = seams[seam + EDGE_TO] ?? Number.NaN;
    const at = 2 * e + axis;
    const value = this.endCoordinates[at] ?? Number.NaN;
    if (this.endExact[at] === 1) return from <= value && value <= to;
    const error = (this.endErrors[at] ?? Number.NaN) + ROUNDING * (Math.abs(from) + Math.abs(to));
    if (value - error > from && value + error < to) return true;
    if (value + error < from || value - error > to) return false;
    return this.endSign(e, axis, from) >= 0 && this.endSign(e, axis, to) <= 0;
  }

  private endSign(e: number, axis: number, ldu: number): Sign {
    const target = exactOfLdu(ldu);
    const position = this.endPositions[e];
    if (!position) throw new RangeError(`track outline has no end ${e}`);
    const end = scaledBy(
      zeta16(position.map((coefficient) => coefficient * BigInt(STUD_LDU))),
      target.shift,
    );
    const difference = subtractZeta16(
      end,
      axis === AT_X ? planValue(target.num, 0n) : planValue(0n, target.num),
    );
    return axis === AT_X ? zeta16RealSign(difference) : zeta16ImaginarySign(difference);
  }

  meetsOpenRect(rects: Float64Array, at: number): boolean {
    const minX = rects[at] ?? Number.NaN;
    const minZ = rects[at + 1] ?? Number.NaN;
    const maxX = rects[at + 2] ?? Number.NaN;
    const maxZ = rects[at + 3] ?? Number.NaN;
    if (!(minX < maxX && minZ < maxZ)) return false;
    if (!(this.minX < maxX && minX < this.maxX && this.minZ < maxZ && minZ < this.maxZ)) {
      return false;
    }
    queryHasFloats = this.floats;
    queryLdu[MIN_X] = minX;
    queryLdu[MAX_X] = maxX;
    queryLdu[MIN_Z] = minZ;
    queryLdu[MAX_Z] = maxZ;
    const probeX = minX + (maxX - minX) / 2;
    const probeZ = minZ + (maxZ - minZ) / 2;
    queryLdu[PROBE_X] = probeX;
    queryLdu[PROBE_Z] = probeZ;
    for (let slot = 0; slot < QUERY_VALUES; slot++) prepareQueryValue(slot);
    if (!(minX < probeX && probeX < maxX && minZ < probeZ && probeZ < maxZ)) {
      queryHasFloats = false;
      this.setExactProbe();
    }
    return this.meetsQuery();
  }

  meetsExactRect(rect: ExactRect, shift: number): boolean {
    if (!(rect.minX < rect.maxX && rect.minZ < rect.maxZ)) return false;
    queryHasFloats = false;
    queryExact[MIN_X] = { num: rect.minX, shift };
    queryExact[MAX_X] = { num: rect.maxX, shift };
    queryExact[MIN_Z] = { num: rect.minZ, shift };
    queryExact[MAX_Z] = { num: rect.maxZ, shift };
    this.setExactProbe();
    return this.meetsQuery();
  }

  private setExactProbe(): void {
    const minX = exactQueryValue(MIN_X);
    const maxX = exactQueryValue(MAX_X);
    const minZ = exactQueryValue(MIN_Z);
    const maxZ = exactQueryValue(MAX_Z);
    const xShift = Math.max(minX.shift, maxX.shift);
    const zShift = Math.max(minZ.shift, maxZ.shift);
    queryExact[PROBE_X] = {
      num: (minX.num << BigInt(xShift - minX.shift)) + (maxX.num << BigInt(xShift - maxX.shift)),
      shift: xShift + 1,
    };
    queryExact[PROBE_Z] = {
      num: (minZ.num << BigInt(zShift - minZ.shift)) + (maxZ.num << BigInt(zShift - maxZ.shift)),
      shift: zShift + 1,
    };
  }

  private meetsQuery(): boolean {
    const edges = this.edges;
    for (let e = 0; e < edges.from.length; e++) {
      const i = edges.from[e] ?? 0;
      const j = edges.to[e] ?? 0;
      this.place(i, FIRST);
      this.place(j, SECOND);
      if (this.edgeMeetsQuery(i, j)) return true;
    }
    return this.containsProbe();
  }

  private edgeMeetsQuery(i: number, j: number): boolean {
    if (
      this.coordinate(i, FIRST, AT_X, MIN_X) <= 0 &&
      this.coordinate(j, SECOND, AT_X, MIN_X) <= 0
    ) {
      return false;
    }
    if (
      this.coordinate(i, FIRST, AT_X, MAX_X) >= 0 &&
      this.coordinate(j, SECOND, AT_X, MAX_X) >= 0
    ) {
      return false;
    }
    if (
      this.coordinate(i, FIRST, AT_Z, MIN_Z) <= 0 &&
      this.coordinate(j, SECOND, AT_Z, MIN_Z) <= 0
    ) {
      return false;
    }
    if (
      this.coordinate(i, FIRST, AT_Z, MAX_Z) >= 0 &&
      this.coordinate(j, SECOND, AT_Z, MAX_Z) >= 0
    ) {
      return false;
    }
    let positive = false;
    let negative = false;
    for (let corner = 0; corner < CORNER_X.length; corner++) {
      const side = this.orient(i, j, CORNER_X[corner] ?? MIN_X, CORNER_Z[corner] ?? MIN_Z);
      if (side > 0) positive = true;
      else if (side < 0) negative = true;
      if (positive && negative) return true;
    }
    return false;
  }

  private containsProbe(): boolean {
    const edges = this.edges;
    let winding = 0;
    for (let e = 0; e < edges.from.length; e++) {
      const i = edges.from[e] ?? 0;
      const j = edges.to[e] ?? 0;
      this.place(i, FIRST);
      this.place(j, SECOND);
      const aAbove = this.coordinate(i, FIRST, AT_Z, PROBE_Z) > 0;
      const bAbove = this.coordinate(j, SECOND, AT_Z, PROBE_Z) > 0;
      if (aAbove === bAbove) continue;
      const side = this.orient(i, j, PROBE_X, PROBE_Z);
      if (bAbove && side > 0) winding += edges.weight[e] ?? 0;
      else if (aAbove && side < 0) winding -= edges.weight[e] ?? 0;
    }
    return winding !== 0;
  }

  private place(i: number, at: number): void {
    const origin = this.origin;
    for (let k = 0; k < ZETA16_COEFFICIENT_COUNT; k++) coefficients[k] = origin[k] ?? 0;
    const px = this.edges.x[i] ?? 0;
    const pz = this.edges.z[i] ?? 0;
    coefficients[this.xPower] = (coefficients[this.xPower] ?? 0) + this.xSign * px;
    coefficients[this.zPower] = (coefficients[this.zPower] ?? 0) + this.zSign * pz;
    const c0 = coefficients[0] ?? 0;
    const c1 = coefficients[1] ?? 0;
    const c2 = coefficients[2] ?? 0;
    const c3 = coefficients[3] ?? 0;
    const c4 = coefficients[4] ?? 0;
    const c5 = coefficients[5] ?? 0;
    const c6 = coefficients[6] ?? 0;
    const c7 = coefficients[7] ?? 0;
    const d1 = c1 - c7;
    const d2 = c2 - c6;
    const d3 = c3 - c5;
    const e1 = c1 + c7;
    const e2 = c2 + c6;
    const e3 = c3 + c5;
    const xExact = this.floats && d1 === 0 && d2 === 0 && d3 === 0;
    const zExact = this.floats && e1 === 0 && e2 === 0 && e3 === 0;
    vertices[at + AT_X] = c0 + d1 * COS_EIGHTH + d2 * COS_QUARTER + d3 * COS_THREE_EIGHTHS;
    vertices[at + AT_Z] = c4 + e1 * COS_THREE_EIGHTHS + e2 * COS_QUARTER + e3 * COS_EIGHTH;
    vertices[at + AT_X_ERROR] = xExact
      ? 0
      : ROUNDING * (Math.abs(c0) + Math.abs(d1) + Math.abs(d2) + Math.abs(d3));
    vertices[at + AT_Z_ERROR] = zExact
      ? 0
      : ROUNDING * (Math.abs(c4) + Math.abs(e1) + Math.abs(e2) + Math.abs(e3));
    vertices[at + AT_X_EXACT] = xExact ? 1 : 0;
    vertices[at + AT_Z_EXACT] = zExact ? 1 : 0;
  }

  private approximateLdu(i: number): readonly [number, number] {
    this.place(i, FIRST);
    const x = vertices[FIRST + AT_X] ?? Number.NaN;
    const z = vertices[FIRST + AT_Z] ?? Number.NaN;
    if (this.floats) return [x / UNIT, z / UNIT];
    const exact = this.exactVertex(i);
    return [zeta16RealPart(exact) / UNIT, zeta16ImaginaryPart(exact) / UNIT];
  }

  private coordinate(i: number, at: number, axis: number, slot: number): number {
    if (queryHasFloats) {
      const sign = compareCoordinate(at, axis, slot);
      if (sign !== UNSURE) return sign;
    }
    const target = exactQueryValue(slot);
    const vertex = scaledBy(this.exactVertex(i), target.shift);
    const value =
      axis === AT_X ? planValue(target.num * UNIT_BIG, 0n) : planValue(0n, target.num * UNIT_BIG);
    const difference = subtractZeta16(vertex, value);
    return axis === AT_X ? zeta16RealSign(difference) : zeta16ImaginarySign(difference);
  }

  private orient(i: number, j: number, xSlot: number, zSlot: number): number {
    if (queryHasFloats) {
      const sign = orientFloat(FIRST, SECOND, xSlot, zSlot);
      if (sign !== UNSURE) return sign;
    }
    const cx = exactQueryValue(xSlot);
    const cz = exactQueryValue(zSlot);
    const shift = Math.max(cx.shift, cz.shift);
    const a = scaledBy(this.exactVertex(i), shift);
    const b = scaledBy(this.exactVertex(j), shift);
    const c = planValue(aligned(cx, shift), aligned(cz, shift));
    return zeta16ImaginarySign(
      multiplyZeta16(conjugateZeta16(subtractZeta16(b, a)), subtractZeta16(c, a)),
    );
  }

  private exactVertex(i: number): Zeta16 {
    const values = [...this.position];
    values[this.xPower] = (values[this.xPower] ?? 0n) + BigInt(this.xSign * (this.edges.x[i] ?? 0));
    values[this.zPower] = (values[this.zPower] ?? 0n) + BigInt(this.zSign * (this.edges.z[i] ?? 0));
    return zeta16(values);
  }
}

function zeta16RealPart(value: Zeta16): number {
  const [c0, c1, c2, c3, , c5, c6, c7] = value;
  return (
    Number(c0) +
    Number(c1 - c7) * COS_EIGHTH +
    Number(c2 - c6) * COS_QUARTER +
    Number(c3 - c5) * COS_THREE_EIGHTHS
  );
}

function zeta16ImaginaryPart(value: Zeta16): number {
  const [, c1, c2, c3, c4, c5, c6, c7] = value;
  return (
    Number(c4) +
    Number(c1 + c7) * COS_THREE_EIGHTHS +
    Number(c2 + c6) * COS_QUARTER +
    Number(c3 + c5) * COS_EIGHTH
  );
}

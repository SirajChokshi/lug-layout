import {
  addExactRational,
  ceilExactRational,
  compareExactRational,
  divideExactRational,
  exactRational,
  exactRationalFromFloat64,
  exactRationalFromSixteenths,
  exactRationalToFloat64,
  floorExactRational,
  meanExactRational,
  multiplyExactRational,
  subtractExactRational,
  type ExactRational,
} from "@brr/math";
import { AXIS_FREE, axisDimension, axisSign } from "../connect/connector-table.ts";
import { IntKeyMap, MISSING } from "../connect/int-key-map.ts";
import {
  IdentifiedPoint,
  MODEL_ROOT,
  NO_FRAME,
  SubmodelFrames,
  TRANSFORM_FLOATS,
  coordinatesAcross,
  identifyDirection,
  identifyPoint,
  type PartInstances,
} from "../connect/submodel-frames.ts";
import type { UnreadRollingBands, UnreadRollingReason } from "@brr/schema/bundle";
import type { MeasuredRail } from "./measured-rail.ts";
import { NO_ROLLING_AXIS, type PartRollingTable } from "./part-rolling.ts";
import { AxleHeights } from "./support-plane.ts";
import { UnionFind } from "./union-find.ts";

const VERTICAL = 1;
const ROW = 4;
const TRANSLATION = 3;
const AT_COORDINATES = 2;
const ENDS = 2;
const POINT_FLOATS = 3;
const AXIS_LINE_FLOATS = 2 * POINT_FLOATS;
const INT32_LIMIT = 2 ** 31;
const SIXTEENTHS = exactRational(16n, 1n);

class UnreadRows {
  private readonly instances: number[] = [];
  private readonly bands: number[] = [];
  private readonly reasons: UnreadRollingReason[] = [];

  add(instance: number, band: number, reason: UnreadRollingReason): void {
    this.instances.push(instance);
    this.bands.push(band);
    this.reasons.push(reason);
  }

  columns(): UnreadRollingBands {
    const order = this.instances
      .map((_, n) => n)
      .toSorted((a, b) => (this.instances[a] ?? 0) - (this.instances[b] ?? 0) || a - b);
    return {
      instance: order.map((row) => this.instances[row] ?? 0),
      band: order.map((row) => this.bands[row] ?? 0),
      reason: order.map((row) => this.reasons[row] ?? "across"),
    };
  }
}

export interface DetectedWheelset {
  readonly memberInstances: Uint32Array;
  readonly memberSurfaces: Uint32Array;
  readonly rail: number;
  readonly frame: number;
  readonly dimension: number;
  readonly modelDimension: number;
  readonly trackCentre: number;
  readonly contactRadii: readonly [ExactRational, ExactRational];
  readonly rollingRadius: ExactRational;
  readonly rollingRadiusOnRail: ReadonlyArray<ExactRational | null>;
  readonly axisLine: Float64Array;
  readonly axleInstance: number;
  readonly axlePoint: Float64Array;
  readonly axleHeight: number;
}

export interface WheelsetDetection {
  readonly wheelsets: ReadonlyArray<DetectedWheelset>;
  readonly unreadRollingBands: UnreadRollingBands;
}

const KEY_INTS = 4;
const OWN_BRANCH_BASE = -3;

function ownBranch(candidate: number): number {
  return OWN_BRANCH_BASE - candidate;
}

function groupsOf(sets: UnionFind, usable: Uint8Array, count: number): Uint32Array[] {
  const sizes = new Uint32Array(count);
  for (let k = 0; k < count; k++) {
    if (usable[k] !== 1) continue;
    const root = sets.find(k);
    sizes[root] = (sizes[root] ?? 0) + 1;
  }
  const groupOf = new Int32Array(count).fill(-1);
  const filled = new Uint32Array(count);
  const groups: Uint32Array[] = [];
  for (let k = 0; k < count; k++) {
    if (usable[k] !== 1) continue;
    const root = sets.find(k);
    let g = groupOf[root] ?? -1;
    if (g < 0) {
      g = groups.length;
      groupOf[root] = g;
      groups.push(new Uint32Array(sizes[root] ?? 0));
    }
    const group = groups[g];
    if (!group) continue;
    group[filled[root] ?? 0] = k;
    filled[root] = (filled[root] ?? 0) + 1;
  }
  return groups;
}

interface IntegerRange {
  readonly low: number;
  readonly high: number;
}

interface Extent {
  readonly low: ExactRational;
  readonly high: ExactRational;
  readonly lowRadius: ExactRational;
  readonly highRadius: ExactRational;
}

interface RailReading {
  readonly dimension: number;
  readonly members: Uint32Array;
  readonly trackCentre: number;
  readonly contactRadii: readonly [ExactRational, ExactRational];
}

interface SettledReading {
  readonly frame: number;
  readonly reading: RailReading;
}

interface SurfaceExtents {
  readonly dimension: number;
  readonly extents: ReadonlyArray<Extent>;
}

interface Candidates {
  readonly instance: Uint32Array;
  readonly surface: Uint32Array;
}

interface AxleReading {
  readonly instance: number;
  readonly surface: number;
  readonly point: Float64Array;
  readonly height: number;
}

function rollingRadiusOf({ contactRadii: [near, far] }: RailReading): ExactRational {
  return meanExactRational(near, far);
}

interface RailInSixteenths {
  readonly nearFrom: ExactRational;
  readonly nearTo: ExactRational;
  readonly farFrom: ExactRational;
  readonly farTo: ExactRational;
}

function unit(axis: number, dimension: number): number {
  return axis === dimension ? 1 : 0;
}

function axisCode(transform: Float64Array, axis: number): number {
  return identifyDirection(transform, unit(axis, 0), unit(axis, 1), unit(axis, 2));
}

function lineCoordinate(axis: number, dimension: number, at: Int32Array, s: number): number {
  if (dimension === axis) return 0;
  const first = dimension < axis ? dimension : dimension - 1;
  return (at[s * AT_COORDINATES + first] ?? 0) / 16;
}

function transformedCoordinate(
  transform: Float64Array,
  row: number,
  x: number,
  y: number,
  z: number,
): number {
  const r = row * ROW;
  return (
    (transform[r] ?? 0) * x +
    (transform[r + 1] ?? 0) * y +
    (transform[r + 2] ?? 0) * z +
    (transform[r + TRANSLATION] ?? 0)
  );
}

function sixteenthsOf(ldu: number): ExactRational {
  return multiplyExactRational(exactRationalFromFloat64(ldu), SIXTEENTHS);
}

function toInt32(value: bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || Math.abs(n) >= INT32_LIMIT) {
    throw new RangeError(`track centre ${value} sixteenths is beyond Int32`);
  }
  return n;
}

function openRange(low: ExactRational, high: ExactRational): IntegerRange | null {
  const first = floorExactRational(low) + 1n;
  const last = ceilExactRational(high) - 1n;
  return first <= last ? { low: toInt32(first), high: toInt32(last) } : null;
}

function minus(range: IntegerRange, other: IntegerRange | null): IntegerRange[] {
  if (other === null || other.high < range.low || other.low > range.high) return [range];
  const out: IntegerRange[] = [];
  if (other.low > range.low) out.push({ low: range.low, high: other.low - 1 });
  if (other.high < range.high) out.push({ low: other.high + 1, high: range.high });
  return out;
}

function exclusive(range: IntegerRange | null, other: IntegerRange | null): IntegerRange[] {
  return range === null ? [] : minus(range, other);
}

function contains(ranges: ReadonlyArray<IntegerRange>, value: number): boolean {
  return ranges.some((range) => range.low <= value && value <= range.high);
}

function union(ranges: ReadonlyArray<IntegerRange>): IntegerRange[] {
  const sorted = ranges.toSorted((a, b) => a.low - b.low);
  const out: IntegerRange[] = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (last && range.low <= last.high + 1) {
      out[out.length - 1] = { low: last.low, high: Math.max(last.high, range.high) };
    } else {
      out.push(range);
    }
  }
  return out;
}

function intersect(a: ReadonlyArray<IntegerRange>, b: ReadonlyArray<IntegerRange>): IntegerRange[] {
  const out: IntegerRange[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const x = a[i];
    const y = b[j];
    if (!x || !y) break;
    const low = Math.max(x.low, y.low);
    const high = Math.min(x.high, y.high);
    if (low <= high) out.push({ low, high });
    if (x.high < y.high) i++;
    else j++;
  }
  return out;
}

function meets(range: IntegerRange | null, feasible: ReadonlyArray<IntegerRange>): boolean {
  if (!range) return false;
  let low = 0;
  let high = feasible.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const candidate = feasible[mid];
    if (!candidate) return false;
    if (candidate.high < range.low) low = mid + 1;
    else if (candidate.low > range.high) high = mid - 1;
    else return true;
  }
  return false;
}

function nearestToMiddle(feasible: ReadonlyArray<IntegerRange>): number {
  const first = feasible[0];
  const last = feasible.at(-1);
  if (!first || !last) throw new Error("a track centre needs a feasible range");
  const twiceMiddle = first.low + last.high;
  const below = Math.floor(twiceMiddle / 2);
  const above = Math.ceil(twiceMiddle / 2);
  let best = first.low;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const range of feasible) {
    for (const target of [below, above]) {
      const candidate = Math.min(Math.max(target, range.low), range.high);
      const distance = Math.abs(2 * candidate - twiceMiddle);
      if (distance < bestDistance || (distance === bestDistance && candidate < best)) {
        best = candidate;
        bestDistance = distance;
      }
    }
  }
  return best;
}

function radiusAt(extent: Extent, x: ExactRational): ExactRational {
  const span = subtractExactRational(extent.high, extent.low);
  const rise = subtractExactRational(extent.highRadius, extent.lowRadius);
  const along = subtractExactRational(x, extent.low);
  return addExactRational(
    extent.lowRadius,
    divideExactRational(multiplyExactRational(rise, along), span),
  );
}

function maxRational(a: ExactRational, b: ExactRational): ExactRational {
  return compareExactRational(a, b) >= 0 ? a : b;
}

function minRational(a: ExactRational, b: ExactRational): ExactRational {
  return compareExactRational(a, b) <= 0 ? a : b;
}

function contactRadius(
  extents: ReadonlyArray<Extent>,
  bandLow: ExactRational,
  bandHigh: ExactRational,
): ExactRational | null {
  let best: ExactRational | null = null;
  for (const extent of extents) {
    if (compareExactRational(extent.low, bandHigh) >= 0) continue;
    if (compareExactRational(extent.high, bandLow) <= 0) continue;
    const low = maxRational(extent.low, bandLow);
    const high = minRational(extent.high, bandHigh);
    const radius = maxRational(radiusAt(extent, low), radiusAt(extent, high));
    best = best === null ? radius : maxRational(best, radius);
  }
  return best;
}

function railInSixteenths(rail: MeasuredRail): RailInSixteenths {
  const [near, far] = rail.railHeads;
  return {
    nearFrom: multiplyExactRational(near.from, SIXTEENTHS),
    nearTo: multiplyExactRational(near.to, SIXTEENTHS),
    farFrom: multiplyExactRational(far.from, SIXTEENTHS),
    farTo: multiplyExactRational(far.to, SIXTEENTHS),
  };
}

export class WheelsetDetector {
  private readonly rails: ReadonlyArray<RailInSixteenths>;
  private readonly transform = new Float64Array(TRANSFORM_FLOATS);
  private readonly point = new IdentifiedPoint();

  constructor(rails: ReadonlyArray<MeasuredRail>) {
    if (rails.length === 0) throw new RangeError("wheelsets need at least one measured rail");
    this.rails = rails.map(railInSixteenths);
  }

  detect(
    instances: PartInstances,
    rolling: ReadonlyArray<PartRollingTable | null>,
  ): WheelsetDetection {
    const frames = new SubmodelFrames(instances);
    const heights = new AxleHeights(frames);
    const unread = new UnreadRows();
    let total = 0;
    for (let i = 0; i < instances.count; i++) {
      total += rolling[instances.partIndex[i] ?? -1]?.surfaceCount ?? 0;
    }
    const candidateInstance = new Uint32Array(total);
    const candidateSurface = new Uint32Array(total);
    const candidateDimension = new Uint8Array(total);
    let count = 0;
    for (let i = 0; i < instances.count; i++) {
      const table = rolling[instances.partIndex[i] ?? -1];
      if (!table) continue;
      frames.relate(i, MODEL_ROOT, this.transform);
      for (let u = 0; u < table.unreadCount; u++) {
        const axis = table.unreadAxis[u] ?? NO_ROLLING_AXIS;
        const code = axis === NO_ROLLING_AXIS ? AXIS_FREE : axisCode(this.transform, axis);
        if (code !== AXIS_FREE && axisDimension(code) === VERTICAL) continue;
        unread.add(i, u, table.unreadReason[u] ?? "unoriented");
      }
      for (let s = 0; s < table.surfaceCount; s++) {
        const code = axisCode(this.transform, table.axis[s] ?? 0);
        if (code === AXIS_FREE) {
          unread.add(i, s, "direction");
          continue;
        }
        if (axisDimension(code) === VERTICAL) continue;
        candidateInstance[count] = i;
        candidateSurface[count] = s;
        candidateDimension[count] = axisDimension(code);
        count++;
      }
    }
    const groups = this.pair(
      frames,
      instances,
      rolling,
      candidateInstance,
      candidateSurface,
      count,
      unread,
    );
    const candidates: Candidates = { instance: candidateInstance, surface: candidateSurface };
    const wheelsets: DetectedWheelset[] = [];
    for (const group of groups) {
      const wheelset = this.wheelsetOf(
        frames,
        heights,
        instances,
        rolling,
        candidates,
        candidateDimension[group[0] ?? 0] ?? 0,
        group,
        unread,
      );
      if (wheelset) wheelsets.push(wheelset);
    }
    return { wheelsets, unreadRollingBands: unread.columns() };
  }

  private identifyAcross(
    frames: SubmodelFrames,
    instance: number,
    frame: number,
    table: PartRollingTable,
    s: number,
  ): number {
    if (!frames.relate(instance, frame, this.transform)) return AXIS_FREE;
    const axis = table.axis[s] ?? 0;
    const code = axisCode(this.transform, axis);
    if (code === AXIS_FREE) return AXIS_FREE;
    const identified = identifyPoint(
      this.transform,
      lineCoordinate(axis, 0, table.at, s),
      lineCoordinate(axis, 1, table.at, s),
      lineCoordinate(axis, 2, table.at, s),
      coordinatesAcross(code),
      this.point,
    );
    return identified ? code : AXIS_FREE;
  }

  private pair(
    frames: SubmodelFrames,
    instances: PartInstances,
    rolling: ReadonlyArray<PartRollingTable | null>,
    candidateInstance: Uint32Array,
    candidateSurface: Uint32Array,
    count: number,
    unread: UnreadRows,
  ): Uint32Array[] {
    const usable = new Uint8Array(count);
    let entries = 0;
    for (let k = 0; k < count; k++) {
      const i = candidateInstance[k] ?? 0;
      const table = rolling[instances.partIndex[i] ?? -1];
      const s = candidateSurface[k] ?? 0;
      if (!table || this.identifyAcross(frames, i, frames.frameOf(i), table, s) === AXIS_FREE) {
        unread.add(i, s, "across");
        continue;
      }
      usable[k] = 1;
      for (let f = frames.frameOf(i); f !== NO_FRAME; f = frames.parentFrame(f)) entries++;
    }
    const keys = new IntKeyMap(KEY_INTS);
    const key = new Int32Array(KEY_INTS);
    const slotOf = new Int32Array(entries);
    const entryCandidate = new Uint32Array(entries);
    const firstCandidate = new Uint32Array(entries);
    const firstBranch = new Int32Array(entries);
    const branched = new Uint8Array(entries);
    let slots = 0;
    let e = 0;
    for (let k = 0; k < count; k++) {
      if (usable[k] !== 1) continue;
      const i = candidateInstance[k] ?? 0;
      const table = rolling[instances.partIndex[i] ?? -1];
      if (!table) continue;
      const s = candidateSurface[k] ?? 0;
      let branch = ownBranch(k);
      for (let f = frames.frameOf(i); f !== NO_FRAME; f = frames.parentFrame(f)) {
        const code = this.identifyAcross(frames, i, f, table, s);
        if (code !== AXIS_FREE) {
          const dimension = axisDimension(code);
          key[0] = f;
          key[1] = dimension;
          key[2] = this.point.sixteenths[(dimension + 1) % 3] ?? 0;
          key[3] = this.point.sixteenths[(dimension + 2) % 3] ?? 0;
          let slot = keys.get(key);
          if (slot === MISSING) {
            slot = slots++;
            keys.set(key, slot);
            firstCandidate[slot] = k;
            firstBranch[slot] = branch;
          } else if (firstBranch[slot] !== branch) {
            branched[slot] = 1;
          }
          slotOf[e] = slot;
          entryCandidate[e] = k;
          e++;
        }
        branch = f;
      }
    }
    const sets = new UnionFind(count);
    for (let n = 0; n < e; n++) {
      const slot = slotOf[n] ?? 0;
      if (branched[slot] === 1) sets.union(firstCandidate[slot] ?? 0, entryCandidate[n] ?? 0);
    }
    return groupsOf(sets, usable, count);
  }

  private lowestCommonFrameOf(
    frames: SubmodelFrames,
    candidateInstance: Uint32Array,
    surfaces: Uint32Array,
  ): number {
    const first = candidateInstance[surfaces[0] ?? 0] ?? 0;
    let frame = frames.frameOf(first);
    for (let m = 1; m < surfaces.length; m++) {
      const pairFrame = frames.lowestCommonFrame(first, candidateInstance[surfaces[m] ?? 0] ?? 0);
      let above = false;
      for (let f = frame; f !== NO_FRAME; f = frames.parentFrame(f)) {
        if (f === pairFrame) {
          above = true;
          break;
        }
      }
      if (above) frame = pairFrame;
    }
    return frame;
  }

  private wheelsetOf(
    frames: SubmodelFrames,
    heights: AxleHeights,
    instances: PartInstances,
    rolling: ReadonlyArray<PartRollingTable | null>,
    candidates: Candidates,
    modelDimension: number,
    group: Uint32Array,
    unread: UnreadRows,
  ): DetectedWheelset | null {
    const groupFrame = this.lowestCommonFrameOf(frames, candidates.instance, group);
    const groupExtents = this.extentsIn(frames, instances, rolling, candidates, groupFrame, group);
    if (!groupExtents) return null;
    const onRails = this.rails.map((_, r) =>
      this.onRail(frames, instances, rolling, candidates, groupFrame, group, groupExtents, r),
    );
    const rail = onRails.findIndex((settled) => settled !== null);
    const recorded = onRails[rail];
    const measured = this.rails[rail];
    if (!recorded || !measured) return null;
    const { frame, reading } = recorded;
    const memberInstances = Uint32Array.from(reading.members, (k) => candidates.instance[k] ?? 0);
    const memberSurfaces = Uint32Array.from(reading.members, (k) => candidates.surface[k] ?? 0);
    const axle = this.axleOf(heights, instances, rolling, memberInstances, memberSurfaces, frame);
    if (!axle) {
      memberInstances.forEach((instance, m) =>
        unread.add(instance, memberSurfaces[m] ?? 0, "across"),
      );
      return null;
    }
    const c = exactRational(BigInt(reading.trackCentre), 1n);
    return {
      memberInstances,
      memberSurfaces,
      rail,
      frame,
      dimension: reading.dimension,
      modelDimension,
      trackCentre: reading.trackCentre,
      contactRadii: reading.contactRadii,
      rollingRadius: rollingRadiusOf(reading),
      rollingRadiusOnRail: onRails.map((settled) =>
        settled ? rollingRadiusOf(settled.reading) : null,
      ),
      axisLine: this.axisLinePoints(
        frames,
        instances,
        rolling,
        axle.instance,
        axle.surface,
        frame,
        reading.dimension,
        [
          addExactRational(c, meanExactRational(measured.nearFrom, measured.nearTo)),
          addExactRational(c, meanExactRational(measured.farFrom, measured.farTo)),
        ],
      ),
      axleInstance: axle.instance,
      axlePoint: axle.point,
      axleHeight: axle.height,
    };
  }

  private axleOf(
    heights: AxleHeights,
    instances: PartInstances,
    rolling: ReadonlyArray<PartRollingTable | null>,
    memberInstances: Uint32Array,
    memberSurfaces: Uint32Array,
    frame: number,
  ): AxleReading | null {
    for (let m = 0; m < memberInstances.length; m++) {
      const instance = memberInstances[m] ?? 0;
      const surface = memberSurfaces[m] ?? 0;
      const table = rolling[instances.partIndex[instance] ?? -1];
      if (!table) continue;
      const axis = table.axis[surface] ?? 0;
      const point = Float64Array.of(
        lineCoordinate(axis, 0, table.at, surface),
        lineCoordinate(axis, 1, table.at, surface),
        lineCoordinate(axis, 2, table.at, surface),
      );
      const height = heights.inFrame(instance, point, frame);
      if (height !== null) return { instance, surface, point, height };
    }
    return null;
  }

  private onRail(
    frames: SubmodelFrames,
    instances: PartInstances,
    rolling: ReadonlyArray<PartRollingTable | null>,
    candidates: Candidates,
    groupFrame: number,
    group: Uint32Array,
    groupExtents: SurfaceExtents,
    rail: number,
  ): SettledReading | null {
    const reading = this.railReading(groupExtents, group, rail);
    if (!reading) return null;
    const frame = this.lowestCommonFrameOf(frames, candidates.instance, reading.members);
    if (frame === groupFrame) return { frame, reading };
    const memberExtents = this.extentsIn(
      frames,
      instances,
      rolling,
      candidates,
      frame,
      reading.members,
    );
    const settled = memberExtents ? this.railReading(memberExtents, reading.members, rail) : null;
    return settled ? { frame, reading: settled } : null;
  }

  private extentsIn(
    frames: SubmodelFrames,
    instances: PartInstances,
    rolling: ReadonlyArray<PartRollingTable | null>,
    candidates: Candidates,
    frame: number,
    surfaces: Uint32Array,
  ): SurfaceExtents | null {
    const extents: Extent[] = [];
    let dimension = -1;
    for (let m = 0; m < surfaces.length; m++) {
      const k = surfaces[m] ?? 0;
      const i = candidates.instance[k] ?? 0;
      const s = candidates.surface[k] ?? 0;
      const table = rolling[instances.partIndex[i] ?? -1];
      if (!table || !frames.relate(i, frame, this.transform)) return null;
      const axis = table.axis[s] ?? 0;
      const code = axisCode(this.transform, axis);
      if (code === AXIS_FREE) return null;
      const d = axisDimension(code);
      if (dimension >= 0 && d !== dimension) return null;
      dimension = d;
      const x = lineCoordinate(axis, 0, table.at, s);
      const y = lineCoordinate(axis, 1, table.at, s);
      const z = lineCoordinate(axis, 2, table.at, s);
      const along = (u: number): number =>
        transformedCoordinate(
          this.transform,
          d,
          axis === 0 ? u : x,
          axis === 1 ? u : y,
          axis === 2 ? u : z,
        );
      const fromAt = sixteenthsOf(along((table.from[s] ?? 0) / 16));
      const toAt = sixteenthsOf(along((table.to[s] ?? 0) / 16));
      const fromRadius = exactRationalFromSixteenths(table.radii[s * ENDS] ?? 0);
      const toRadius = exactRationalFromSixteenths(table.radii[s * ENDS + 1] ?? 0);
      extents.push(
        compareExactRational(fromAt, toAt) <= 0
          ? { low: fromAt, high: toAt, lowRadius: fromRadius, highRadius: toRadius }
          : { low: toAt, high: fromAt, lowRadius: toRadius, highRadius: fromRadius },
      );
    }
    return { dimension, extents };
  }

  private railReading(
    { dimension, extents }: SurfaceExtents,
    surfaces: Uint32Array,
    r: number,
  ): RailReading | null {
    const rail = this.rails[r];
    if (!rail) return null;
    const near = extents.map((extent) =>
      openRange(
        subtractExactRational(extent.low, rail.nearTo),
        subtractExactRational(extent.high, rail.nearFrom),
      ),
    );
    const far = extents.map((extent) =>
      openRange(
        subtractExactRational(extent.low, rail.farTo),
        subtractExactRational(extent.high, rail.farFrom),
      ),
    );
    const nearOnly = extents.map((_, m) => exclusive(near[m] ?? null, far[m] ?? null));
    const farOnly = extents.map((_, m) => exclusive(far[m] ?? null, near[m] ?? null));
    const feasible = intersect(union(nearOnly.flat()), union(farOnly.flat()));
    if (feasible.length === 0) return null;
    const memberIndex: number[] = [];
    for (let m = 0; m < extents.length; m++) {
      const through = [...(nearOnly[m] ?? []), ...(farOnly[m] ?? [])];
      if (through.some((range) => meets(range, feasible))) memberIndex.push(m);
    }
    const trackCentre = nearestToMiddle(feasible);
    const c = exactRational(BigInt(trackCentre), 1n);
    const exclusiveAt = (only: ReadonlyArray<ReadonlyArray<IntegerRange>>) =>
      memberIndex.flatMap((m) => {
        const extent = extents[m];
        return extent && contains(only[m] ?? [], trackCentre) ? [extent] : [];
      });
    const nearRadius = contactRadius(
      exclusiveAt(nearOnly),
      addExactRational(c, rail.nearFrom),
      addExactRational(c, rail.nearTo),
    );
    const farRadius = contactRadius(
      exclusiveAt(farOnly),
      addExactRational(c, rail.farFrom),
      addExactRational(c, rail.farTo),
    );
    if (!nearRadius || !farRadius) {
      throw new Error("a feasible track centre must put a member over each head band");
    }
    return {
      dimension,
      members: Uint32Array.from(memberIndex, (m) => surfaces[m] ?? 0),
      trackCentre,
      contactRadii: [nearRadius, farRadius],
    };
  }

  private axisLinePoints(
    frames: SubmodelFrames,
    instances: PartInstances,
    rolling: ReadonlyArray<PartRollingTable | null>,
    instance: number,
    surface: number,
    frame: number,
    dimension: number,
    alongSixteenths: ReadonlyArray<ExactRational>,
  ): Float64Array {
    const table = rolling[instances.partIndex[instance] ?? -1];
    const out = new Float64Array(AXIS_LINE_FLOATS);
    if (!table) return out;
    const axis = table.axis[surface] ?? 0;
    const x = lineCoordinate(axis, 0, table.at, surface);
    const y = lineCoordinate(axis, 1, table.at, surface);
    const z = lineCoordinate(axis, 2, table.at, surface);
    frames.relate(instance, frame, this.transform);
    const slope = this.transform[dimension * ROW + axis] ?? 0;
    const offset = transformedCoordinate(this.transform, dimension, x, y, z);
    frames.relate(instance, MODEL_ROOT, this.transform);
    const modelAxis = axisCode(this.transform, axis);
    const modelDimension = axisDimension(modelAxis);
    const towards = axisSign(modelAxis);
    for (let p = 0; p < alongSixteenths.length; p++) {
      const target = alongSixteenths[p];
      if (!target) continue;
      const u = (exactRationalToFloat64(target) / 16 - offset) / slope;
      for (let row = 0; row < POINT_FLOATS; row++) {
        out[p * POINT_FLOATS + row] =
          transformedCoordinate(this.transform, row, x, y, z) +
          (row === modelDimension ? towards * u : 0);
      }
    }
    return out;
  }
}

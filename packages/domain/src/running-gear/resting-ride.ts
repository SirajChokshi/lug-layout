import { PLATE_LDU, exactRationalEquals, exactRationalToFloat64 } from "@brr/math";
import {
  AXIS_FREE,
  AXIS_POS_X,
  AXIS_POS_Y,
  AXIS_POS_Z,
  axisDimension,
  axisSign,
} from "../connect/connector-table.ts";
import { MATE_PASS_PART, type MatePairs } from "../connect/mate-pairs.ts";
import {
  NO_FRAME,
  TRANSFORM_FLOATS,
  type PartInstances,
  type SubmodelFrames,
} from "../connect/submodel-frames.ts";
import type { PartExtents } from "./part-extents.ts";
import {
  PlacedInstance,
  modelAxisIn,
  overlapsWithLength,
  type Interval,
} from "./placed-instance.ts";
import { commonFrame } from "./support-plane.ts";
import { UnionFind } from "./union-find.ts";

export const NO_VEHICLE = -1;
export const ON_BODY = -1;
const NO_GROUP = -1;
const MODEL_UP = 1;
const CANDIDATE_REACH_LDU = PLATE_LDU;
const ROW = 4;
const TRANSLATION = 3;
const AXES = 3;
const BOX_FLOATS = 6;
const CORNERS = 8;
const FRAME_AXES = [AXIS_POS_X, AXIS_POS_Y, AXIS_POS_Z] as const;

export interface Riders {
  readonly vehicleOf: Int32Array;
  readonly bogieOf: Int32Array;
}

export interface RestingCredit {
  readonly vehicle: number;
  readonly bogie: number;
  readonly instances: ReadonlyArray<number>;
}

type ExactBox = ReadonlyArray<Interval>;

class ExactContact {
  private readonly placed: PlacedInstance;
  private readonly boxes = new Map<number, ExactBox | null>();
  private readonly ups = new Map<number, number>();

  constructor(
    private readonly frames: SubmodelFrames,
    private readonly instances: PartInstances,
    private readonly extents: ReadonlyArray<PartExtents | null>,
  ) {
    this.placed = new PlacedInstance(frames);
  }

  restsOn(upper: number, lower: number): boolean {
    const frame = commonFrame(this.frames, this.frames.frameOf(upper), this.frames.frameOf(lower));
    const up = this.upIn(upper, frame);
    const above = this.box(upper, frame);
    const below = this.box(lower, frame);
    if (up === AXIS_FREE || !above || !below) return false;
    const vertical = axisDimension(up);
    for (let d = 0; d < FRAME_AXES.length; d++) {
      const across = above[d];
      const under = below[d];
      if (!across || !under) return false;
      if (d !== vertical && !overlapsWithLength(across, under)) return false;
    }
    const a = above[vertical];
    const b = below[vertical];
    if (!a || !b) return false;
    return axisSign(up) > 0
      ? exactRationalEquals(a.low, b.high)
      : exactRationalEquals(a.high, b.low);
  }

  private key(instance: number, frame: number): number {
    return (frame - NO_FRAME) * this.instances.count + instance;
  }

  private upIn(instance: number, frame: number): number {
    const key = this.key(instance, frame);
    const known = this.ups.get(key);
    if (known !== undefined) return known;
    const up = modelAxisIn(this.frames, instance, frame, MODEL_UP);
    this.ups.set(key, up);
    return up;
  }

  private box(instance: number, frame: number): ExactBox | null {
    const key = this.key(instance, frame);
    const known = this.boxes.get(key);
    if (known !== undefined) return known;
    const part = this.extents[this.instances.partIndex[instance] ?? -1];
    let box: ExactBox | null = null;
    if (part && this.placed.place(instance, frame)) {
      const intervals = FRAME_AXES.map((axis) => this.placed.exactlyAlong(axis, part));
      if (intervals.every((interval) => interval !== null)) box = intervals;
    }
    this.boxes.set(key, box);
    return box;
  }
}

function readsAcrossParts(mates: MatePairs, mate: number): boolean {
  return mates.passOf(mate) !== MATE_PASS_PART;
}

function looseGroups(
  count: number,
  mates: MatePairs,
  vehicleOf: Int32Array,
): { readonly groups: ReadonlyArray<ReadonlyArray<number>>; readonly groupOf: Int32Array } {
  const sets = new UnionFind(count);
  const tied = new Uint8Array(count);
  for (let m = 0; m < mates.count; m++) {
    if (!readsAcrossParts(mates, m)) continue;
    const male = mates.maleInstance[m] ?? 0;
    const female = mates.femaleInstance[m] ?? 0;
    const maleLoose = vehicleOf[male] === NO_VEHICLE;
    const femaleLoose = vehicleOf[female] === NO_VEHICLE;
    if (maleLoose && femaleLoose) sets.union(male, female);
    else if (maleLoose) tied[male] = 1;
    else if (femaleLoose) tied[female] = 1;
  }
  const tiedRoots = new Set<number>();
  for (let i = 0; i < count; i++) if (tied[i] === 1) tiedRoots.add(sets.find(i));
  const indexOfRoot = new Map<number, number>();
  const groups: number[][] = [];
  const groupOf = new Int32Array(count).fill(NO_GROUP);
  for (let i = 0; i < count; i++) {
    const root = sets.find(i);
    if (vehicleOf[i] !== NO_VEHICLE || tiedRoots.has(root)) continue;
    let g = indexOfRoot.get(root);
    if (g === undefined) {
      g = groups.length;
      indexOfRoot.set(root, g);
      groups.push([]);
    }
    groups[g]?.push(i);
    groupOf[i] = g;
  }
  return { groups, groupOf };
}

function modelBoxes(
  instances: PartInstances,
  extents: ReadonlyArray<PartExtents | null>,
): Float64Array {
  const boxes = new Float64Array(instances.count * BOX_FLOATS).fill(Number.NaN);
  const m = instances.matrices;
  for (let i = 0; i < instances.count; i++) {
    const part = extents[instances.partIndex[i] ?? -1];
    if (!part) continue;
    const low = part.min.map(exactRationalToFloat64);
    const high = part.max.map(exactRationalToFloat64);
    const o = i * BOX_FLOATS;
    const t = i * TRANSFORM_FLOATS;
    boxes.fill(Number.POSITIVE_INFINITY, o, o + AXES);
    boxes.fill(Number.NEGATIVE_INFINITY, o + AXES, o + BOX_FLOATS);
    for (let corner = 0; corner < CORNERS; corner++) {
      const local = [0, 1, 2].map((k) => ((corner >> k) & 1 ? high[k] : low[k]) ?? 0);
      for (let r = 0; r < AXES; r++) {
        const row = t + r * ROW;
        const value =
          (m[row] ?? 0) * (local[0] ?? 0) +
          (m[row + 1] ?? 0) * (local[1] ?? 0) +
          (m[row + 2] ?? 0) * (local[2] ?? 0) +
          (m[row + TRANSLATION] ?? 0);
        boxes[o + r] = Math.min(boxes[o + r] ?? value, value);
        boxes[o + AXES + r] = Math.max(boxes[o + AXES + r] ?? value, value);
      }
    }
  }
  return boxes;
}

function planReach(boxes: Float64Array, a: number, b: number): boolean {
  for (const d of [0, 2]) {
    const low = Math.max(boxes[a * BOX_FLOATS + d] ?? 0, boxes[b * BOX_FLOATS + d] ?? 0);
    const high = Math.min(
      boxes[a * BOX_FLOATS + AXES + d] ?? 0,
      boxes[b * BOX_FLOATS + AXES + d] ?? 0,
    );
    if (!(low <= high + CANDIDATE_REACH_LDU)) return false;
  }
  return true;
}

function firstAtOrAbove(sorted: Int32Array, tops: Float64Array, height: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((tops[sorted[middle] ?? 0] ?? 0) < height) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function restingCredits(
  frames: SubmodelFrames,
  instances: PartInstances,
  extents: ReadonlyArray<PartExtents | null>,
  mates: MatePairs,
  riders: Riders,
): RestingCredit[] {
  const { vehicleOf, bogieOf } = riders;
  const count = instances.count;
  if (vehicleOf.every((vehicle) => vehicle === NO_VEHICLE)) return [];
  const { groups, groupOf } = looseGroups(count, mates, vehicleOf);
  const contact = new ExactContact(frames, instances, extents);
  const stride = bogieOf.reduce((top, bogie) => Math.max(top, bogie), ON_BODY) + 2;
  const carrierOf = (instance: number) =>
    (vehicleOf[instance] ?? NO_VEHICLE) * stride + (bogieOf[instance] ?? ON_BODY) - ON_BODY;
  const carriers = groups.map(() => new Set<number>());
  const restedOnBy = groups.map((): number[] => []);
  const boxes = modelBoxes(instances, extents);
  const tops = new Float64Array(count);
  for (let i = 0; i < count; i++) tops[i] = boxes[i * BOX_FLOATS + AXES + MODEL_UP] ?? Number.NaN;
  const byTop = Int32Array.from({ length: count }, (_, i) => i)
    .filter((i) => !Number.isNaN(tops[i] ?? Number.NaN))
    .toSorted((a, b) => (tops[a] ?? 0) - (tops[b] ?? 0));
  groups.forEach((members, g) => {
    const restsOn = new Set<number>();
    for (const upper of members) {
      const bottom = boxes[upper * BOX_FLOATS + MODEL_UP] ?? Number.NaN;
      if (Number.isNaN(bottom)) continue;
      const from = firstAtOrAbove(byTop, tops, bottom - CANDIDATE_REACH_LDU);
      for (let k = from; k < byTop.length; k++) {
        const lower = byTop[k] ?? 0;
        if ((tops[lower] ?? 0) > bottom + CANDIDATE_REACH_LDU) break;
        const riding = vehicleOf[lower] !== NO_VEHICLE;
        const other = groupOf[lower] ?? NO_GROUP;
        if (other === g || (!riding && other === NO_GROUP)) continue;
        if (!planReach(boxes, upper, lower) || !contact.restsOn(upper, lower)) continue;
        if (riding) carriers[g]?.add(carrierOf(lower));
        else restsOn.add(other);
      }
    }
    for (const other of restsOn) restedOnBy[other]?.push(g);
  });
  const work = groups.flatMap((_, g) => ((carriers[g]?.size ?? 0) > 0 ? [g] : []));
  for (let lower = work.pop(); lower !== undefined; lower = work.pop()) {
    const below = carriers[lower] ?? new Set<number>();
    for (const upper of restedOnBy[lower] ?? []) {
      const above = carriers[upper];
      if (!above) continue;
      const before = above.size;
      for (const carrier of below) above.add(carrier);
      if (above.size > before) work.push(upper);
    }
  }
  return groups.flatMap((members, g) => {
    const carrierKeys = [...(carriers[g] ?? [])];
    const vehicles = new Set(carrierKeys.map((key) => Math.floor(key / stride)));
    const [vehicle] = vehicles;
    const [only] = carrierKeys;
    if (vehicles.size !== 1 || vehicle === undefined || only === undefined) return [];
    const bogie = carrierKeys.length === 1 ? (only % stride) + ON_BODY : ON_BODY;
    return [{ vehicle, bogie, instances: members }];
  });
}

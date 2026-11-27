import { exactRationalEquals } from "@brr/math";
import { AXIS_FREE, axisDimension, axisSign } from "../connect/connector-table.ts";
import { MATE_PASS_PART, type MatePairs } from "../connect/mate-pairs.ts";
import type { PartInstances, SubmodelFrames } from "../connect/submodel-frames.ts";
import {
  BOX_AXES,
  BOX_FLOATS,
  CANDIDATE_REACH_LDU,
  ExactBoxes,
  MODEL_UP,
  modelBoxes,
  planReach,
} from "./exact-boxes.ts";
import type { PartExtents } from "./part-extents.ts";
import { overlapsWithLength } from "./placed-instance.ts";
import { UnionFind } from "./union-find.ts";

export const NO_VEHICLE = -1;
export const ON_BODY = -1;
const NO_GROUP = -1;

export interface Riders {
  readonly vehicleOf: Int32Array;
  readonly bogieOf: Int32Array;
}

export interface RestingCredit {
  readonly vehicle: number;
  readonly bogie: number;
  readonly instances: ReadonlyArray<number>;
}

function restsExactlyOn(boxes: ExactBoxes, upper: number, lower: number): boolean {
  const frame = boxes.sharedFrame(upper, lower);
  const up = boxes.up(upper, frame);
  const above = boxes.box(upper, frame);
  const below = boxes.box(lower, frame);
  if (up === AXIS_FREE || !above || !below) return false;
  const vertical = axisDimension(up);
  for (let d = 0; d < BOX_AXES; d++) {
    const across = above[d];
    const under = below[d];
    if (!across || !under) return false;
    if (d !== vertical && !overlapsWithLength(across, under)) return false;
  }
  const a = above[vertical];
  const b = below[vertical];
  if (!a || !b) return false;
  return axisSign(up) > 0 ? exactRationalEquals(a.low, b.high) : exactRationalEquals(a.high, b.low);
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
  const exact = new ExactBoxes(frames, instances, extents);
  const stride = bogieOf.reduce((top, bogie) => Math.max(top, bogie), ON_BODY) + 2;
  const carrierOf = (instance: number) =>
    (vehicleOf[instance] ?? NO_VEHICLE) * stride + (bogieOf[instance] ?? ON_BODY) - ON_BODY;
  const carriers = groups.map(() => new Set<number>());
  const restedOnBy = groups.map((): number[] => []);
  const boxes = modelBoxes(instances, extents);
  const tops = new Float64Array(count);
  for (let i = 0; i < count; i++)
    tops[i] = boxes[i * BOX_FLOATS + BOX_AXES + MODEL_UP] ?? Number.NaN;
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
        if (!planReach(boxes, upper, lower) || !restsExactlyOn(exact, upper, lower)) continue;
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

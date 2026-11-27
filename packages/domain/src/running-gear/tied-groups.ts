import { compareExactRational, exactRationalEquals, type ExactRational } from "@brr/math";
import { AXIS_FREE, AXIS_POS_Y, axisDimension, axisSign } from "../connect/connector-table.ts";
import { MATE_PASS_PART, type MatePairs } from "../connect/mate-pairs.ts";
import type { AuthoredBoxes } from "./authored-boxes.ts";
import {
  BOX_AXES,
  BOX_FLOATS,
  CANDIDATE_REACH_LDU,
  MODEL_UP,
  type ExactBox,
  type ExactBoxes,
} from "./exact-boxes.ts";
import { overlapsWithLength, type Interval } from "./placed-instance.ts";
import { UnionFind } from "./union-find.ts";

export const NO_VEHICLE = -1;
export const ON_BODY = -1;
const NO_GROUP = -1;
const ALL_AXES = [0, 1, 2] as const;

export interface Riders {
  readonly vehicleOf: Int32Array;
  readonly bogieOf: Int32Array;
}

export interface TiedGroupPoses {
  readonly identified: ExactBoxes;
  readonly authored: AuthoredBoxes;
  readonly boxes: Float64Array;
}

export interface TiedGroup {
  readonly members: ReadonlyArray<number>;
  readonly matesRiding: boolean;
}

export interface Bearing {
  readonly borne: Set<number>;
  readonly members: Set<number>;
  readonly through: Set<number>;
}

export type OutsideReason = "throughAnchoredParts" | "onSeveralVehicles" | "groupUnidentified";

export interface OutsideRefusal {
  readonly reason: OutsideReason;
  readonly instances: ReadonlyArray<number>;
  readonly groups: ReadonlyArray<number>;
}

export interface Credit {
  readonly group: number;
  readonly vehicle: number;
  readonly bogie: number;
}

type PairCase =
  | { readonly decided: true; readonly a: ExactBox; readonly b: ExactBox; readonly up: number }
  | { readonly decided: false };

const REASON_ORDER: ReadonlyArray<OutsideReason> = [
  "throughAnchoredParts",
  "onSeveralVehicles",
  "groupUnidentified",
];

function readsAcrossParts(mates: MatePairs, mate: number): boolean {
  return mates.passOf(mate) !== MATE_PASS_PART;
}

function apart(boxes: Float64Array, a: number, b: number): boolean {
  return ALL_AXES.some((d) => {
    const low = Math.max(boxes[a * BOX_FLOATS + d] ?? 0, boxes[b * BOX_FLOATS + d] ?? 0);
    const high = Math.min(
      boxes[a * BOX_FLOATS + BOX_AXES + d] ?? 0,
      boxes[b * BOX_FLOATS + BOX_AXES + d] ?? 0,
    );
    return low - high > CANDIDATE_REACH_LDU;
  });
}

function meetsAtEndpoint(a: Interval, b: Interval): boolean {
  return exactRationalEquals(a.high, b.low) || exactRationalEquals(b.high, a.low);
}

function through(pair: PairCase): boolean {
  if (!pair.decided) return false;
  return ALL_AXES.every((d) => {
    const a = pair.a[d];
    const b = pair.b[d];
    return a !== undefined && b !== undefined && overlapsWithLength(a, b);
  });
}

function touches(pair: PairCase): boolean {
  if (!pair.decided) return false;
  let met = 0;
  for (const d of ALL_AXES) {
    const a = pair.a[d];
    const b = pair.b[d];
    if (!a || !b) return false;
    if (overlapsWithLength(a, b)) continue;
    if (!meetsAtEndpoint(a, b)) return false;
    met++;
  }
  return met === 1;
}

function restsOn(pair: PairCase): boolean {
  if (!pair.decided || !touches(pair)) return false;
  const vertical = axisDimension(pair.up);
  const a = pair.a[vertical];
  const b = pair.b[vertical];
  if (!a || !b) return false;
  return axisSign(pair.up) > 0
    ? exactRationalEquals(a.low, b.high)
    : exactRationalEquals(a.high, b.low);
}

function swapped(pair: PairCase): PairCase {
  return pair.decided ? { decided: true, a: pair.b, b: pair.a, up: pair.up } : pair;
}

function addTo(map: Map<number, Set<number>>, key: number, value: number): void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(value);
}

export class TiedGroups {
  readonly groups: ReadonlyArray<TiedGroup>;
  readonly groupOf: Int32Array;
  private readonly floatBoxed: Uint8Array;
  private readonly undecidedRiders = new Map<number, Set<number>>();
  private readonly undecidedLoose = new Map<number, Set<number>>();
  private readonly undecidableBySeating = new Set<number>();

  constructor(
    private readonly poses: TiedGroupPoses,
    mates: MatePairs,
    riders: Riders,
    count: number,
  ) {
    this.floatBoxed = Uint8Array.from({ length: count }, (_, i) =>
      Number.isNaN(poses.boxes[i * BOX_FLOATS] ?? Number.NaN) ? 0 : 1,
    );
    const outside = (i: number) => riders.vehicleOf[i] === NO_VEHICLE;
    const ties = new UnionFind(count);
    const matesRiding = new Uint8Array(count);
    for (let m = 0; m < mates.count; m++) {
      if (!readsAcrossParts(mates, m)) continue;
      const male = mates.maleInstance[m] ?? 0;
      const female = mates.femaleInstance[m] ?? 0;
      if (outside(male) && outside(female)) ties.union(male, female);
      else if (outside(male)) matesRiding[male] = 1;
      else if (outside(female)) matesRiding[female] = 1;
    }
    const loose = Array.from({ length: count }, (_, i) => i).filter(outside);
    this.tieByGeometry(loose, ties);
    const indexOfRoot = new Map<number, number>();
    const groups: Array<{ members: number[]; matesRiding: boolean }> = [];
    this.groupOf = new Int32Array(count).fill(NO_GROUP);
    for (const i of loose) {
      const root = ties.find(i);
      let g = indexOfRoot.get(root);
      if (g === undefined) {
        g = groups.length;
        indexOfRoot.set(root, g);
        groups.push({ members: [], matesRiding: false });
      }
      const group = groups[g];
      if (!group) continue;
      group.members.push(i);
      if (matesRiding[i] === 1) group.matesRiding = true;
      this.groupOf[i] = g;
    }
    this.groups = groups;
  }

  undecidable(group: number): boolean {
    if (this.undecidableBySeating.has(group)) return true;
    return (this.groups[group]?.members ?? []).some(
      (i) => this.undecidedRiders.has(i) || this.undecidedLoose.has(i),
    );
  }

  reach(group: number, riders: Riders, riding: ReadonlyArray<ReadonlyArray<number>>): Set<number> {
    const vehicles = new Set(this.bearsOn(group, riding).keys());
    for (const member of this.groups[group]?.members ?? []) {
      for (const rider of this.undecidedRiders.get(member) ?? []) {
        const vehicle = riders.vehicleOf[rider] ?? NO_VEHICLE;
        if (vehicle !== NO_VEHICLE) vehicles.add(vehicle);
      }
      for (const other of this.undecidedLoose.get(member) ?? []) {
        const vehicle = riders.vehicleOf[other] ?? NO_VEHICLE;
        if (vehicle !== NO_VEHICLE) {
          vehicles.add(vehicle);
          continue;
        }
        const otherGroup = this.groupOf[other] ?? NO_GROUP;
        if (otherGroup === NO_GROUP || otherGroup === group) continue;
        for (const borne of this.bearsOn(otherGroup, riding).keys()) vehicles.add(borne);
      }
    }
    return vehicles;
  }

  bearsOn(group: number, riding: ReadonlyArray<ReadonlyArray<number>>): Map<number, Bearing> {
    const result = new Map<number, Bearing>();
    for (const member of this.groups[group]?.members ?? []) {
      riding.forEach((instances, vehicle) => {
        for (const rider of instances) {
          if (this.skips(member, rider)) continue;
          const pair = this.pair(member, rider);
          if (!pair.decided) {
            addTo(this.undecidedRiders, member, rider);
            continue;
          }
          const isThrough = through(pair);
          if (!isThrough && !touches(pair)) continue;
          let entry = result.get(vehicle);
          if (!entry) {
            entry = { borne: new Set(), members: new Set(), through: new Set() };
            result.set(vehicle, entry);
          }
          entry.borne.add(rider);
          entry.members.add(member);
          if (isThrough) entry.through.add(member);
        }
      });
    }
    return result;
  }

  anchored(
    group: number,
    bearing: Map<number, Bearing>,
    wheels: ReadonlyArray<ReadonlyArray<number>>,
  ): boolean {
    const g = this.groups[group];
    if (!g) return false;
    if (g.matesRiding) return true;
    const { authored } = this.poses;
    for (const vehicle of bearing.keys()) {
      let floor: Interval["low"] | null = null;
      for (const wheel of wheels[vehicle] ?? []) {
        const low = authored.box(wheel)?.[MODEL_UP]?.low;
        if (low === undefined) {
          this.undecidableBySeating.add(group);
          continue;
        }
        if (floor === null || compareExactRational(low, floor) < 0) floor = low;
      }
      if (floor === null) continue;
      for (const member of g.members) {
        const low = authored.box(member)?.[MODEL_UP]?.low;
        if (low === undefined) {
          this.undecidableBySeating.add(group);
          continue;
        }
        if (compareExactRational(low, floor) < 0) return true;
      }
    }
    return false;
  }

  private pair(n: number, r: number): PairCase {
    const { identified, authored } = this.poses;
    if (identified.hasExtents(n) && identified.hasExtents(r)) {
      const frame = identified.sharedFrame(n, r);
      const up = identified.up(n, frame);
      const a = identified.box(n, frame);
      const b = identified.box(r, frame);
      if (up !== AXIS_FREE && a && b) return { decided: true, a, b, up };
    }
    const a = authored.box(n);
    const b = authored.box(r);
    if (!a || !b) return { decided: false };
    return { decided: true, a, b, up: AXIS_POS_Y };
  }

  private boxed(i: number): boolean {
    return this.floatBoxed[i] === 1 && this.poses.authored.box(i) !== null;
  }

  private skips(a: number, b: number): boolean {
    if (!this.boxed(a) || !this.boxed(b)) return false;
    return apart(this.poses.boxes, a, b);
  }

  private tie(a: number, b: number, ties: UnionFind): void {
    const pair = this.pair(a, b);
    if (!pair.decided) {
      addTo(this.undecidedLoose, a, b);
      addTo(this.undecidedLoose, b, a);
      return;
    }
    if (through(pair) || restsOn(pair) || restsOn(swapped(pair))) ties.union(a, b);
  }

  private tieByGeometry(loose: ReadonlyArray<number>, ties: UnionFind): void {
    const { boxes } = this.poses;
    const boxed = loose.filter((i) => this.boxed(i));
    const unboxed = loose.filter((i) => !this.boxed(i));
    const sorted = boxed.toSorted(
      (a, b) => (boxes[a * BOX_FLOATS] ?? 0) - (boxes[b * BOX_FLOATS] ?? 0),
    );
    for (let k = 0; k < sorted.length; k++) {
      const a = sorted[k] ?? 0;
      const reach = (boxes[a * BOX_FLOATS + BOX_AXES] ?? 0) + CANDIDATE_REACH_LDU;
      for (let j = k + 1; j < sorted.length; j++) {
        const b = sorted[j] ?? 0;
        if ((boxes[b * BOX_FLOATS] ?? 0) > reach) break;
        if (ties.find(a) === ties.find(b) || this.skips(a, b)) continue;
        this.tie(a, b, ties);
      }
    }
    unboxed.forEach((a, k) => {
      for (const b of boxed) this.tie(a, b, ties);
      for (const b of unboxed.slice(k + 1)) this.tie(a, b, ties);
    });
  }
}

export function ridingSets(
  riders: Riders,
  candidates: number,
  wheels: ReadonlyArray<ReadonlyArray<number>>,
): number[][] {
  const seated = new Set(wheels.flat());
  const riding = Array.from({ length: candidates }, (): number[] => []);
  riders.vehicleOf.forEach((vehicle, instance) => {
    if (vehicle !== NO_VEHICLE && !seated.has(instance)) riding[vehicle]?.push(instance);
  });
  return riding;
}

export type PivotPair = readonly [ReadonlyArray<ExactRational>, ReadonlyArray<ExactRational>];

export interface MergeablePairs {
  mergeable(
    members: ReadonlyArray<number>,
    trucks: readonly [number, number],
    vehicleOf: Int32Array,
  ): PivotPair | null;
}

export interface Merge {
  readonly trucks: readonly [number, number];
  readonly groups: ReadonlyArray<number>;
  readonly pivots: PivotPair;
}

export interface Rounds {
  readonly credits: ReadonlyArray<Credit>;
  readonly merges: ReadonlyArray<Merge>;
}

function withoutSharedTrucks(pairs: ReadonlyArray<Merge>): Merge[] {
  const named = new Map<number, number>();
  for (const merge of pairs) {
    for (const truck of merge.trucks) named.set(truck, (named.get(truck) ?? 0) + 1);
  }
  return pairs.filter((merge) => merge.trucks.every((truck) => named.get(truck) === 1));
}

function applyMerge(merge: Merge, riders: Riders, tied: TiedGroups, wheels: number[][]): void {
  const [kept, absorbed] = merge.trucks;
  riders.vehicleOf.forEach((vehicle, instance) => {
    if (vehicle === kept) riders.bogieOf[instance] = 0;
    if (vehicle === absorbed) {
      riders.vehicleOf[instance] = kept;
      riders.bogieOf[instance] = 1;
    }
  });
  for (const group of merge.groups) {
    for (const member of tied.groups[group]?.members ?? []) {
      riders.vehicleOf[member] = kept;
      riders.bogieOf[member] = ON_BODY;
    }
  }
  wheels[kept] = [...(wheels[kept] ?? []), ...(wheels[absorbed] ?? [])];
  wheels[absorbed] = [];
}

function ontoMergedTruck(credit: Credit, merges: ReadonlyArray<Merge>): Credit {
  for (const { trucks } of merges) {
    const bogie = trucks.indexOf(credit.vehicle);
    if (bogie >= 0) return { group: credit.group, vehicle: trucks[0], bogie };
  }
  return credit;
}

export function creditInRounds(
  tied: TiedGroups,
  riders: Riders,
  candidates: number,
  wheels: number[][],
  pairs: MergeablePairs | null,
): Rounds {
  const credits: Credit[] = [];
  const merges: Merge[] = [];
  const settled = new Uint8Array(tied.groups.length);
  const merged = new Set<number>();
  for (;;) {
    const riding = ridingSets(riders, candidates, wheels);
    const collected: Credit[] = [];
    const named = new Map<string, Merge>();
    tied.groups.forEach((group, g) => {
      if (settled[g] === 1 || group.matesRiding) return;
      const bearing = tied.bearsOn(g, riding);
      if (bearing.size < 1 || bearing.size > 2) return;
      if (tied.anchored(g, bearing, wheels) || tied.undecidable(g)) return;
      if (bearing.size === 2) {
        const [a = 0, b = 0] = [...bearing.keys()].toSorted((x, y) => x - y);
        if (!pairs || merged.has(a) || merged.has(b)) return;
        const pivots = pairs.mergeable(group.members, [a, b], riders.vehicleOf);
        if (!pivots) return;
        const key = `${a} ${b}`;
        const known = named.get(key);
        named.set(key, {
          trucks: [a, b],
          groups: [...(known?.groups ?? []), g],
          pivots: known?.pivots ?? pivots,
        });
        return;
      }
      const [[vehicle, entry] = []] = bearing;
      if (vehicle === undefined || !entry) return;
      const bogies = new Set([...entry.borne].map((i) => riders.bogieOf[i] ?? ON_BODY));
      const [only] = bogies;
      collected.push({
        group: g,
        vehicle,
        bogie: bogies.size === 1 && only !== undefined ? only : ON_BODY,
      });
    });
    const roundMerges = withoutSharedTrucks([...named.values()]);
    if (collected.length === 0 && roundMerges.length === 0) return { credits, merges };
    for (const merge of roundMerges) {
      applyMerge(merge, riders, tied, wheels);
      for (const group of merge.groups) settled[group] = 1;
      merged.add(merge.trucks[0]);
      merged.add(merge.trucks[1]);
    }
    const roundCredits = collected.map((credit) => ontoMergedTruck(credit, roundMerges));
    for (const credit of roundCredits) {
      settled[credit.group] = 1;
      for (const member of tied.groups[credit.group]?.members ?? []) {
        riders.vehicleOf[member] = credit.vehicle;
        riders.bogieOf[member] = credit.bogie;
      }
    }
    credits.push(...roundCredits);
    merges.push(...roundMerges);
  }
}

export function outsideRefusals(
  tied: TiedGroups,
  riders: Riders,
  candidates: number,
  wheels: ReadonlyArray<ReadonlyArray<number>>,
  credits: ReadonlyArray<Credit>,
  survivors: ReadonlySet<number>,
): Map<number, OutsideRefusal> {
  const riding = ridingSets(riders, candidates, wheels);
  const found = new Map<
    number,
    Map<OutsideReason, { instances: Set<number>; groups: Set<number> }>
  >();
  const note = (
    vehicle: number,
    reason: OutsideReason,
    group: number,
    instances: Iterable<number>,
  ) => {
    if (!survivors.has(vehicle)) return;
    let reasons = found.get(vehicle);
    if (!reasons) {
      reasons = new Map();
      found.set(vehicle, reasons);
    }
    let entry = reasons.get(reason);
    if (!entry) {
      entry = { instances: new Set(), groups: new Set() };
      reasons.set(reason, entry);
    }
    for (const i of instances) entry.instances.add(i);
    entry.groups.add(group);
  };
  const owners = new Map(credits.map((credit) => [credit.group, credit.vehicle]));
  tied.groups.forEach((group, g) => {
    const owner = owners.get(g);
    if (owner !== undefined) {
      const others = riding.map((instances, vehicle) => (vehicle === owner ? [] : instances));
      for (const [vehicle, entry] of tied.bearsOn(g, others)) {
        note(vehicle, "onSeveralVehicles", g, entry.members);
        note(owner, "onSeveralVehicles", g, entry.members);
      }
      return;
    }
    const bearing = tied.bearsOn(g, riding);
    const anchored = tied.anchored(g, bearing, wheels);
    const decided = new Set<number>();
    for (const [vehicle, entry] of bearing) {
      if (anchored && entry.through.size > 0) {
        note(vehicle, "throughAnchoredParts", g, entry.through);
        decided.add(vehicle);
      } else if (!anchored && bearing.size >= 2) {
        const bearingMembers = [...bearing.values()].flatMap((e) => [...e.members]);
        note(vehicle, "onSeveralVehicles", g, bearingMembers);
        decided.add(vehicle);
      }
    }
    if (!tied.undecidable(g)) return;
    for (const vehicle of tied.reach(g, riders, riding)) {
      if (!decided.has(vehicle)) note(vehicle, "groupUnidentified", g, group.members);
    }
  });
  const refusals = new Map<number, OutsideRefusal>();
  for (const [vehicle, reasons] of found) {
    const reason = REASON_ORDER.find((r) => reasons.has(r));
    const entry = reason ? reasons.get(reason) : undefined;
    if (!reason || !entry) continue;
    refusals.set(vehicle, {
      reason,
      instances: [...entry.instances].toSorted((a, b) => a - b),
      groups: [...entry.groups].toSorted((a, b) => a - b),
    });
  }
  return refusals;
}

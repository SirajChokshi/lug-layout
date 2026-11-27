import { compareExactRational, exactRationalEquals } from "@brr/math";
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

export interface LoadPoses {
  readonly identified: ExactBoxes;
  readonly authored: AuthoredBoxes;
  readonly boxes: Float64Array;
}

export interface LoadGroup {
  readonly members: ReadonlyArray<number>;
  readonly excluded: boolean;
}

export interface Bearing {
  readonly borne: Set<number>;
  readonly members: Set<number>;
  readonly through: Set<number>;
}

export type OutsideReason = "throughStandingParts" | "onSeveralVehicles" | "loadUnidentified";

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
  "throughStandingParts",
  "onSeveralVehicles",
  "loadUnidentified",
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

export class LoadJudge {
  readonly groups: ReadonlyArray<LoadGroup>;
  readonly groupOf: Int32Array;
  private readonly boxless: Uint8Array;
  private readonly floatBoxed: Uint8Array;

  constructor(
    private readonly poses: LoadPoses,
    mates: MatePairs,
    riders: Riders,
    count: number,
  ) {
    this.boxless = new Uint8Array(count);
    this.floatBoxed = Uint8Array.from({ length: count }, (_, i) =>
      Number.isNaN(poses.boxes[i * BOX_FLOATS] ?? Number.NaN) ? 0 : 1,
    );
    const outside = (i: number) => riders.vehicleOf[i] === NO_VEHICLE;
    const ties = new UnionFind(count);
    const excluded = new Uint8Array(count);
    for (let m = 0; m < mates.count; m++) {
      if (!readsAcrossParts(mates, m)) continue;
      const male = mates.maleInstance[m] ?? 0;
      const female = mates.femaleInstance[m] ?? 0;
      if (outside(male) && outside(female)) ties.union(male, female);
      else if (outside(male)) excluded[male] = 1;
      else if (outside(female)) excluded[female] = 1;
    }
    const loose = Array.from({ length: count }, (_, i) => i).filter(outside);
    for (const i of loose) {
      if (this.floatBoxed[i] !== 1) this.boxless[i] = 1;
    }
    this.tieByGeometry(loose, ties);
    const indexOfRoot = new Map<number, number>();
    const groups: Array<{ members: number[]; excluded: boolean }> = [];
    this.groupOf = new Int32Array(count).fill(NO_GROUP);
    for (const i of loose) {
      const root = ties.find(i);
      let g = indexOfRoot.get(root);
      if (g === undefined) {
        g = groups.length;
        indexOfRoot.set(root, g);
        groups.push({ members: [], excluded: false });
      }
      const group = groups[g];
      if (!group) continue;
      group.members.push(i);
      if (excluded[i] === 1) group.excluded = true;
      this.groupOf[i] = g;
    }
    this.groups = groups;
  }

  undecidable(group: number): boolean {
    return (this.groups[group]?.members ?? []).some((i) => this.boxless[i] === 1);
  }

  bearsOn(group: number, riding: ReadonlyArray<ReadonlyArray<number>>): Map<number, Bearing> {
    const result = new Map<number, Bearing>();
    for (const member of this.groups[group]?.members ?? []) {
      riding.forEach((instances, vehicle) => {
        for (const rider of instances) {
          if (this.skips(member, rider)) continue;
          const pair = this.pair(member, rider);
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
    if (g.excluded) return true;
    const { authored } = this.poses;
    for (const vehicle of bearing.keys()) {
      let floor: Interval["low"] | null = null;
      for (const wheel of wheels[vehicle] ?? []) {
        const low = authored.box(wheel)?.[MODEL_UP]?.low;
        if (low !== undefined && (floor === null || compareExactRational(low, floor) < 0)) {
          floor = low;
        }
      }
      if (floor === null) continue;
      for (const member of g.members) {
        const low = authored.box(member)?.[MODEL_UP]?.low;
        if (low === undefined) {
          this.boxless[member] = 1;
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
    if (!a) this.boxless[n] = 1;
    if (!b) this.boxless[r] = 1;
    if (!a || !b) return { decided: false };
    return { decided: true, a, b, up: AXIS_POS_Y };
  }

  private skips(a: number, b: number): boolean {
    if (this.floatBoxed[a] !== 1 || this.floatBoxed[b] !== 1) return false;
    if (!this.poses.authored.box(a) || !this.poses.authored.box(b)) return false;
    return apart(this.poses.boxes, a, b);
  }

  private tieByGeometry(loose: ReadonlyArray<number>, ties: UnionFind): void {
    const { boxes } = this.poses;
    const sorted = loose
      .filter((i) => this.floatBoxed[i] === 1)
      .toSorted((a, b) => (boxes[a * BOX_FLOATS] ?? 0) - (boxes[b * BOX_FLOATS] ?? 0));
    for (let k = 0; k < sorted.length; k++) {
      const a = sorted[k] ?? 0;
      const reach = (boxes[a * BOX_FLOATS + BOX_AXES] ?? 0) + CANDIDATE_REACH_LDU;
      for (let j = k + 1; j < sorted.length; j++) {
        const b = sorted[j] ?? 0;
        if ((boxes[b * BOX_FLOATS] ?? 0) > reach) break;
        if (ties.find(a) === ties.find(b) || this.skips(a, b)) continue;
        const pair = this.pair(a, b);
        if (through(pair) || restsOn(pair) || restsOn(swapped(pair))) ties.union(a, b);
      }
    }
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

export function creditInRounds(
  judge: LoadJudge,
  riders: Riders,
  candidates: number,
  wheels: ReadonlyArray<ReadonlyArray<number>>,
): Credit[] {
  const credits: Credit[] = [];
  const credited = new Uint8Array(judge.groups.length);
  for (;;) {
    const riding = ridingSets(riders, candidates, wheels);
    const round: Credit[] = [];
    judge.groups.forEach((group, g) => {
      if (credited[g] === 1 || group.excluded) return;
      const bearing = judge.bearsOn(g, riding);
      if (bearing.size !== 1 || judge.anchored(g, bearing, wheels) || judge.undecidable(g)) return;
      const [[vehicle, entry] = []] = bearing;
      if (vehicle === undefined || !entry) return;
      const bogies = new Set([...entry.borne].map((i) => riders.bogieOf[i] ?? ON_BODY));
      const [only] = bogies;
      round.push({
        group: g,
        vehicle,
        bogie: bogies.size === 1 && only !== undefined ? only : ON_BODY,
      });
    });
    if (round.length === 0) return credits;
    for (const credit of round) {
      credited[credit.group] = 1;
      for (const member of judge.groups[credit.group]?.members ?? []) {
        riders.vehicleOf[member] = credit.vehicle;
        riders.bogieOf[member] = credit.bogie;
      }
    }
    credits.push(...round);
  }
}

export function outsideRefusals(
  judge: LoadJudge,
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
  judge.groups.forEach((group, g) => {
    const owner = owners.get(g);
    if (owner !== undefined) {
      const others = riding.map((instances, vehicle) => (vehicle === owner ? [] : instances));
      for (const [vehicle, entry] of judge.bearsOn(g, others)) {
        note(vehicle, "onSeveralVehicles", g, entry.members);
        note(owner, "onSeveralVehicles", g, entry.members);
      }
      return;
    }
    const bearing = judge.bearsOn(g, riding);
    const anchored = judge.anchored(g, bearing, wheels);
    for (const [vehicle, entry] of bearing) {
      if (anchored && entry.through.size > 0) {
        note(vehicle, "throughStandingParts", g, entry.through);
      } else if (!anchored && bearing.size >= 2) {
        note(vehicle, "onSeveralVehicles", g, entry.members);
      }
    }
    if (judge.undecidable(g)) {
      for (const vehicle of survivors) note(vehicle, "loadUnidentified", g, group.members);
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

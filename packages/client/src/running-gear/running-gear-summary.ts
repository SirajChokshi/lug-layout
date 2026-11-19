import type { ModelRunningGear } from "@brr/catalog";
import type { UnreadRollingReason } from "@brr/schema/bundle";

export interface UnreadReasonCount {
  readonly reason: UnreadRollingReason;
  readonly rows: number;
}

export interface UnreadSummary {
  readonly counts: ReadonlyArray<UnreadReasonCount>;
  readonly listed: Uint32Array;
  readonly others: Uint32Array;
}

export function isPlayable(gear: ModelRunningGear): boolean {
  return gear.vehicles.length > 0 && gear.unresolvedRunningGear.length === 0;
}

export function hasRunningGear(gear: ModelRunningGear): boolean {
  return (
    gear.vehicles.length > 0 ||
    gear.unresolvedRunningGear.length > 0 ||
    gear.unreadRollingBands.instance.length > 0
  );
}

function runningGearInstances(gear: ModelRunningGear): Set<number> {
  const instances = new Set<number>();
  for (const vehicle of gear.vehicles) {
    for (const instance of vehicle.body) instances.add(instance);
    for (const bogie of vehicle.bogies)
      for (const instance of bogie.instances) instances.add(instance);
    for (const wheelset of vehicle.wheelsets) {
      for (const member of wheelset.members) instances.add(member.instance);
    }
  }
  for (const report of gear.unresolvedRunningGear) {
    for (const instance of report.instances) instances.add(instance);
  }
  return instances;
}

export function unreadSummary(gear: ModelRunningGear): UnreadSummary {
  const { instance, reason } = gear.unreadRollingBands;
  const referenced = new Set(gear.unresolvedRunningGear.flatMap((report) => report.unreadRows));
  const onRunningGear = runningGearInstances(gear);
  const counts = new Map<UnreadRollingReason, number>();
  const listed: number[] = [];
  const others: number[] = [];
  for (let row = 0; row < instance.length; row++) {
    const rowReason = reason[row];
    if (rowReason !== undefined) counts.set(rowReason, (counts.get(rowReason) ?? 0) + 1);
    if (referenced.has(row) || onRunningGear.has(instance[row] ?? -1)) listed.push(row);
    else others.push(row);
  }
  return {
    counts: [...counts]
      .map(([countedReason, rows]) => ({ reason: countedReason, rows }))
      .toSorted((a, b) => b.rows - a.rows || a.reason.localeCompare(b.reason)),
    listed: Uint32Array.from(listed),
    others: Uint32Array.from(others),
  };
}

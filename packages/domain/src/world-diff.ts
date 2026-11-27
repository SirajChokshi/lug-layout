import { PLATE_LDU, STUD_LDU, zeta16FloorStuds } from "@brr/math";
import { decodeTrackPosition, type PlacementRecordV1, type TrackRecordV1 } from "@brr/schema/world";

export interface WorldRecords {
  readonly placements: ReadonlyArray<PlacementRecordV1>;
  readonly track: ReadonlyArray<TrackRecordV1>;
}

export interface MovedRecord<T> {
  readonly from: T;
  readonly to: T;
}

export interface RecordChanges<T> {
  readonly added: ReadonlyArray<T>;
  readonly removed: ReadonlyArray<T>;
  readonly moved: ReadonlyArray<MovedRecord<T>>;
}

export interface WorldDiff {
  readonly placements: RecordChanges<PlacementRecordV1>;
  readonly track: RecordChanges<TrackRecordV1>;
}

interface Keyed<T> {
  readonly record: T;
  readonly item: string;
  readonly identity: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

interface Pair<T> {
  readonly from: Keyed<T>;
  readonly to: Keyed<T>;
  readonly distance: number;
}

function keyed<T>(record: T, item: string, pose: string, x: number, y: number, z: number) {
  return { record, item, identity: `${item}|${pose}`, x, y, z };
}

function keyedPlacement(record: PlacementRecordV1): Keyed<PlacementRecordV1> {
  const { ref, color, x, z, yPlates, rot } = record;
  return keyed(record, `${ref} ${color}`, `${x} ${z} ${yPlates} ${rot}`, x, yPlates * PLATE_LDU, z);
}

function keyedTrack(record: TrackRecordV1): Keyed<TrackRecordV1> {
  const { ref, heading, position, yPlates, rise } = record;
  const studs = zeta16FloorStuds(decodeTrackPosition(position));
  return keyed(
    record,
    ref,
    `${heading} ${position.join(" ")} ${yPlates} ${rise ?? 0}`,
    Number(studs.x) * STUD_LDU,
    yPlates * PLATE_LDU,
    Number(studs.z) * STUD_LDU,
  );
}

function byIdentity<T>(a: Keyed<T>, b: Keyed<T>): number {
  return a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0;
}

function grouped<T>(entries: ReadonlyArray<Keyed<T>>, key: (entry: Keyed<T>) => string) {
  const groups = new Map<string, Keyed<T>[]>();
  for (const entry of entries) {
    const group = groups.get(key(entry));
    if (group) group.push(entry);
    else groups.set(key(entry), [entry]);
  }
  return groups;
}

function closestFirst<T>(a: Pair<T>, b: Pair<T>): number {
  return a.distance - b.distance || byIdentity(a.from, b.from) || byIdentity(a.to, b.to);
}

function changes<T>(before: ReadonlyArray<Keyed<T>>, after: ReadonlyArray<Keyed<T>>) {
  const unmatched = grouped(before, (entry) => entry.identity);
  const added: Keyed<T>[] = [];
  for (const entry of after) {
    if (unmatched.get(entry.identity)?.pop() === undefined) added.push(entry);
  }
  const removed = [...unmatched.values()].flat();
  const removedByItem = grouped(removed, (entry) => entry.item);
  const pairs: Pair<T>[] = [];
  for (const to of added) {
    for (const from of removedByItem.get(to.item) ?? []) {
      const distance = Math.abs(to.x - from.x) + Math.abs(to.y - from.y) + Math.abs(to.z - from.z);
      pairs.push({ from, to, distance });
    }
  }
  pairs.sort(closestFirst);
  const moved = new Set<Keyed<T>>();
  const movedPairs: MovedRecord<T>[] = [];
  for (const { from, to } of pairs) {
    if (moved.has(from) || moved.has(to)) continue;
    moved.add(from);
    moved.add(to);
    movedPairs.push({ from: from.record, to: to.record });
  }
  const left = (entries: ReadonlyArray<Keyed<T>>): T[] =>
    entries
      .filter((entry) => !moved.has(entry))
      .toSorted(byIdentity)
      .map((entry) => entry.record);
  return { added: left(added), removed: left(removed), moved: movedPairs };
}

export function diffWorlds(before: WorldRecords, after: WorldRecords): WorldDiff {
  return {
    placements: changes(
      before.placements.map(keyedPlacement),
      after.placements.map(keyedPlacement),
    ),
    track: changes(before.track.map(keyedTrack), after.track.map(keyedTrack)),
  };
}

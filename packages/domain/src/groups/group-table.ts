import { decode, type Decoded, type Issue } from "@brr/schema/decode";
import { GROUP_ID_MAX, GroupRecordV2, GroupTableV2 } from "@brr/schema/world";

export type GroupAction = "group" | "ungroup";

export interface GroupTagged<M> {
  readonly member: M;
  readonly layer: number;
  readonly group: number | null;
}

export interface GroupRetag<M> {
  readonly member: M;
  readonly layer: number;
  readonly from: number | null;
  readonly to: number | null;
}

export interface GroupMembers<P> {
  readonly placements: ReadonlyArray<GroupTagged<P>>;
  readonly pieces: ReadonlyArray<GroupTagged<number>>;
}

export interface GroupChange<P> {
  readonly action: GroupAction;
  readonly groups: ReadonlyArray<number>;
  readonly before: GroupTable;
  readonly after: GroupTable;
  readonly placements: ReadonlyArray<GroupRetag<P>>;
  readonly pieces: ReadonlyArray<GroupRetag<number>>;
}

export interface CreatedGroup {
  readonly table: GroupTable;
  readonly id: number;
}

const SELECTION = "selection";

function refused<T>(path: string, message: string): Decoded<T> {
  return { ok: false, issues: [{ path, message }] };
}

function groupPath(id: number): string {
  return `group ${id}`;
}

function withParent(record: GroupRecordV2, parent: number | undefined): GroupRecordV2 {
  return parent === undefined ? { id: record.id, name: record.name } : { ...record, parent };
}

function outermostIds(groups: ReadonlyArray<GroupRecordV2>): ReadonlyMap<number, number> {
  const parentOf = new Map(groups.map((group) => [group.id, group.parent]));
  const outermost = new Map<number, number>();
  for (const group of groups) {
    const chain: number[] = [];
    let id = group.id;
    let root = outermost.get(id);
    while (root === undefined) {
      chain.push(id);
      const parent = parentOf.get(id);
      if (parent === undefined) root = id;
      else {
        id = parent;
        root = outermost.get(id);
      }
    }
    for (const visited of chain) outermost.set(visited, root);
  }
  return outermost;
}

export class GroupTable {
  static readonly empty: GroupTable = new GroupTable([]);

  private readonly byId: ReadonlyMap<number, GroupRecordV2>;
  private readonly outermostOf: ReadonlyMap<number, number>;

  private constructor(readonly groups: ReadonlyArray<GroupRecordV2>) {
    this.byId = new Map(groups.map((group) => [group.id, group]));
    this.outermostOf = outermostIds(groups);
  }

  static of(groups: unknown, path: string): Decoded<GroupTable> {
    if (groups === undefined) return { ok: true, value: GroupTable.empty };
    const decoded = decode(GroupTableV2, groups, path);
    return decoded.ok ? { ok: true, value: new GroupTable(decoded.value) } : decoded;
  }

  group(id: number): GroupRecordV2 | undefined {
    return this.byId.get(id);
  }

  outermost(id: number): number | undefined {
    return this.outermostOf.get(id);
  }

  created(children: ReadonlyArray<number>, nameFor: (id: number) => string): Decoded<CreatedGroup> {
    for (const child of children) {
      const record = this.byId.get(child);
      if (!record) return this.unlisted(child);
      if (record.parent !== undefined) {
        return refused(groupPath(child), `is inside group ${record.parent}, not outermost`);
      }
    }
    const id = this.freeId();
    if (id === null) return refused("groups", `already use every group id 0-${GROUP_ID_MAX}`);
    const record = decode(GroupRecordV2, { id, name: nameFor(id) }, groupPath(id));
    if (!record.ok) return record;
    const nested = new Set(children);
    const rows = this.groups.map((row) => (nested.has(row.id) ? withParent(row, id) : row));
    rows.push(record.value);
    rows.sort((a, b) => a.id - b.id);
    return { ok: true, value: { table: new GroupTable(rows), id } };
  }

  dissolved(id: number): Decoded<GroupTable> {
    const record = this.byId.get(id);
    if (!record) return this.unlisted(id);
    const rows = this.groups.flatMap((row) => {
      if (row.id === id) return [];
      return row.parent === id ? [withParent(row, record.parent)] : [row];
    });
    return { ok: true, value: new GroupTable(rows) };
  }

  private unlisted<T>(id: number): Decoded<T> {
    return refused(groupPath(id), "isn't in the group table");
  }

  private freeId(): number | null {
    const highest = this.groups.at(-1)?.id ?? -1;
    if (highest < GROUP_ID_MAX) return highest + 1;
    for (let id = 0; id <= GROUP_ID_MAX; id++) if (!this.byId.has(id)) return id;
    return null;
  }
}

function everyTagged<P>(members: GroupMembers<P>): ReadonlyArray<GroupTagged<unknown>> {
  return [...members.placements, ...members.pieces];
}

function outermostOfMembers<P>(
  table: GroupTable,
  members: GroupMembers<P>,
): Decoded<ReadonlySet<number>> {
  const outermost = new Set<number>();
  const issues: Issue[] = [];
  for (const { group } of everyTagged(members)) {
    if (group === null) continue;
    const root = table.outermost(group);
    if (root === undefined)
      issues.push({ path: groupPath(group), message: "isn't in the group table" });
    else outermost.add(root);
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value: outermost };
}

function retagged<M>(
  tagged: ReadonlyArray<GroupTagged<M>>,
  to: (group: number | null) => number | null | undefined,
): GroupRetag<M>[] {
  return tagged.flatMap(({ member, layer, group }) => {
    const next = to(group);
    return next === undefined || next === group ? [] : [{ member, layer, from: group, to: next }];
  });
}

export function groupingChange<P>(
  table: GroupTable,
  members: GroupMembers<P>,
  nameFor: (id: number) => string,
): Decoded<GroupChange<P>> {
  const outermost = outermostOfMembers(table, members);
  if (!outermost.ok) return outermost;
  const loose = everyTagged(members).filter(({ group }) => group === null).length;
  if (outermost.value.size + loose < 2) {
    return refused(SELECTION, "holds one part or group, so there's nothing to group it with");
  }
  const created = table.created([...outermost.value], nameFor);
  if (!created.ok) return created;
  const { id } = created.value;
  const into = (group: number | null): number | undefined => (group === null ? id : undefined);
  return {
    ok: true,
    value: {
      action: "group",
      groups: [id],
      before: table,
      after: created.value.table,
      placements: retagged(members.placements, into),
      pieces: retagged(members.pieces, into),
    },
  };
}

export function ungroupingChange<P>(
  table: GroupTable,
  members: GroupMembers<P>,
): Decoded<GroupChange<P>> {
  const outermost = outermostOfMembers(table, members);
  if (!outermost.ok) return outermost;
  if (outermost.value.size === 0) return refused(SELECTION, "holds no group");
  const dissolving = [...outermost.value].toSorted((a, b) => a - b);
  let after = table;
  for (const id of dissolving) {
    const dissolved = after.dissolved(id);
    if (!dissolved.ok) return dissolved;
    after = dissolved.value;
  }
  const outOf = (group: number | null): number | null | undefined =>
    group !== null && outermost.value.has(group) ? (table.group(group)?.parent ?? null) : undefined;
  return {
    ok: true,
    value: {
      action: "ungroup",
      groups: dissolving,
      before: table,
      after,
      placements: retagged(members.placements, outOf),
      pieces: retagged(members.pieces, outOf),
    },
  };
}

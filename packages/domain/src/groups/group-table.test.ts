import { GROUP_ID_MAX } from "@brr/schema/world";
import { describe, expect, it } from "vitest";
import {
  GroupTable,
  groupingChange,
  ungroupingChange,
  type GroupMembers,
  type GroupTagged,
} from "./group-table.ts";

function table(groups: unknown): GroupTable {
  const decoded = GroupTable.of(groups, "groups");
  if (!decoded.ok) throw new Error(`fixture table refused: ${JSON.stringify(decoded.issues)}`);
  return decoded.value;
}

function named(id: number): string {
  return `Group ${id + 1}`;
}

function loose(member: string, group: number | null = null): GroupTagged<string> {
  return { member, layer: 0, group };
}

function piece(member: number, group: number | null = null): GroupTagged<number> {
  return { member, layer: 0, group };
}

function members(
  placements: ReadonlyArray<GroupTagged<string>>,
  pieces: ReadonlyArray<GroupTagged<number>> = [],
): GroupMembers<string> {
  return { placements, pieces };
}

const STATION = { id: 2, name: "Station" };
const PLATFORM = { id: 5, name: "Platform", parent: 2 };
const LAMP = { id: 7, name: "Lamp", parent: 5 };
const YARD = { id: 9, name: "Yard" };

describe("GroupTable", () => {
  it("reads no group list as an empty table and finds each group's outermost group through any depth", () => {
    const nested = table([STATION, PLATFORM, LAMP, YARD]);

    expect(table(undefined)).toBe(GroupTable.empty);
    expect([2, 5, 7, 9, 4].map((id) => nested.outermost(id))).toEqual([2, 2, 2, 9, undefined]);
  });

  it("refuses a group list that nests a group inside itself", () => {
    const decoded = GroupTable.of(
      [
        { id: 1, name: "A", parent: 2 },
        { id: 2, name: "B", parent: 1 },
      ],
      "groups",
    );

    expect(decoded).toEqual({
      ok: false,
      issues: [{ path: "groups", message: "must not nest a group inside itself" }],
    });
  });

  it("makes a new outermost group with the next id and puts the given outermost groups inside it", () => {
    const groups = table([STATION, PLATFORM, YARD]);
    const created = groups.created([2, 9], named);

    expect(created.ok && created.value.id).toBe(10);
    expect(created.ok && created.value.table.groups).toEqual([
      { ...STATION, parent: 10 },
      PLATFORM,
      { ...YARD, parent: 10 },
      { id: 10, name: "Group 11" },
    ]);
    expect(groups.groups).toEqual([STATION, PLATFORM, YARD]);
  });

  it("takes the lowest free id once the highest id is used", () => {
    const groups = table([{ id: GROUP_ID_MAX, name: "Last" }]);
    const created = groups.created([], named);

    expect(created.ok && created.value.id).toBe(0);
  });

  it("refuses to nest a group that's inside another, or one it doesn't list", () => {
    const groups = table([STATION, PLATFORM]);

    expect([groups.created([5], named), groups.created([3], named)]).toEqual([
      { ok: false, issues: [{ path: "group 5", message: "is inside group 2, not outermost" }] },
      { ok: false, issues: [{ path: "group 3", message: "isn't in the group table" }] },
    ]);
  });

  it("dissolves a group, handing its inner groups to its own parent", () => {
    const groups = table([STATION, PLATFORM, LAMP, YARD]);
    const inner = groups.dissolved(5);
    const outer = groups.dissolved(2);

    expect(inner.ok && inner.value.groups).toEqual([STATION, { ...LAMP, parent: 2 }, YARD]);
    expect(outer.ok && outer.value.groups).toEqual([{ id: 5, name: "Platform" }, LAMP, YARD]);
    expect(groups.dissolved(4)).toEqual({
      ok: false,
      issues: [{ path: "group 4", message: "isn't in the group table" }],
    });
  });
});

describe("grouping and ungrouping", () => {
  it("groups loose parts, track and whole groups under one new group, retagging only the loose members", () => {
    const groups = table([STATION, PLATFORM, YARD]);
    const change = groupingChange(
      groups,
      members(
        [loose("signal box"), loose("bench", 5), loose("kiosk", 2), loose("tree")],
        [piece(3), piece(4, 9)],
      ),
      named,
    );

    expect(change.ok && change.value).toEqual({
      action: "group",
      groups: [10],
      before: groups,
      after: table([
        { ...STATION, parent: 10 },
        PLATFORM,
        { ...YARD, parent: 10 },
        { id: 10, name: "Group 11" },
      ]),
      placements: [
        { member: "signal box", layer: 0, from: null, to: 10 },
        { member: "tree", layer: 0, from: null, to: 10 },
      ],
      pieces: [{ member: 3, layer: 0, from: null, to: 10 }],
    });
  });

  it("refuses to group a lone part or a single group, or a member naming a group the table doesn't list", () => {
    const groups = table([STATION, PLATFORM]);
    const single = "holds one part or group, so there's nothing to group it with";

    expect([
      groupingChange(groups, members([loose("kiosk")]), named),
      groupingChange(groups, members([loose("kiosk", 2), loose("bench", 5)]), named),
      groupingChange(groups, members([loose("kiosk"), loose("bench", 4)]), named),
    ]).toEqual([
      { ok: false, issues: [{ path: "selection", message: single }] },
      { ok: false, issues: [{ path: "selection", message: single }] },
      { ok: false, issues: [{ path: "group 4", message: "isn't in the group table" }] },
    ]);
  });

  it("ungroups each outermost group one level, freeing its direct members and leaving inner groups whole", () => {
    const groups = table([STATION, PLATFORM, LAMP, YARD]);
    const change = ungroupingChange(
      groups,
      members([loose("kiosk", 2), loose("bench", 5), loose("lamp", 7), loose("crane", 9)]),
    );

    expect(change.ok && change.value).toEqual({
      action: "ungroup",
      groups: [2, 9],
      before: groups,
      after: table([{ id: 5, name: "Platform" }, LAMP]),
      placements: [
        { member: "kiosk", layer: 0, from: 2, to: null },
        { member: "crane", layer: 0, from: 9, to: null },
      ],
      pieces: [],
    });
    expect(ungroupingChange(groups, members([loose("tree")]))).toEqual({
      ok: false,
      issues: [{ path: "selection", message: "holds no group" }],
    });
  });

  it("gives back the table and tags it started from when a grouping is ungrouped", () => {
    const groups = table([STATION, PLATFORM]);
    const start = [loose("kiosk", 2), loose("bench", 5), loose("tree"), loose("clock")];
    const grouped = groupingChange(groups, members(start), named);
    if (!grouped.ok) throw new Error("the members weren't grouped");
    const retagged = new Map(grouped.value.placements.map(({ member, to }) => [member, to]));
    const after = start.map((tag) => ({ ...tag, group: retagged.get(tag.member) ?? tag.group }));
    const ungrouped = ungroupingChange(grouped.value.after, members(after));
    if (!ungrouped.ok) throw new Error("the group wasn't ungrouped");
    const restored = new Map(ungrouped.value.placements.map(({ member, to }) => [member, to]));

    expect(ungrouped.value.after.groups).toEqual(groups.groups);
    expect(
      after.map(({ member, group }) => (restored.has(member) ? restored.get(member) : group)),
    ).toEqual(start.map(({ group }) => group));
  });
});

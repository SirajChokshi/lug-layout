import { GROUP_ID_MAX } from "@brr/schema/world";
import { describe, expect, it } from "vitest";
import { SLOT_GROUPED, SLOT_LIVE, World, groupAt } from "./world.ts";

function groupOf(n: number): number | null {
  if (n % 3 === 0) return null;
  return n % 3 === 1 ? 0 : GROUP_ID_MAX - n;
}

describe("World.remove", () => {
  it("frees the slot for the next add in that chunk and makes the old handle stale", () => {
    const world = new World();
    const first = world.add(7, 1, 40, 60, 0, 1, 0, null);
    const second = world.add(8, 2, 80, 60, 0, 2, 0, null);
    world.remove(first);

    expect(first.live).toBe(false);
    expect(() => first.x).toThrow(/stale/u);
    expect(() => world.remove(first)).toThrow(/stale/u);

    const third = world.add(9, 3, 100, 20, 1, 3, 0, null);
    expect(third.slot).toBe(first.slot);
    expect(first.live).toBe(false);
    expect([third.refId, third.x, third.z, third.yPlates, third.rot]).toEqual([9, 100, 20, 1, 3]);
    expect([second.refId, second.x, second.rot]).toEqual([8, 80, 2]);
    expect(world.size).toBe(2);
  });

  it("leaves a removed slot in the chunk view without the live flag", () => {
    const world = new World();
    const kept = world.add(1, 0, 20, 20, 0, 0, 0, null);
    const removed = world.add(2, 0, 40, 20, 0, 0, 0, null);
    world.remove(removed);
    const [view] = world.chunks();

    expect(view?.count).toBe(2);
    expect(view?.liveCount).toBe(1);
    expect((view?.flags[kept.slot] ?? 0) & SLOT_LIVE).toBe(SLOT_LIVE);
    expect((view?.flags[removed.slot] ?? 0) & SLOT_LIVE).toBe(0);
  });

  it("refuses a handle from another world", () => {
    const world = new World();
    world.add(1, 0, 20, 20, 0, 0, 0, null);
    const foreign = new World().add(1, 0, 20, 20, 0, 0, 0, null);

    expect(() => world.remove(foreign)).toThrow(/another world/u);
  });
});

describe("World.add", () => {
  it("keeps every placement and handle in a chunk that grows, including slots freed before it grew", () => {
    const world = new World();
    world.add(1, 0, 20, 20, 0, 0, 0, null);
    const freed = world.add(2, 0, 40, 20, 0, 0, 0, null);
    world.remove(freed);
    const poses = Array.from(
      { length: 200 },
      (_, n): [number, number, number, number, number, number, number, number | null] => [
        n + 10,
        n % 7,
        20 * (n % 32),
        20 * (n >> 5),
        n,
        n % 4,
        (n * 331) % 65_536,
        groupOf(n),
      ],
    );
    const handles = poses.map(([refId, colorId, x, z, yPlates, rot, layer, group]) =>
      world.add(refId, colorId, x, z, yPlates, rot, layer, group),
    );
    const [removed] = handles.splice(4, 1);
    if (removed) world.remove(removed);
    poses.splice(4, 1);
    const [view] = world.chunks();

    expect(world.size).toBe(200);
    expect(view?.liveCount).toBe(200);
    expect(handles[0]?.slot).toBe(freed.slot);
    expect([freed.live, removed?.live]).toEqual([false, false]);
    expect(
      handles.map((handle) => [
        handle.refId,
        handle.colorId,
        handle.x,
        handle.z,
        handle.yPlates,
        handle.rot,
        handle.layer,
        handle.group,
      ]),
    ).toEqual(poses);
  });

  it("refuses a layer that isn't a 16-bit layer id or a group that isn't a 32-bit group id", () => {
    const world = new World();

    for (const layer of [-1, 65_536, 1.5]) {
      expect(() => world.add(1, 0, 20, 20, 0, 0, layer, null)).toThrow(/not a layer id/u);
    }
    for (const group of [-1, GROUP_ID_MAX + 1, 1.5]) {
      expect(() => world.add(1, 0, 20, 20, 0, 0, 0, group)).toThrow(/not a group id/u);
    }
    expect(world.size).toBe(0);
  });
});

describe("World.has", () => {
  it("finds a live placement only by its whole record, and not once it is removed", () => {
    const world = new World();
    const kept = world.add(7, 1, -640, 1280, 2, 3, 0);
    const removed = world.add(7, 1, 40, 60, 0, 0, 0);
    world.remove(removed);

    expect([
      world.has(7, 1, -640, 1280, 2, 3),
      world.has(8, 1, -640, 1280, 2, 3),
      world.has(7, 2, -640, 1280, 2, 3),
      world.has(7, 1, -620, 1280, 2, 3),
      world.has(7, 1, -640, 1280, 1, 3),
      world.has(7, 1, -640, 1280, 2, 0),
      world.has(7, 1, 40, 60, 0, 0),
      world.has(7, 1, 2 ** 40, 0, 0, 0),
    ]).toEqual([true, false, false, false, false, false, false, false]);
    expect(kept.live).toBe(true);
  });
});

describe("World.regroup", () => {
  it("retags a placement in place, keeping its handle, pose and live flag, and can take the tag off again", () => {
    const world = new World();
    const handle = world.add(5, 1, 60, 20, 2, 3, 4, null);
    const neighbour = world.add(6, 1, 80, 20, 0, 0, 0, 9);

    world.regroup(handle, 0);
    const [grouped] = world.chunks();
    const tagged = {
      group: handle.group,
      viewed: grouped ? groupAt(grouped, handle.slot) : undefined,
      flags: grouped?.flags[handle.slot],
    };
    world.regroup(handle, null);
    const [ungrouped] = world.chunks();

    expect(tagged).toEqual({ group: 0, viewed: 0, flags: SLOT_LIVE | SLOT_GROUPED });
    expect({
      live: handle.live,
      pose: [handle.refId, handle.x, handle.z, handle.yPlates, handle.rot, handle.layer],
      group: handle.group,
      viewed: ungrouped ? groupAt(ungrouped, handle.slot) : undefined,
      neighbour: neighbour.group,
    }).toEqual({ live: true, pose: [5, 60, 20, 2, 3, 4], group: null, viewed: null, neighbour: 9 });
  });

  it("refuses a stale handle or a group id out of range, and leaves the tag as it was", () => {
    const world = new World();
    const kept = world.add(1, 0, 20, 20, 0, 0, 0, 3);
    const removed = world.add(2, 0, 40, 20, 0, 0, 0, null);
    world.remove(removed);

    expect(() => world.regroup(removed, 1)).toThrow(/stale/u);
    expect(() => world.regroup(kept, GROUP_ID_MAX + 1)).toThrow(/not a group id/u);
    expect(kept.group).toBe(3);
  });
});

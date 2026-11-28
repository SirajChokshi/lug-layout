import { describe, expect, it } from "vitest";
import { SLOT_LIVE, World } from "./world.ts";

describe("World.remove", () => {
  it("frees the slot for the next add in that chunk and makes the old handle stale", () => {
    const world = new World();
    const first = world.add(7, 1, 40, 60, 0, 1);
    const second = world.add(8, 2, 80, 60, 0, 2);
    world.remove(first);

    expect(first.live).toBe(false);
    expect(() => first.x).toThrow(/stale/u);
    expect(() => world.remove(first)).toThrow(/stale/u);

    const third = world.add(9, 3, 100, 20, 1, 3);
    expect(third.slot).toBe(first.slot);
    expect(first.live).toBe(false);
    expect([third.refId, third.x, third.z, third.yPlates, third.rot]).toEqual([9, 100, 20, 1, 3]);
    expect([second.refId, second.x, second.rot]).toEqual([8, 80, 2]);
    expect(world.size).toBe(2);
  });

  it("leaves a removed slot in the chunk view without the live flag", () => {
    const world = new World();
    const kept = world.add(1, 0, 20, 20, 0, 0);
    const removed = world.add(2, 0, 40, 20, 0, 0);
    world.remove(removed);
    const [view] = world.chunks();

    expect(view?.count).toBe(2);
    expect(view?.liveCount).toBe(1);
    expect((view?.flags[kept.slot] ?? 0) & SLOT_LIVE).toBe(SLOT_LIVE);
    expect((view?.flags[removed.slot] ?? 0) & SLOT_LIVE).toBe(0);
  });

  it("refuses a handle from another world", () => {
    const world = new World();
    world.add(1, 0, 20, 20, 0, 0);
    const foreign = new World().add(1, 0, 20, 20, 0, 0);

    expect(() => world.remove(foreign)).toThrow(/another world/u);
  });
});

describe("World.add", () => {
  it("keeps every placement and handle in a chunk that grows, including slots freed before it grew", () => {
    const world = new World();
    world.add(1, 0, 20, 20, 0, 0);
    const freed = world.add(2, 0, 40, 20, 0, 0);
    world.remove(freed);
    const poses = Array.from({ length: 200 }, (_, n) => [
      n + 10,
      n % 7,
      20 * (n % 32),
      20 * (n >> 5),
      n,
      n % 4,
    ]);
    const handles = poses.map(([refId = 0, colorId = 0, x = 0, z = 0, yPlates = 0, rot = 0]) =>
      world.add(refId, colorId, x, z, yPlates, rot),
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
      ]),
    ).toEqual(poses);
  });
});

describe("World.has", () => {
  it("finds a live placement only by its whole record, and not once it is removed", () => {
    const world = new World();
    const kept = world.add(7, 1, -640, 1280, 2, 3);
    const removed = world.add(7, 1, 40, 60, 0, 0);
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

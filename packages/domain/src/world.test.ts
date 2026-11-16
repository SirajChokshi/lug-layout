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

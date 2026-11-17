import { describe, expect, it } from "vitest";
import { EMPTY_HOTBAR, HOTBAR_SLOTS, hotbarWith, type Hotbar } from "./hotbar.ts";

function picks(ids: ReadonlyArray<string>, from: Hotbar = EMPTY_HOTBAR): Hotbar {
  return ids.reduce(hotbarWith, from);
}

const full = Array.from({ length: HOTBAR_SLOTS }, (_, slot) => `part-${slot + 1}`);

describe("hotbar", () => {
  it("keeps a part in its slot when it is picked again", () => {
    expect(picks(["a", "b", "c", "a"]).slots).toEqual(["a", "b", "c"]);
  });

  it("replaces the least recently used slot once every slot is taken", () => {
    const hotbar = picks([...full, "part-1", "new"]);
    expect(hotbar.slots).toHaveLength(HOTBAR_SLOTS);
    expect(hotbar.slots[0]).toBe("part-1");
    expect(hotbar.slots[1]).toBe("new");
  });
});

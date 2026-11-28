import { describe, expect, it } from "vitest";
import {
  EMPTY_HOTBAR,
  PINNED_SLOTS,
  RECENT_SLOTS,
  canPin,
  hotbarWith,
  hotbarWithPinToggled,
  type Hotbar,
} from "./hotbar.ts";

function picks(ids: ReadonlyArray<string>, from: Hotbar = EMPTY_HOTBAR): Hotbar {
  return ids.reduce(hotbarWith, from);
}

function items(hotbar: Hotbar): ReadonlyArray<string> {
  return hotbar.slots.map((slot) => (slot.pinned ? `${slot.item} (pinned)` : slot.item));
}

describe("hotbar", () => {
  it("keeps a part in its slot when it is picked again", () => {
    expect(items(picks(["a", "b", "c", "a"]))).toEqual(["a", "b", "c"]);
  });

  it("keeps the last four parts used, a new part taking the slot of the least recently used", () => {
    expect(RECENT_SLOTS).toBe(4);
    expect(items(picks(["a", "b", "c", "d", "a", "e", "f"]))).toEqual(["a", "e", "f", "d"]);
  });

  it("keeps pinned parts in their slots however many parts are tried after them, beside the last four used", () => {
    const pinned = hotbarWithPinToggled(picks(["track", "plate", "tree"]), 1);
    const tried = picks(["a", "b", "c", "d", "e"], pinned);

    expect(items(tried)).toEqual(["c", "plate (pinned)", "d", "e", "b"]);
  });

  it("pins at most five parts, so the last four used always fit in the nine digit slots", () => {
    const five = Array.from({ length: PINNED_SLOTS }, (_, slot) => slot).reduce(
      (hotbar, slot) => hotbarWithPinToggled(picks([`pin-${slot}`], hotbar), slot),
      EMPTY_HOTBAR,
    );
    const full = picks(["a", "b", "c", "d", "e"], five);
    const refused = hotbarWithPinToggled(full, PINNED_SLOTS);

    expect({ canPin: canPin(full), refused: refused === full, slots: full.slots.length }).toEqual({
      canPin: false,
      refused: true,
      slots: PINNED_SLOTS + RECENT_SLOTS,
    });
  });

  it("keeps an unpinned part as the most recently used, letting the least recent of the other four go", () => {
    const pinned = picks(["a", "b", "c", "d"], hotbarWithPinToggled(picks(["staple"]), 0));
    const unpinned = hotbarWithPinToggled(pinned, 0);

    expect({ pinned: items(pinned), unpinned: items(unpinned) }).toEqual({
      pinned: ["staple (pinned)", "a", "b", "c", "d"],
      unpinned: ["staple", "b", "c", "d"],
    });
  });
});

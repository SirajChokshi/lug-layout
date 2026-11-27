import { describe, expect, it } from "vitest";
import { SceneBounds } from "./scene-bounds.ts";

const FAR_LDU = 1_000_000;
const WEST = { minX: -5_000, maxX: -4_000, minZ: 0, maxZ: 640 };
const MIDDLE = { minX: 0, maxX: 640, minZ: 1_280, maxZ: 1_920 };
const NORTH_EAST = { minX: 9_000, maxX: 9_640, minZ: 7_000, maxZ: 7_640 };

function reachesFromEverySide(bounds: SceneBounds): number[] {
  return [
    bounds.reachFrom(-FAR_LDU, 0, 0),
    bounds.reachFrom(FAR_LDU, 0, 0),
    bounds.reachFrom(0, 0, -FAR_LDU),
    bounds.reachFrom(0, 0, FAR_LDU),
  ];
}

describe("SceneBounds", () => {
  it("reaches from the eye to the extent's farthest corner, counting the eye's height", () => {
    const bounds = new SceneBounds();
    bounds.extend(MIDDLE);

    expect(bounds.reachFrom(320, 1_000, 1_600)).toBe(Math.hypot(320, 320, 1_000));
  });

  it("after an invalidation, refreshes to the live extents alone on every side", () => {
    const bounds = new SceneBounds();
    for (const extent of [WEST, MIDDLE, NORTH_EAST]) bounds.extend(extent);
    bounds.invalidate();
    bounds.refresh([MIDDLE]);

    const middleOnly = new SceneBounds();
    middleOnly.extend(MIDDLE);
    expect(reachesFromEverySide(bounds)).toEqual(reachesFromEverySide(middleOnly));
  });
});

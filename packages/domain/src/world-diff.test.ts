import type { PlacementRecordV1, TrackRecordV1 } from "@brr/schema/world";
import { describe, expect, it } from "vitest";
import { diffWorlds, type WorldRecords } from "./world-diff.ts";

const CUSTOM_MODEL = `import:${"4e".repeat(32)}`;
const BASEPLATE = "ldraw:3811";
const STRAIGHT = "ldraw:53401";

function placement(ref: string, color: number, x: number, z: number, rot = 0): PlacementRecordV1 {
  return { ref, color, x, z, yPlates: 0, rot };
}

function straight(index: number, heading: number, xStuds: number, zStuds: number): TrackRecordV1 {
  const position = ["0", "0", "0", "0", "0", "0", "0", "0"];
  position[0] = String(xStuds);
  position[4] = String(zStuds);
  return { index, ref: STRAIGHT, heading, position, yPlates: 0 };
}

function reversed(records: WorldRecords): WorldRecords {
  return { placements: records.placements.toReversed(), track: records.track.toReversed() };
}

describe("world diff", () => {
  it("finds no change when only the listing order and track numbering differ", () => {
    const before = {
      placements: [placement(CUSTOM_MODEL, 0, 0, 0), placement(BASEPLATE, 2, 640, 0)],
      track: [straight(0, 0, 0, 0), straight(1, 0, 16, 0)],
    };
    const after = {
      placements: before.placements.toReversed(),
      track: [straight(0, 0, 16, 0), straight(1, 0, 0, 0)],
    };

    expect(diffWorlds(before, after)).toEqual({
      placements: { added: [], removed: [], moved: [] },
      track: { added: [], removed: [], moved: [] },
    });
  });

  it("sorts a user's model, baseplates and track into added, removed and moved", () => {
    const before = {
      placements: [
        placement(CUSTOM_MODEL, 0, 0, 0),
        placement(BASEPLATE, 2, 640, 0),
        placement(BASEPLATE, 2, 1280, 0),
      ],
      track: [straight(0, 0, 0, 0), straight(1, 0, 16, 0)],
    };
    const after = {
      placements: [
        placement(CUSTOM_MODEL, 0, 200, 400, 1),
        placement(BASEPLATE, 2, 640, 0),
        placement(BASEPLATE, 1, 1920, 0),
      ],
      track: [straight(0, 4, 0, 16), straight(1, 0, 0, 0), straight(2, 0, 64, 0)],
    };

    expect(diffWorlds(before, after)).toEqual({
      placements: {
        added: [placement(BASEPLATE, 1, 1920, 0)],
        removed: [placement(BASEPLATE, 2, 1280, 0)],
        moved: [
          { from: placement(CUSTOM_MODEL, 0, 0, 0), to: placement(CUSTOM_MODEL, 0, 200, 400, 1) },
        ],
      },
      track: {
        added: [straight(2, 0, 64, 0)],
        removed: [],
        moved: [{ from: straight(1, 0, 16, 0), to: straight(0, 4, 0, 16) }],
      },
    });
  });

  it("pairs a moved item with the nearest place one like it left, whatever order the records come in", () => {
    const before = {
      placements: [placement(BASEPLATE, 2, 0, 0), placement(BASEPLATE, 2, 6400, 0)],
      track: [],
    };
    const after = { placements: [placement(BASEPLATE, 2, 640, 0)], track: [] };
    const expected = {
      placements: {
        added: [],
        removed: [placement(BASEPLATE, 2, 6400, 0)],
        moved: [{ from: placement(BASEPLATE, 2, 0, 0), to: placement(BASEPLATE, 2, 640, 0) }],
      },
      track: { added: [], removed: [], moved: [] },
    };

    expect(diffWorlds(before, after)).toEqual(expected);
    expect(diffWorlds(reversed(before), reversed(after))).toEqual(expected);
  });
});

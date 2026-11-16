import { describe, expect, it } from "vitest";
import { parsePlanArchiveManifest } from "./plan-archive.ts";

const VALID = {
  format: "brrplan",
  version: 1,
  bundleVersion: "abc",
  plan: {
    name: "Exit table",
    originChunkX: 0,
    originChunkZ: 0,
    maxOverhangMm: 0,
    footprint: {
      roomWidthMm: 5600,
      roomDepthMm: 3000,
      tables: [
        {
          id: "t",
          name: "Table 1",
          rect: { x: 1536, z: 256, width: 2400, depth: 1200 },
          heightMm: 750,
        },
      ],
      obstacles: [],
    },
  },
  settings: { profile: "mils", maxReachMm: 700 },
  placements: [{ ref: "ldraw:3811", x: 2560, z: 640, rot: 1 }],
};

describe("parsePlanArchiveManifest", () => {
  it("accepts a version 1 plan and refuses other formats, versions and broken placements", () => {
    expect(typeof parsePlanArchiveManifest(VALID)).toBe("object");
    expect(parsePlanArchiveManifest({ ...VALID, format: "zip" })).toBe(
      "manifest.json is not a Brick Railroad plan",
    );
    expect(parsePlanArchiveManifest({ ...VALID, version: 2 })).toBe(
      "plan archive version 2 is not version 1",
    );
    expect(
      parsePlanArchiveManifest({
        ...VALID,
        placements: [{ ref: "ldraw:3811", x: 1.5, z: 0, rot: 0 }],
      }),
    ).toBe("manifest.json has a malformed placement");
  });
});

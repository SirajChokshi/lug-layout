import { describe, expect, it } from "vitest";
import { checkBuildable, type BuildableCatalog, type BuildablePlacement } from "./buildable.ts";
import { plateSpec, type ModuleStandards } from "./item-spec.ts";
import type { PlanRegion } from "./plan-region.ts";
import { checkPlan } from "./plan-rules.ts";
import { planSvg } from "./plan-svg.ts";

const STANDARDS: ModuleStandards = { groundParts: ["ldraw:3811"], profiles: [] };
const PLATE = { minX: -320, minZ: -320, maxX: 320, maxZ: 320 };
const BASEPLATE = plateSpec("ldraw:3811", "3811 baseplate", "ldraw:3811", 2, PLATE, [], STANDARDS);
const CATALOG: BuildableCatalog = {
  specs: new Map([[BASEPLATE.ref, BASEPLATE]]),
  standards: STANDARDS,
  crosswalk: {
    parts: new Map([["ldraw:3811", { rebrickable: "3811", bricklink: "3811" }]]),
    colors: new Map([[2, { rebrickable: 2, bricklink: 6 }]]),
  },
};
const REGION: PlanRegion = {
  id: "plan",
  name: "Exit table",
  originChunkX: 0,
  originChunkZ: 0,
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
  maxOverhangMm: 0,
};

describe("planSvg", () => {
  it("draws the room at a standard scale with the table dimensioned and each module numbered and listed", () => {
    const placement: BuildablePlacement = {
      key: { chunkKey: 0, slot: 0 },
      ref: "ldraw:3811",
      label: "3811 baseplate at 4160, 960",
      box: { minX: 3840, minZ: 640, maxX: 4480, maxZ: 1280 },
      x: 4160,
      z: 960,
      rot: 0,
    };
    const check = checkPlan(REGION, [placement]);
    const report = checkBuildable(REGION, check, [placement], CATALOG, {
      profile: "free",
      maxReachMm: 700,
    });
    const svg = planSvg({
      region: REGION,
      check,
      report,
      placements: [placement],
      catalog: CATALOG,
      colorNames: { 2: "Green" },
      disclaimer: "LEGO® is a trademark",
    });
    expect(svg).toContain('width="420mm" height="594mm"');
    expect(svg).toContain("drawn at 1:15");
    expect(svg).toContain('<rect x="1536" y="256" width="2400" height="1200"');
    expect(svg).toContain(">2400 mm<");
    expect(svg).toContain(">1200 mm<");
    expect(svg).toContain(">M1<");
    expect(svg).toContain("M1 · 3811 baseplate at 4160, 960");
    expect(svg).toContain("1 × 3811 Green (BrickLink 3811)");
    expect(svg).toContain("Buildable as planned");
  });
});

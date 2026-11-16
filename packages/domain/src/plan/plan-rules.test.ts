import { describe, expect, it } from "vitest";
import type { LduRect, PlanRegion, PlanTable } from "./plan-region.ts";
import { checkPlan, type PlanIssue, type PlanPlacement } from "./plan-rules.ts";

const CHUNK = 640;
const BASEPLATE_LDU = 640;

function table(id: string, x: number, z: number, width: number, depth: number): PlanTable {
  return { id, name: id, rect: { x, z, width, depth }, heightMm: 750 };
}

function region(tables: PlanTable[], overrides: Partial<PlanRegion> = {}): PlanRegion {
  return {
    id: "plan",
    name: "Test room",
    originChunkX: 3,
    originChunkZ: -2,
    footprint: { roomWidthMm: 4000, roomDepthMm: 3000, tables, obstacles: [] },
    maxOverhangMm: 0,
    ...overrides,
  };
}

function boxAt(
  plan: PlanRegion,
  slot: number,
  studX: number,
  studZ: number,
  widthLdu = BASEPLATE_LDU,
  depthLdu = BASEPLATE_LDU,
): PlanPlacement {
  const minX = plan.originChunkX * CHUNK + studX * 20;
  const minZ = plan.originChunkZ * CHUNK + studZ * 20;
  const box: LduRect = { minX, minZ, maxX: minX + widthLdu, maxZ: minZ + depthLdu };
  return { key: { chunkKey: 7, slot }, ref: "ldraw:3811", label: `box ${slot}`, box };
}

function offTable(issues: ReadonlyArray<PlanIssue>): unknown[] {
  return issues
    .filter((i) => i.rule === "fit")
    .map((i) => [i.placements.map((k) => k.slot), i.overhangMm, i.nearestTableMm, i.offTableMm2]);
}

describe("checkPlan on a 2400 × 1200 mm table at 1000, 504 mm in the room", () => {
  const tables = [table("main", 1000, 504, 2400, 1200)];
  const plan = region(tables);
  const left = 1000 / 8;
  const near = 504 / 8;
  const right = left + 300;

  it("reports the table top as 300 × 150 studs", () => {
    const [top] = checkPlan(plan, []).tables;
    expect([top?.studs.studsWide, top?.studs.studsDeep]).toEqual([300, 150]);
  });

  it("accepts nine 32-stud baseplates across and measures the tenth 160 mm past the edge", () => {
    const row = Array.from({ length: 10 }, (_, i) => boxAt(plan, i, left + i * 32, near));
    const check = checkPlan(plan, row);
    expect(check.inside).toHaveLength(10);
    expect(offTable(check.issues)).toEqual([[[9], 160, 0, 160 * 256]]);
  });

  it("measures a long plate along its length, not across its narrow side", () => {
    const lengthwise = boxAt(plan, 0, right - 18, near + 10, 960, 100);
    expect(offTable(checkPlan(plan, [lengthwise]).issues)).toEqual([[[0], 240, 0, 240 * 40]]);
  });

  it("compares the full overhang with the limit and counts area against the bare table", () => {
    const hanging = boxAt(plan, 0, right - 12, near);
    const limited = region(tables, { maxOverhangMm: 100 });
    expect(offTable(checkPlan(limited, [hanging]).issues)).toEqual([[[0], 160, 0, 160 * 256]]);
    expect(checkPlan(region(tables, { maxOverhangMm: 160 }), [hanging]).issues).toEqual([]);
  });

  it("reports how far a plate entirely off the tables reaches and how far away it is", () => {
    const away = boxAt(plan, 0, left - 84 - 32, near + 20);
    expect(offTable(checkPlan(plan, [away]).issues)).toEqual([[[0], 928, 672, 256 * 256]]);
  });

  it("measures a corner overhang by the worse of its two directions", () => {
    const corner = boxAt(plan, 0, right - 22, near - 3);
    expect(offTable(checkPlan(plan, [corner]).issues)).toEqual([[[0], 80, 0, 80 * 256 + 24 * 176]]);
  });

  it("flags a placement that crosses the room edge and ignores one outside the room", () => {
    const crossing = boxAt(plan, 0, -16, 10);
    const outside = boxAt(plan, 1, -200, 0);
    const check = checkPlan(plan, [crossing, outside]);
    expect(check.inside.map((k) => k.slot)).toEqual([0]);
    expect(check.issues.map((i) => i.rule)).toEqual(["crossesRegion", "fit"]);
  });
});

describe("checkPlan with two tables", () => {
  it("supports a baseplate across a seam off the stud grid", () => {
    const plan = region([table("left", 0, 0, 1203, 800), table("right", 1203, 0, 1203, 800)]);
    expect(checkPlan(plan, [boxAt(plan, 0, 140, 10)]).issues).toEqual([]);
  });

  it("measures a baseplate over a 10 mm gap as reaching 5 mm past either table", () => {
    const plan = region([table("left", 0, 0, 1200, 800), table("right", 1210, 0, 1200, 800)]);
    expect(offTable(checkPlan(plan, [boxAt(plan, 0, 140, 10)]).issues)).toEqual([
      [[0], 5, 0, 10 * 256],
    ]);
  });
});

describe("checkPlan footprint problems", () => {
  it("rejects overlapping tables, tables outside the room, unequal heights and tables on obstacles", () => {
    const plan = region([
      table("a", 0, 0, 1000, 600),
      table("b", 900, 0, 1000, 600),
      { ...table("c", 3500, 2500, 1000, 600), heightMm: 900 },
    ]);
    const withObstacle: PlanRegion = {
      ...plan,
      footprint: {
        ...plan.footprint,
        obstacles: [
          { id: "pillar", name: "pillar", rect: { x: 100, z: 100, width: 200, depth: 200 } },
        ],
      },
    };
    expect(checkPlan(withObstacle, []).issues.map((i) => i.message)).toEqual([
      'Tables "a" and "b" overlap.',
      'Table "a" overlaps obstacle "pillar".',
      'Table "c" is not inside the room.',
      'Table "c" is 900 mm high, but "a" sets the layout at 750 mm; layouts are flat.',
    ]);
  });
});

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

const MODEL_AABBS: Record<string, { readonly minZ: number; readonly maxZ: number }> = {
  "10185-1": { minZ: -340, maxZ: 330.0482535107422 },
  "10133-1": { minZ: -88.84993553161621, maxZ: 247.11567640304565 },
  "7936-1": { minZ: -489, maxZ: 489 },
  "10190-1": { minZ: -320, maxZ: 345.97850036621094 },
};

function modelBox(name: string, x: number, z: number): LduRect {
  const aabb = MODEL_AABBS[name];
  if (!aabb) throw new Error(name);
  return { minX: x - 320, maxX: x + 320, minZ: z + aabb.minZ, maxZ: z + aabb.maxZ };
}

function placed(box: LduRect): PlanPlacement {
  return { key: { chunkKey: 1, slot: 0 }, ref: "omr:10185-1", label: "10185-1", box };
}

function at(depth: number, maxOverhangMm: number): PlanRegion {
  return region([table("t", 0, 0, 2400, depth)], {
    originChunkX: 0,
    originChunkZ: 0,
    maxOverhangMm,
  });
}

describe("checkPlan with float model boxes", () => {
  it("matches the exact back-edge overhang for real model boxes across positions and depths", () => {
    let checked = 0;
    for (const name of Object.keys(MODEL_AABBS)) {
      for (let originChunkZ = -8; originChunkZ <= -1; originChunkZ++) {
        for (let z = -1500; z <= 1500; z += 60) {
          const box = modelBox(name, 4000, z);
          for (let depth = 100; depth <= 1500; depth += 37) {
            const edge = originChunkZ * CHUNK + depth * 2.5;
            if (!(box.minZ >= originChunkZ * CHUNK && box.minZ < edge && edge < box.maxZ)) continue;
            const trueMm = (box.maxZ - edge) * 0.4;
            const plan: PlanRegion = {
              ...region([table("t", 1000, 0, 2400, depth)], { originChunkX: 0, originChunkZ }),
              footprint: {
                roomWidthMm: 5000,
                roomDepthMm: 3600,
                tables: [table("t", 1000, 0, 2400, depth)],
                obstacles: [],
              },
            };
            const fit = checkPlan(plan, [placed(box)]).issues.find((i) => i.rule === "fit");
            expect(fit?.overhangMm).toBeCloseTo(trueMm, 9);
            expect(fit?.message).toContain(`reaches ${Math.ceil(trueMm * 10 - 1e-9) / 10} mm`);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it("flags real geometry 0.048 LDU past a table edge and shows it above the limit", () => {
    const box = { minX: 2000, maxX: 2640, minZ: 1660, maxZ: 2000 + 330.0482535107422 };
    const [limited] = checkPlan(at(832, 100), [placed(box)]).issues;
    expect(limited?.message).toContain(
      "reaches 100.1 mm past the nearest table edge along x or z (limit 100 mm)",
    );
    const [bare] = checkPlan(at(932, 0), [placed(box)]).issues;
    expect(bare?.message).toContain(
      "reaches 0.1 mm past the nearest table edge along x or z (limit 0 mm), with 5 mm²",
    );
    expect(checkPlan(at(932, 0), [placed({ ...box, maxZ: 2330 })]).issues).toEqual([]);
  });

  it("flags 0.048 LDU across the room edge or into an obstacle and accepts flush edges", () => {
    const plan: PlanRegion = {
      ...region([table("t", 0, 0, 2400, 1200)], { originChunkX: 0, originChunkZ: 0 }),
      footprint: {
        roomWidthMm: 4000,
        roomDepthMm: 3000,
        tables: [table("t", 0, 0, 2400, 1200)],
        obstacles: [{ id: "o", name: "pillar", rect: { x: 0, z: 1200, width: 400, depth: 400 } }],
      },
    };
    const flush = { minX: 0, maxX: 640, minZ: 2360, maxZ: 3000 };
    expect(checkPlan(plan, [placed(flush)]).issues).toEqual([]);
    const past = { ...flush, minX: -0.048, maxZ: 3000.048 };
    expect(checkPlan(plan, [placed(past)]).issues.map((i) => i.rule)).toEqual([
      "crossesRegion",
      "fit",
      "fit",
    ]);
  });
});

describe("checkPlan messages for plates entirely off the tables", () => {
  const plan = region([table("a", 0, 0, 1000, 800)], { originChunkX: 0, originChunkZ: 0 });

  it("says a plate touching a table edge is entirely off and touching", () => {
    const touching = { minX: 2500, minZ: 100, maxX: 3140, maxZ: 740 };
    const [fit] = checkPlan(plan, [placed(touching)]).issues;
    expect([fit?.entirelyOffTables, fit?.nearestTableMm, fit?.overhangMm]).toEqual([true, 0, 256]);
    expect(fit?.message).toContain("entirely off the tables, touching the edge of the nearest one");
  });

  it("labels the distance off a corner as the larger axis gap", () => {
    const diagonal = { minX: 2600, minZ: 2100, maxX: 3240, maxZ: 2740 };
    const [fit] = checkPlan(plan, [placed(diagonal)]).issues;
    expect(fit?.nearestTableMm).toBe(40);
    expect(fit?.message).toContain(
      "40 mm from the nearest one along x or z (the larger of the two axis gaps)",
    );
  });
});

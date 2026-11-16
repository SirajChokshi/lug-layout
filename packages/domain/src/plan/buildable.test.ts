import type { Rot90 } from "@brr/math";
import { describe, expect, it } from "vitest";
import type { Crosswalk } from "../bom/catalog-ids.ts";
import { checkBuildable, type BuildableCatalog, type BuildablePlacement } from "./buildable.ts";
import {
  modelSpec,
  plateSpec,
  roadwaysOf,
  type ItemSpec,
  type ModuleProfileId,
  type ModuleStandards,
} from "./item-spec.ts";
import type { LduRect, PlanRegion, PlanTable } from "./plan-region.ts";
import { checkPlan } from "./plan-rules.ts";
import { placedRect } from "./placed-geometry.ts";

const STANDARDS: ModuleStandards = {
  groundParts: ["ldraw:3811", "ldraw:3857"],
  profiles: [
    {
      id: "lego-modular",
      moduleStuds: 32,
      joinParts: ["ldraw:3700"],
      joinLevelPlates: 0,
      recipe: null,
      source: "S16",
    },
    {
      id: "mils",
      moduleStuds: 32,
      joinParts: ["ldraw:3701"],
      joinLevelPlates: 0,
      recipe: {
        groundPart: "ldraw:3811",
        edgeJoinCells: [
          [2, 5],
          [26, 29],
        ],
        surfacePlates: 4,
        substructure: [
          { part: "ldraw:3003", ldrawColor: null, quantity: 4 },
          { part: "ldraw:3701", ldrawColor: null, quantity: 8 },
          { part: "ldraw:3001", ldrawColor: null, quantity: 8 },
          { part: "ldraw:91405", ldrawColor: null, quantity: 4 },
        ],
      },
      source: "S1, S5",
    },
  ],
};

type Box = readonly [number, number, number, number, number, number];

const BASEPLATE: Box = [-320, -4, -320, 320, 0, 320];

function technicOnNorthEdge(alongMinX: number): Box {
  return [alongMinX, 0, -320, alongMinX + 40, 24, -300];
}

function technicOnSouthEdge(alongMinX: number): Box {
  return [alongMinX, 0, 300, alongMinX + 40, 24, 320];
}

const CELL_9 = -320 + 9 * 20;
const CELL_21 = -320 + 21 * 20;

function building(ref: string, joins: ReadonlyArray<Box>): ItemSpec {
  const boxes = [BASEPLATE, ...joins];
  return modelSpec(
    ref,
    ref,
    {
      count: boxes.length,
      partIds: ["ldraw:3811", "ldraw:3700", "ldraw:3001"],
      partIndex: boxes.map((_, i) => (i === 0 ? 0 : 1)),
      colors: boxes.map(() => 15),
      boxes: Float32Array.from(boxes.flat()),
    },
    STANDARDS,
  );
}

const WALL_DECORATION: Box = [116 - 12, 200, -320, 116 + 12, 240, -300];

const NORTH_SOUTH_JOINS = building("omr:north-south", [
  WALL_DECORATION,
  technicOnNorthEdge(CELL_9),
  technicOnNorthEdge(CELL_21),
  technicOnSouthEdge(CELL_9),
  technicOnSouthEdge(CELL_21),
]);

const PLATE: LduRect = { minX: -320, minZ: -320, maxX: 320, maxZ: 320 };

const BASEPLATE_ITEM = plateSpec("ldraw:3811", "3811", "ldraw:3811", 2, PLATE, [], STANDARDS);

function roadStuds(): Array<readonly [number, number]> {
  const studs: Array<readonly [number, number]> = [];
  for (let row = 0; row < 32; row++) {
    for (let column = 0; column < 32; column++) {
      if (column >= 6 && column < 26) continue;
      studs.push([-310 + column * 20, -310 + row * 20]);
    }
  }
  return studs;
}

const ROAD = plateSpec(
  "ldraw:44336p04",
  "44336p04",
  "ldraw:44336p04",
  72,
  PLATE,
  roadwaysOf(PLATE, roadStuds()),
  STANDARDS,
);

const UNLISTED_ROAD = plateSpec(
  "ldraw:44336p01",
  "44336p01",
  "ldraw:44336p01",
  2,
  PLATE,
  roadwaysOf(PLATE, roadStuds()),
  STANDARDS,
);

const MAPPED_PARTS = ["3811", "3700", "3001", "3003", "3701", "91405"];

const CROSSWALK: Crosswalk = {
  parts: new Map([
    ...MAPPED_PARTS.map((id) => [`ldraw:${id}`, { rebrickable: id, bricklink: id }] as const),
    ["ldraw:44336p04", { rebrickable: "44336pr0004", bricklink: "44336pb04" }],
    ["ldraw:44336p01", { rebrickable: "44336pr0001", bricklink: null }],
    [
      "ldraw:2495c01",
      {
        rebrickable: null,
        bricklink: null,
        components: [
          { part: "ldraw:2495", color: 16 },
          { part: "ldraw:2496", color: 0 },
        ],
      },
    ],
    ["ldraw:2495", { rebrickable: "2495", bricklink: "2495" }],
    ["ldraw:2496", { rebrickable: "2496", bricklink: "2496" }],
  ]),
  colors: new Map([
    [2, { rebrickable: 2, bricklink: 6 }],
    [15, { rebrickable: 15, bricklink: 1 }],
    [0, { rebrickable: 0, bricklink: 11 }],
    [72, { rebrickable: 72, bricklink: 86 }],
  ]),
};

const CATALOG: BuildableCatalog = {
  specs: new Map(
    [NORTH_SOUTH_JOINS, BASEPLATE_ITEM, ROAD, UNLISTED_ROAD].map(
      (spec) => [spec.ref, spec] as const,
    ),
  ),
  standards: STANDARDS,
  crosswalk: CROSSWALK,
};

function table(id: string, x: number, z: number, width: number, depth: number): PlanTable {
  return { id, name: id, rect: { x, z, width, depth }, heightMm: 750 };
}

function region(tables: PlanTable[], roomWidthMm = 6000, roomDepthMm = 4000): PlanRegion {
  return {
    id: "plan",
    name: "Room",
    originChunkX: 0,
    originChunkZ: 0,
    footprint: { roomWidthMm, roomDepthMm, tables, obstacles: [] },
    maxOverhangMm: 0,
  };
}

const MODULE_LDU = 640;
const MODULE_MM = 256;

function at(
  index: number,
  spec: ItemSpec,
  originX: number,
  originZ: number,
  rot: Rot90 = 0,
): BuildablePlacement {
  const x = originX + 320;
  const z = originZ + 320;
  const footprint = placedRect(PLATE, x, z, rot);
  return {
    key: { chunkKey: 0, slot: index },
    ref: spec.ref,
    label: `${spec.label}#${index}`,
    box: footprint,
    x,
    z,
    rot,
  };
}

function report(
  plan: PlanRegion,
  placements: ReadonlyArray<BuildablePlacement>,
  profile: ModuleProfileId = "free",
  maxReachMm = 700,
) {
  const check = checkPlan(plan, placements);
  return checkBuildable(plan, check, placements, CATALOG, { profile, maxReachMm }, null);
}

function rules(
  placements: ReadonlyArray<BuildablePlacement>,
  plan: PlanRegion,
  profile: ModuleProfileId,
) {
  return report(plan, placements, profile).issues.map((i) => [
    i.rule,
    i.placements.map((key) => key.slot),
  ]);
}

const OPEN_TABLE = region([table("t", 1024, 1024, 4 * MODULE_MM, 2 * MODULE_MM)]);
const T_X = (1024 / MODULE_MM) * MODULE_LDU;
const T_Z = (1024 / MODULE_MM) * MODULE_LDU;

describe("module joins under the lego-modular profile", () => {
  it("reads first-course join bricks on whole cells from the model, not wall decoration", () => {
    expect(NORTH_SOUTH_JOINS.module).toEqual(PLATE);
    expect(NORTH_SOUTH_JOINS.joins).toHaveLength(4);
  });

  it("accepts two buildings whose join edges face each other and rejects a quarter turn", () => {
    const facing = [
      at(0, NORTH_SOUTH_JOINS, T_X, T_Z),
      at(1, NORTH_SOUTH_JOINS, T_X, T_Z + MODULE_LDU),
    ];
    expect(rules(facing, OPEN_TABLE, "lego-modular")).toEqual([]);
    const turned = [facing[0], at(1, NORTH_SOUTH_JOINS, T_X, T_Z + MODULE_LDU, 1)].filter(
      (p): p is BuildablePlacement => p !== undefined,
    );
    const issues = report(OPEN_TABLE, turned, "lego-modular").issues;
    expect(issues.map((i) => i.rule)).toEqual(["moduleJoin"]);
    expect(issues[0]?.message).toContain("has 9–10, 21–22");
    expect(issues[0]?.message).toContain("has none");
  });

  it("flags a module off the 32-stud grid", () => {
    const shifted = [at(0, NORTH_SOUTH_JOINS, T_X + 40, T_Z)];
    expect(rules(shifted, OPEN_TABLE, "lego-modular")).toEqual([["moduleGrid", [0]]]);
    expect(rules(shifted, OPEN_TABLE, "free")).toEqual([]);
  });
});

describe("MILS modules", () => {
  it("treats a bare 3811 as a MILS module with corner joins that a modular building can't meet", () => {
    const issues = report(
      OPEN_TABLE,
      [at(0, BASEPLATE_ITEM, T_X, T_Z), at(1, NORTH_SOUTH_JOINS, T_X, T_Z + MODULE_LDU)],
      "mils",
    ).issues;
    expect(issues.map((i) => i.rule)).toEqual(["moduleJoin"]);
    expect(issues[0]?.message).toContain("3811 has 2–5, 26–29");
    expect(issues[0]?.message).toContain("omr:north-south has 9–10, 21–22");
  });

  it("joins two MILS modules and counts the published 24-part substructure under each", () => {
    const result = report(
      OPEN_TABLE,
      [at(0, BASEPLATE_ITEM, T_X, T_Z), at(1, BASEPLATE_ITEM, T_X + MODULE_LDU, T_Z)],
      "mils",
    );
    expect(result.verdict).toBe("buildable");
    expect(result.bom.totalParts).toBe(2 * 25);
    expect(result.bom.lines.find((l) => l.part === "ldraw:3701")).toMatchObject({
      part: "ldraw:3701",
      ldrawColor: null,
      quantity: 16,
      substructure: 16,
    });
  });
});

describe("roads", () => {
  it("accepts road plates in line and rejects one turned across the road", () => {
    const inLine = [at(0, ROAD, T_X, T_Z), at(1, ROAD, T_X, T_Z + MODULE_LDU)];
    expect(rules(inLine, OPEN_TABLE, "free")).toEqual([]);
    const across = [at(0, ROAD, T_X, T_Z), at(1, ROAD, T_X, T_Z + MODULE_LDU, 1)];
    expect(rules(across, OPEN_TABLE, "free")).toEqual([["roadJoin", [0, 1]]]);
  });

  it("rejects a road that runs into a plain baseplate", () => {
    const deadEnd = [at(0, ROAD, T_X, T_Z), at(1, BASEPLATE_ITEM, T_X, T_Z + MODULE_LDU)];
    const issues = report(OPEN_TABLE, deadEnd, "free").issues;
    expect(issues.map((i) => i.rule)).toEqual(["roadJoin"]);
    expect(issues[0]?.message).toContain("are 6–25");
  });
});

describe("tables: overlap, seams and reach", () => {
  it("rejects two baseplates on the same area", () => {
    const stacked = [at(0, BASEPLATE_ITEM, T_X, T_Z), at(1, BASEPLATE_ITEM, T_X + 320, T_Z)];
    expect(rules(stacked, OPEN_TABLE, "free")).toEqual([["overlap", [0, 1]]]);
  });

  it("rejects a module straddling a table seam and accepts one whose edge is on it", () => {
    const pair = region([
      table("left", 1024, 1024, 2 * MODULE_MM, 2 * MODULE_MM),
      table("right", 1024 + 2 * MODULE_MM, 1024, 2 * MODULE_MM, 2 * MODULE_MM),
    ]);
    const x = (1024 / MODULE_MM) * MODULE_LDU;
    expect(rules([at(0, BASEPLATE_ITEM, x + MODULE_LDU, x)], pair, "free")).toEqual([]);
    expect(rules([at(0, BASEPLATE_ITEM, x + MODULE_LDU + 320, x)], pair, "free")).toEqual([
      ["seam", [0]],
    ]);
  });

  it("measures reach from free table edges only, not from the edge against a wall", () => {
    const depth = 5 * MODULE_MM;
    const againstWall = region([table("wall", 1024, 0, 8 * MODULE_MM, depth)]);
    const x = (1024 / MODULE_MM) * MODULE_LDU;
    const backRow = at(0, BASEPLATE_ITEM, x + 3 * MODULE_LDU, 0);
    const frontRow = at(1, BASEPLATE_ITEM, x + 3 * MODULE_LDU, 4 * MODULE_LDU);
    const issues = report(againstWall, [backRow, frontRow], "free").issues;
    expect(issues.map((i) => [i.rule, i.placements.map((key) => key.slot)])).toEqual([
      ["reach", [0]],
    ]);
    const islandZ = (1024 / MODULE_MM) * MODULE_LDU;
    const island = region([table("island", 1024, 1024, 8 * MODULE_MM, depth)]);
    const middleRow = at(0, BASEPLATE_ITEM, x + 3 * MODULE_LDU, islandZ + 2 * MODULE_LDU);
    expect(rules([middleRow], island, "free")).toEqual([]);
    expect(report(island, [middleRow], "free", 600).issues.map((i) => i.rule)).toEqual(["reach"]);
  });
});

describe("verdict and parts list", () => {
  it("treats a part with no BrickLink id as not buildable and names the placements holding it", () => {
    const issues = report(OPEN_TABLE, [
      at(0, BASEPLATE_ITEM, T_X, T_Z),
      at(1, UNLISTED_ROAD, T_X + MODULE_LDU, T_Z),
    ]).issues;
    expect(issues.map((i) => [i.rule, i.placements.map((key) => key.slot)])).toEqual([
      ["bomMapping", [1]],
    ]);
    expect(issues[0]?.message).toBe(
      "1 part in 1 line can't be bought on BrickLink: 44336p01 in colour 2 ×1 (no part).",
    );
  });

  it("is buildable with zero issues and sums every placement's parts", () => {
    const result = report(OPEN_TABLE, [
      at(0, NORTH_SOUTH_JOINS, T_X, T_Z),
      at(1, NORTH_SOUTH_JOINS, T_X, T_Z + MODULE_LDU),
    ]);
    expect(result.verdict).toBe("buildable");
    expect(result.bom.totalParts).toBe(12);
    expect(result.bom.lines.map((l) => [l.part, l.quantity])).toEqual([
      ["ldraw:3700", 10],
      ["ldraw:3811", 2],
    ]);
  });

  it("buys a shortcut with no catalog id as its official components", () => {
    const withShortcut = building("omr:with-shortcut", []);
    const spec: ItemSpec = {
      ...withShortcut,
      bom: [...withShortcut.bom, { part: "ldraw:2495c01", ldrawColor: 15, quantity: 1 }],
    };
    const catalog: BuildableCatalog = { ...CATALOG, specs: new Map([[spec.ref, spec]]) };
    const placement = at(0, spec, T_X, T_Z);
    const check = checkPlan(OPEN_TABLE, [placement]);
    const result = checkBuildable(
      OPEN_TABLE,
      check,
      [placement],
      catalog,
      { profile: "free", maxReachMm: 700 },
      null,
    );
    expect(result.issues).toEqual([]);
    expect(result.bom.lines.map((l) => [l.part, l.ldrawColor, l.bricklink.part])).toEqual([
      ["ldraw:2495", 15, "2495"],
      ["ldraw:2496", 0, "2496"],
      ["ldraw:3811", 15, "3811"],
    ]);
  });

  it("is a draft when the plan check already failed", () => {
    const off = at(0, BASEPLATE_ITEM, T_X - 20, T_Z);
    const result = report(OPEN_TABLE, [off]);
    expect(result.verdict).toBe("draft");
    expect(result.issues.map((i) => i.rule)).toEqual(["fit"]);
  });
});

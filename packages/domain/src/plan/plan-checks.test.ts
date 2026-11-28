import { lduFromMm } from "@brr/math";
import { describe, expect, it } from "vitest";
import type { PlacementFacts } from "./plan-facts.ts";
import type { LduRect, PlanObstacle, PlanRegion, PlanTable } from "./plan-region.ts";
import { checkPlan, type PlanIssue, type PlanPlacement } from "./plan-rules.ts";

const BRICK_FOOTING = [-40, -20, 40, 20];

function table(name: string, x: number, z: number, width: number, depth: number): PlanTable {
  return { id: name, number: 1, name, rect: { x, z, width, depth }, heightMm: 750 };
}

function region(
  tables: PlanTable[],
  overrides: Partial<PlanRegion> = {},
  obstacles: PlanObstacle[] = [],
): PlanRegion {
  return {
    id: "plan",
    name: "Test room",
    originChunkX: 0,
    originChunkZ: 0,
    footprint: { roomWidthMm: 4000, roomDepthMm: 4000, tables, obstacles },
    maxOverhangMm: 0,
    maxReachMm: 700,
    ...overrides,
  };
}

function boundsOf(rects: ReadonlyArray<number>, x: number, z: number): LduRect {
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < rects.length; i += 4) {
    minX = Math.min(minX, x + (rects[i] ?? 0));
    minZ = Math.min(minZ, z + (rects[i + 1] ?? 0));
    maxX = Math.max(maxX, x + (rects[i + 2] ?? 0));
    maxZ = Math.max(maxZ, z + (rects[i + 3] ?? 0));
  }
  return { minX, minZ, maxX, maxZ };
}

interface Shaped {
  readonly footing?: ReadonlyArray<number>;
  readonly occupancy?: ReadonlyArray<number>;
  readonly unsupported?: boolean;
  readonly carriedTrackUnsupported?: boolean;
  readonly facts?: Partial<PlacementFacts>;
}

function placed(slot: number, xMm: number, zMm: number, shaped: Shaped = {}): PlanPlacement {
  const x = lduFromMm(xMm);
  const z = lduFromMm(zMm);
  const footing = shaped.footing ?? BRICK_FOOTING;
  const occupancy = shaped.occupancy ?? footing;
  return {
    key: { chunkKey: 1, slot },
    ref: "ldraw:3001",
    label: `brick ${slot}`,
    box: boundsOf(occupancy, x, z),
    shape: { footing: Float64Array.from(footing), occupancy: Float64Array.from(occupancy) },
    anchor: { x, z },
    unsupported: shaped.unsupported ?? false,
    carriedTrackUnsupported: shaped.carriedTrackUnsupported ?? false,
    facts: {
      unmeasured: false,
      overlapWith: null,
      roadJoinedCells: 0,
      roadMismatchedCells: 0,
      unmappedRebrickable: 0,
      unmappedBrickLink: 0,
      ...shaped.facts,
    },
  };
}

function rulesOf(issues: ReadonlyArray<PlanIssue>): Array<[string, ReadonlyArray<number>]> {
  return issues.map((issue) => [issue.rule, issue.placements.map((key) => key.slot)]);
}

describe("seams between two tables pushed together", () => {
  const sideBySide = region([table("A", 0, 0, 1000, 1000), table("B", 1000, 0, 1000, 1000)]);

  it("reports a placement whose footing stands on both tables, naming the pair", () => {
    const issues = checkPlan(sideBySide, [placed(0, 1000, 500)]).issues;
    expect(issues.map((issue) => issue.message)).toEqual([
      'brick 0 stands across the seam between tables "A" and "B"; a seam must fall between placements.',
    ]);
  });

  it("accepts a footing flush against the seam from either side", () => {
    const flush = [placed(0, 984, 500), placed(1, 1016, 500)];
    expect(checkPlan(sideBySide, flush).issues).toEqual([]);
  });

  it("judges what stands on the table, so an overhang above the seam passes", () => {
    const roof = { footing: BRICK_FOOTING, occupancy: [-80, -20, 80, 20] };
    expect(checkPlan(sideBySide, [placed(0, 976, 500, roof)]).issues).toEqual([]);
  });

  it("only counts the seam where the two tables share an edge", () => {
    const short = region([table("A", 0, 0, 1000, 1000), table("B", 1000, 0, 1000, 500)]);
    expect(rulesOf(checkPlan(short, [placed(0, 1000, 800)]).issues)).toEqual([["fit", [0]]]);
  });
});

describe("reach from the free table edges", () => {
  const square = region([table("A", 500, 500, 2000, 2000)]);

  it("reports a part farther than the reach from every edge", () => {
    expect(checkPlan(square, [placed(0, 1500, 1500)]).issues.map((i) => i.message)).toEqual([
      "brick 0 is out of reach: part of it is more than 700 mm from every table edge you can stand at.",
    ]);
  });

  it("measures what the placement occupies, not its bounding box", () => {
    const feet = [-2400, -20, -2300, 20, 2300, -20, 2400, 20];
    const across = placed(0, 1500, 1500, { footing: feet, occupancy: feet });
    expect(checkPlan(square, [across]).issues).toEqual([]);
    expect(
      checkPlan(region([table("A", 500, 500, 2000, 2000)], { maxReachMm: 0 }), [across]),
    ).toMatchObject({ issues: [{ rule: "reach" }] });
  });

  it("reaches into an inside corner only through the disk at the end of its edges", () => {
    const ell = region([table("A", 0, 0, 2000, 1000), table("B", 0, 1000, 1000, 1000)], {
      maxReachMm: 400,
    });
    const corner = [-40, -40, 0, 0];
    const nearCorner = placed(0, 990, 990, { footing: corner, occupancy: corner });
    expect(checkPlan(ell, [nearCorner]).issues).toEqual([]);
    const pastDisk = placed(1, 700, 700, { footing: corner, occupancy: corner });
    expect(rulesOf(checkPlan(ell, [pastDisk]).issues)).toEqual([["reach", [1]]]);
  });

  it("treats an edge an obstacle meets as an edge nobody stands at", () => {
    const wall: PlanObstacle = {
      id: "wall",
      name: "Wall",
      rect: { x: 0, z: 0, width: 500, depth: 3000 },
    };
    const walled = region([table("A", 500, 500, 2000, 2000)], {}, [wall]);
    const nearWall = placed(0, 1100, 1500);
    expect(checkPlan(square, [nearWall]).issues).toEqual([]);
    expect(rulesOf(checkPlan(walled, [nearWall]).issues)).toEqual([["reach", [0]]]);
  });
});

describe("measured facts on a placement", () => {
  it("reports the footprint first, then unmapped parts per catalog as warnings, then each placement's support, overlap and road issues in rule order", () => {
    const plan = region([table("A", 0, 0, 1000, 1000)], { maxReachMm: -1 });
    const loose = placed(0, 200, 200, {
      unsupported: true,
      facts: { overlapWith: "brick 1", roadMismatchedCells: 3, unmappedRebrickable: 2 },
    });
    const pending = placed(1, 600, 600, {
      carriedTrackUnsupported: true,
      facts: { unmeasured: true, unmappedRebrickable: 1, unmappedBrickLink: 1 },
    });
    expect(
      checkPlan(plan, [loose, pending]).issues.map((i) => [i.rule, i.severity, i.message]),
    ).toEqual([
      ["footprint", "error", "The reach limit must be zero or more whole mm."],
      [
        "bomMapping",
        "warning",
        "3 parts in this plan have no Rebrickable part or colour id; the parts list names them.",
      ],
      [
        "bomMapping",
        "warning",
        "1 part in this plan has no BrickLink part or colour id; the parts list names them.",
      ],
      [
        "unsupported",
        "error",
        "brick 0 isn't held: none of its anti-studs sits on a stud, and it doesn't stand on the bare table.",
      ],
      ["overlap", "error", "brick 0 overlaps brick 1."],
      [
        "roadJoin",
        "error",
        "brick 0's road doesn't continue into its neighbour on 3 edge cells: the lanes or curbs differ.",
      ],
      [
        "unsupported",
        "error",
        "brick 1 carries track that isn't held: none of that track's anti-studs sits on a stud, and it doesn't stand on the bare table.",
      ],
    ]);
  });
});

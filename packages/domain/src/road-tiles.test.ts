import { describe, expect, it } from "vitest";
import measured from "../../../docs/verified-facts/geometry.json" with { type: "json" };
import { NO_STUD, RoadNetwork, type RoadPlacement, type RoadSurface } from "./road-joins.ts";
import {
  extendRoadPath,
  planRoadErase,
  planRoadTiles,
  roadKits,
  type ExistingRoadTile,
  type PlannedRoadTile,
  type RoadKit,
  type RoadTile,
} from "./road-tiles.ts";

const STUD = 20;

function roadBaseplate(part: string): RoadSurface {
  const zones = measured.roadStudZones.find((entry) => entry.part === part);
  if (!zones) throw new Error(`${part} is not measured`);
  const rows = zones.map.length;
  const columns = zones.map[0]?.length ?? 0;
  const top = new Int32Array(rows * columns);
  const stud = new Int32Array(rows * columns).fill(NO_STUD);
  const road = new Uint8Array(rows * columns).fill(1);
  zones.map.forEach((line, row) => {
    for (let column = 0; column < columns; column++) {
      if (line[column] !== "o") continue;
      stud[row * columns + column] = 0;
      road[row * columns + column] = 0;
    }
  });
  return { minX: (-columns * STUD) / 2, minZ: (-rows * STUD) / 2, columns, rows, top, stud, road };
}

const PARTS = ["44336", "44342", "44341", "44343", "30225b", "2358"] as const;
const surfaces = PARTS.map(roadBaseplate);
const kits = roadKits(surfaces.map((surface, ref) => ({ ref, family: "72", surface })));

function kitOf(part: (typeof PARTS)[number]): RoadKit {
  const ref = PARTS.indexOf(part);
  const kit = kits.find((k) => k.pieces.some((piece) => piece.ref === ref));
  if (!kit) throw new Error(`${part} is in no kit`);
  return kit;
}

function path(...cells: ReadonlyArray<readonly [number, number]>): ReadonlyArray<RoadTile> {
  return cells.reduce<ReadonlyArray<RoadTile>>(
    (tiles, [ix, iz]) => extendRoadPath(tiles, ix, iz),
    [],
  );
}

function lay(kit: RoadKit, planned: ReadonlyArray<PlannedRoadTile>): ReadonlyArray<RoadPlacement> {
  return planned.map((tile, id) => {
    if (tile.kind !== "lay") throw new Error(`tile ${tile.ix},${tile.iz} was ${tile.kind}`);
    const choice = tile.choices[0];
    if (!choice) throw new Error("a laid tile has a choice");
    const surface = surfaces[choice.ref];
    if (!surface) throw new Error(`ref ${choice.ref} has no surface`);
    return {
      id,
      x: tile.ix * kit.tileLdu,
      z: tile.iz * kit.tileLdu,
      yLdu: 0,
      rot: choice.rot,
      surface,
    };
  });
}

const none = (): ExistingRoadTile | null => null;
const foreign = (ix: number, iz: number): ExistingRoadTile | null =>
  ix === 1 && iz === 0 ? { arms: 0b0011, sameKit: false } : null;

describe("road kits from measured plates", () => {
  it("groups the 6-stud straight, curve, T-junction and crossroads into one kit, apart from the dual and 7-stud roads", () => {
    const six = kitOf("44336");
    expect(six.pieces.map((piece) => PARTS[piece.ref])).toEqual([
      "44336",
      "44342",
      "44341",
      "44343",
    ]);
    expect(six.shapes).toEqual(["straight", "curve", "t-junction", "crossroads"]);
    expect(six.tileLdu).toBe(640);
    expect(six.edgeRuns).toEqual([
      { road: false, cells: 6 },
      { road: true, cells: 20 },
      { road: false, cells: 6 },
    ]);
    expect(kitOf("30225b")).not.toBe(six);
    expect(kitOf("2358")).not.toBe(six);
    expect(kitOf("2358").shapes).toEqual(["straight"]);
  });
});

describe("road autotiling", () => {
  const six = kitOf("44336");
  const strokes: ReadonlyArray<readonly [string, ReadonlyArray<readonly [number, number]>]> = [
    [
      "a straight run",
      [
        [0, 0],
        [4, 0],
      ],
    ],
    [
      "an L turn",
      [
        [0, 0],
        [3, 0],
        [3, 3],
      ],
    ],
    [
      "an S bend",
      [
        [0, 0],
        [2, 0],
        [2, 2],
        [4, 2],
      ],
    ],
    [
      "a closed square loop",
      [
        [0, 0],
        [3, 0],
        [3, 3],
        [0, 3],
        [0, 0],
      ],
    ],
    [
      "a figure crossing itself",
      [
        [0, 1],
        [3, 1],
        [3, 3],
        [1, 3],
        [1, 0],
      ],
    ],
  ];

  it.each(strokes)("lays %s from real pieces whose edges all join exactly", (_, cells) => {
    const planned = planRoadTiles(six, path(...cells), none, 0);
    const report = new RoadNetwork(lay(six, planned)).report();
    expect(report.mismatchedCells).toBe(0);
    expect(report.overlaps).toEqual([]);
    expect(report.joinedCells).toBeGreaterThan(0);
  });

  it("closes a square loop with no open road edge and four curves", () => {
    const planned = planRoadTiles(six, path([0, 0], [2, 0], [2, 2], [0, 2], [0, 0]), none, 0);
    const report = new RoadNetwork(lay(six, planned)).report();
    expect(report.openCells).toBe(0);
    const curve = PARTS.indexOf("44342");
    const curves = planned.filter((t) => t.kind === "lay" && t.choices[0]?.ref === curve);
    expect(curves).toHaveLength(4);
  });

  it("puts a crossroads where a stroke crosses itself", () => {
    const planned = planRoadTiles(six, path([0, 1], [2, 1], [2, 2], [1, 2], [1, 0]), none, 0);
    const crossing = planned.find((t) => t.ix === 1 && t.iz === 1);
    expect(crossing?.kind === "lay" && PARTS[crossing.choices[0]?.ref ?? -1]).toBe("44343");
  });

  it("turns an existing straight into a T-junction when a stroke branches off it", () => {
    const straightArms = 0b1100;
    const existingAt = (ix: number, iz: number): ExistingRoadTile | null =>
      ix === 0 && iz >= -2 && iz <= 2 ? { arms: straightArms, sameKit: true } : null;
    const planned = planRoadTiles(six, path([0, 0], [3, 0]), existingAt, 0);
    const branch = planned.find((t) => t.ix === 0 && t.iz === 0);
    expect(branch?.kind).toBe("lay");
    if (branch?.kind !== "lay") return;
    expect(branch.replaces).toBe(true);
    expect(PARTS[branch.choices[0]?.ref ?? -1]).toBe("44341");
  });

  it("refuses a turn in a kit without curves, and a change to another family's plate", () => {
    const sevenStud = kitOf("2358");
    const turn = planRoadTiles(sevenStud, path([0, 0], [1, 0], [1, 1]), none, 0);
    expect(turn.find((t) => t.ix === 1 && t.iz === 0)).toMatchObject({
      kind: "refuse",
      reason: "no-piece",
    });
    const branch = planRoadTiles(six, path([1, 1], [1, 0]), foreign, 0);
    expect(branch.find((t) => t.ix === 1 && t.iz === 0)).toMatchObject({
      kind: "refuse",
      reason: "other-family",
    });
  });

  it("erases road tiles, downgrading the T beside them to its remaining arms and never touching another family", () => {
    const world = new Map<string, ExistingRoadTile>([
      ["1,0", { arms: 0b0011, sameKit: true }],
      ["2,0", { arms: 0b1011, sameKit: true }],
      ["3,0", { arms: 0b0011, sameKit: true }],
      ["2,1", { arms: 0b1100, sameKit: true }],
      ["2,2", { arms: 0b1100, sameKit: true }],
      ["5,0", { arms: 0b0011, sameKit: false }],
    ]);
    const existingAt = (ix: number, iz: number) => world.get(`${ix},${iz}`) ?? null;
    const planned = planRoadErase(six, path([2, 2], [2, 1]), existingAt);
    expect(planned.filter((t) => t.kind === "remove").map((t) => [t.ix, t.iz])).toEqual([
      [2, 2],
      [2, 1],
    ]);
    const downgrade = planned.find((t) => t.kind === "lay");
    expect(downgrade).toMatchObject({ ix: 2, iz: 0, arms: 0b0011, replaces: true });
    expect(downgrade?.kind === "lay" && PARTS[downgrade.choices[0]?.ref ?? -1]).toBe("44336");
    expect(planned).toHaveLength(3);
    const eastward = planRoadErase(six, path([3, 0], [5, 0]), existingAt);
    expect(eastward.map((t) => [t.kind, t.ix])).toEqual([
      ["remove", 3],
      ["lay", 2],
    ]);
    const curve = eastward.find((t) => t.kind === "lay");
    expect(curve?.kind === "lay" && PARTS[curve.choices[0]?.ref ?? -1]).toBe("44342");
  });

  it("walks a diagonal drag as unit steps and steps back when the pointer returns", () => {
    const walked = path([0, 0], [2, 1]);
    expect(walked).toEqual([
      { ix: 0, iz: 0 },
      { ix: 1, iz: 0 },
      { ix: 2, iz: 0 },
      { ix: 2, iz: 1 },
    ]);
    expect(extendRoadPath(walked, 2, 0)).toEqual(walked.slice(0, -1));
  });
});

import { LevelCrossingRecipe } from "@brr/schema/bundle";
import { decode, decodedOrThrow } from "@brr/schema/decode";
import { describe, expect, it } from "vitest";
import measured from "../../../docs/verified-facts/geometry.json" with { type: "json" };
import recipeJson from "../../../docs/verified-facts/level-crossing.json" with { type: "json" };
import {
  planLevelCrossings,
  type CrossingConflict,
  type CrossingTrackPiece,
  type TrackAxis,
} from "./level-crossings.ts";
import type { LduRect } from "./plan/plan-region.ts";
import { NO_STUD, type RoadPlacement, type RoadSurface } from "./road-joins.ts";

const STUD = 20;
const PIECE = 320;
const HALF_WIDTH = 80;
const recipe = decodedOrThrow(decode(LevelCrossingRecipe, recipeJson), "level-crossing.json");

function roadBaseplate(part: string, topLdu = 0): RoadSurface {
  const zones = measured.roadStudZones.find((entry) => entry.part === part);
  if (!zones) throw new Error(`${part} is not measured`);
  const rows = zones.map.length;
  const columns = zones.map[0]?.length ?? 0;
  const top = new Int32Array(rows * columns).fill(topLdu);
  const stud = new Int32Array(rows * columns).fill(NO_STUD);
  const road = new Uint8Array(rows * columns).fill(1);
  zones.map.forEach((line, row) => {
    for (let column = 0; column < columns; column++) {
      if (line[column] !== "o") continue;
      stud[row * columns + column] = topLdu;
      road[row * columns + column] = 0;
    }
  });
  return { minX: (-columns * STUD) / 2, minZ: (-rows * STUD) / 2, columns, rows, top, stud, road };
}

function plate(part: string, rot = 0, topLdu = 0, x = 0, z = 0): RoadPlacement {
  return { id: 0, x, z, yLdu: 0, rot, surface: roadBaseplate(part, topLdu) };
}

function run(axis: TrackAxis, across: number, from: number, pieces: number): CrossingTrackPiece[] {
  return Array.from({ length: pieces }, (_, i) => {
    const start = from + i * PIECE;
    const line = { axis, across, from: start, to: start + PIECE };
    const box: LduRect =
      axis === "x"
        ? { minX: start, maxX: start + PIECE, minZ: across - HALF_WIDTH, maxZ: across + HALF_WIDTH }
        : {
            minX: across - HALF_WIDTH,
            maxX: across + HALF_WIDTH,
            minZ: start,
            maxZ: start + PIECE,
          };
    return { index: i, bedLdu: 0, straight: true, line, box };
  });
}

function renumbered(
  ...runs: ReadonlyArray<ReadonlyArray<CrossingTrackPiece>>
): CrossingTrackPiece[] {
  return runs.flat().map((piece, index) => ({ ...piece, index }));
}

const everywhere = (): boolean => true;

function reasons(
  roads: ReadonlyArray<RoadPlacement>,
  tracks: ReadonlyArray<CrossingTrackPiece>,
): ReadonlyArray<CrossingConflict> {
  const plan = planLevelCrossings(recipe, roads, tracks, everywhere);
  return [...new Set(plan.conflicts.map((conflict) => conflict.reason))];
}

describe("level crossings where track meets a road plate", () => {
  it("puts the four ramps on the roadway, centred on the road and flush with the track sides", () => {
    const plan = planLevelCrossings(recipe, [plate("44336")], run("x", -60, -640, 4), everywhere);
    expect(plan.conflicts).toEqual([]);
    expect(plan.crossings).toHaveLength(1);
    const [crossing] = plan.crossings;
    expect({ x: crossing?.centreX, z: crossing?.centreZ, tracks: crossing?.tracks }).toEqual({
      x: 0,
      z: -60,
      tracks: [1, 2],
    });
    expect(crossing?.slopes.map((slope) => slope.footprint).toSorted(byCorner)).toEqual([
      { minX: -160, maxX: 0, minZ: -260, maxZ: -140 },
      { minX: 0, maxX: 160, minZ: -260, maxZ: -140 },
      { minX: -160, maxX: 0, minZ: 20, maxZ: 140 },
      { minX: 0, maxX: 160, minZ: 20, maxZ: 140 },
    ]);
    expect(crossing?.slopes.every((slope) => slope.y - recipe.slopeRiseLdu === 0)).toBe(true);
  });

  it.each([0, 1, 2, 3])("turns the crossing with a road plate turned %i quarters", (rot) => {
    const axis: TrackAxis = rot % 2 === 0 ? "x" : "z";
    const plan = planLevelCrossings(
      recipe,
      [plate("44336", rot)],
      run(axis, 40, -640, 4),
      everywhere,
    );
    const footprints = plan.crossings.flatMap((crossing) =>
      crossing.slopes.map((s) => s.footprint),
    );
    const swap = (rect: LduRect): LduRect =>
      axis === "x" ? rect : { minX: rect.minZ, maxX: rect.maxZ, minZ: rect.minX, maxZ: rect.maxX };
    expect(footprints.map(swap).toSorted(byCorner)).toEqual([
      { minX: -160, maxX: 0, minZ: -160, maxZ: -40 },
      { minX: 0, maxX: 160, minZ: -160, maxZ: -40 },
      { minX: -160, maxX: 0, minZ: 120, maxZ: 240 },
      { minX: 0, maxX: 160, minZ: 120, maxZ: 240 },
    ]);
  });

  it("fits the 16-stud ramps exactly across the 8-stud plate's 16-stud roadway", () => {
    const plan = planLevelCrossings(recipe, [plate("610")], run("x", 0, -640, 4), everywhere);
    expect({ crossings: plan.crossings.length, conflicts: plan.conflicts }).toEqual({
      crossings: 1,
      conflicts: [],
    });
  });

  it("lets the ramps run onto the next plate of the same road", () => {
    const roads = [plate("44336"), { ...plate("44336", 0, 0, 0, 640), id: 1 }];
    const plan = planLevelCrossings(recipe, roads, run("x", 280, -640, 4), everywhere);
    expect(plan.conflicts).toEqual([]);
    expect(plan.crossings.map(({ roads: under, centreZ }) => ({ under, centreZ }))).toEqual([
      { under: [0, 1], centreZ: 280 },
    ]);
  });

  it("leaves track on the studded verge alone: no ramps and no conflict", () => {
    const plan = planLevelCrossings(recipe, [plate("44336")], run("z", -320, -320, 2), everywhere);
    expect(plan).toEqual({ crossings: [], conflicts: [] });
  });

  it.each<
    readonly [string, () => readonly [RoadPlacement[], CrossingTrackPiece[]], CrossingConflict]
  >([
    ["track running along the road", () => [[plate("44336")], run("z", 0, -640, 4)], "along-road"],
    [
      "track across a curve plate",
      () => [[plate("44342")], run("x", 0, -640, 4)],
      "not-straight-road",
    ],
    [
      "track across a T-junction",
      () => [[plate("44341")], run("x", 0, -640, 4)],
      "not-straight-road",
    ],
    [
      "a 9-stud road whose 14-stud roadway is narrower than the ramps",
      () => [[plate("606")], run("x", 0, -640, 4)],
      "narrow-roadway",
    ],
    [
      "ramps that would run off the plate's end",
      () => [[plate("44336")], run("x", 200, -640, 4)],
      "ramps-off-road",
    ],
    [
      "a road plate standing 2 plates above the track bed",
      () => [[plate("44336", 0, 16)], run("x", 0, -640, 4)],
      "raised-road",
    ],
    [
      "a second track 8 studs over, under the first one's ramps",
      () => [[plate("44336")], renumbered(run("x", -80, -640, 4), run("x", 80, -640, 4))],
      "ramps-hit-track",
    ],
    [
      "a second track 16 studs over on the next plate, whose ramps overlap the first one's",
      () => [
        [plate("44336"), { ...plate("44336", 0, 0, 0, 640), id: 1 }],
        renumbered(run("x", 200, -640, 4), run("x", 520, -640, 4)),
      ],
      "ramps-overlap",
    ],
  ])("refuses %s", (_case, world, reason) => {
    const [roads, tracks] = world();
    const plan = planLevelCrossings(recipe, roads, tracks, everywhere);
    expect({ reasons: reasons(roads, tracks), crossings: plan.crossings }).toEqual({
      reasons: [reason],
      crossings: [],
    });
  });

  it("refuses a curve over the roadway, and a straight off the stud grid, by the piece's own geometry", () => {
    const box = { minX: -200, maxX: 100, minZ: -100, maxZ: 60 };
    const curve = { index: 0, bedLdu: 0, straight: false, line: null, box };
    const offGrid = { index: 1, bedLdu: 0, straight: true, line: null, box };
    const away = { index: 2, bedLdu: 0, straight: false, line: null, box };
    const plan = planLevelCrossings(
      recipe,
      [plate("44336")],
      [curve, offGrid, away],
      (track) => track !== 2,
    );
    expect(plan.conflicts.map(({ track, reason }) => ({ track, reason }))).toEqual([
      { track: 0, reason: "not-straight" },
      { track: 1, reason: "off-lattice" },
    ]);
  });
});

function byCorner(a: LduRect, b: LduRect): number {
  return a.minZ - b.minZ || a.minX - b.minX;
}

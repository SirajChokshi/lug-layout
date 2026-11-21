import { NO_STUD, RoadFit, RoadNetwork, type RoadPlacement, type RoadSurface } from "@brr/domain";
import { describe, expect, it } from "vitest";
import measured from "../../../../docs/verified-facts/geometry.json" with { type: "json" };
import {
  ANY_TURN,
  cellExtent,
  placedRoads,
  roadOverlapCells,
  snapToRoadEdge,
  type RestingHeights,
} from "./road-snap.ts";

const STUD = 20;
const PLATE_SPAN = 640;
const QUARTER_TURNS = [0, 1, 2, 3];
const ON_THE_TABLE: RestingHeights = { restingYLdu: () => 0 };

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
  return {
    minX: (-columns * STUD) / 2,
    minZ: (-rows * STUD) / 2,
    columns,
    rows,
    topSixteenths: top,
    studSixteenths: stud,
    road,
  };
}

function allRoad(columns: number, rows: number): RoadSurface {
  return {
    minX: (-columns * STUD) / 2,
    minZ: (-rows * STUD) / 2,
    columns,
    rows,
    topSixteenths: new Int32Array(rows * columns),
    studSixteenths: new Int32Array(rows * columns).fill(NO_STUD),
    road: new Uint8Array(rows * columns).fill(1),
  };
}

function rowsOf(surface: RoadSurface, from: number, count: number): RoadSurface {
  const start = from * surface.columns;
  const end = start + count * surface.columns;
  return {
    minX: surface.minX,
    minZ: (-count * STUD) / 2,
    columns: surface.columns,
    rows: count,
    topSixteenths: surface.topSixteenths.slice(start, end),
    studSixteenths: surface.studSixteenths.slice(start, end),
    road: surface.road.slice(start, end),
  };
}

function world(placements: ReadonlyArray<RoadPlacement>) {
  return placedRoads(new RoadNetwork(placements), placements);
}

function counted(pieces: ReadonlyArray<RoadPlacement>, at: RoadPlacement): number {
  return roadOverlapCells(world(pieces), at);
}

describe("road overlap at the pose's own height", () => {
  const surface = allRoad(32, 32);
  const held = (x: number, z: number, yLdu = 0): RoadPlacement => ({
    id: -1,
    x,
    z,
    yLdu,
    rot: 0,
    surface,
  });
  const piece = (x: number, z: number, yLdu = 0): RoadPlacement => ({
    id: 1,
    x,
    z,
    yLdu,
    rot: 0,
    surface,
  });
  const half = PLATE_SPAN / 2;

  it("counts the held piece's exact cells on placed road once each, on every side, down to a 1 LDU sliver and at any whole-LDU offset, and none flush beside it", () => {
    expect(counted([piece(half, 0)], held(0, 0))).toBe(16 * 32);
    expect(counted([piece(PLATE_SPAN, 0)], held(0, 0))).toBe(0);
    expect(counted([piece(PLATE_SPAN - 7, 0)], held(0, 0))).toBe(32);
    expect(counted([piece(PLATE_SPAN + 7, 0)], held(0, 0))).toBe(0);
    expect(counted([piece(PLATE_SPAN - 1, 0)], held(0, 0))).toBe(32);
    expect(counted([piece(-(PLATE_SPAN - 1), 0)], held(0, 0))).toBe(32);
    expect(counted([piece(0, PLATE_SPAN - 1)], held(0, 0))).toBe(32);
    expect(counted([piece(0, -(PLATE_SPAN - 1))], held(0, 0))).toBe(32);
    expect(counted([piece(PLATE_SPAN - 1, PLATE_SPAN - 1)], held(0, 0))).toBe(1);
    expect(counted([piece(PLATE_SPAN + 1, 0)], held(0, 0))).toBe(0);
    expect(counted([piece(PLATE_SPAN, 0)], held(7, 0))).toBe(32);
    expect(counted([piece(-(PLATE_SPAN - 7), 0)], held(0, 0))).toBe(32);
    expect(counted([piece(-PLATE_SPAN, 0)], held(-7, 0))).toBe(32);
    expect(counted([piece(-PLATE_SPAN, 0)], held(0, 0))).toBe(0);
    expect(counted([piece(0, PLATE_SPAN - 7)], held(0, 0))).toBe(32);
    expect(counted([piece(0, -(PLATE_SPAN - 7))], held(0, 0))).toBe(32);
    expect(counted([piece(PLATE_SPAN, PLATE_SPAN)], held(0, 0))).toBe(0);
    expect(counted([piece(-2 * PLATE_SPAN, -2 * PLATE_SPAN)], held(0, 0))).toBe(0);
    expect(
      counted([piece(half, 0), { ...piece(-2 * PLATE_SPAN, 2 * PLATE_SPAN), id: 2 }], held(0, 0)),
    ).toBe(16 * 32);
    expect(counted([piece(7 - half, 0), { ...piece(7 + half, 0), id: 2 }], held(0, 0))).toBe(
      32 * 32,
    );
  });

  it("counts a turned non-square surface on its own turned cells", () => {
    const strip = rowsOf(surface, 0, 4);
    const at = (id: number, x: number, z: number, rot: number): RoadPlacement => ({
      id,
      x,
      z,
      yLdu: 0,
      rot,
      surface: strip,
    });
    const across = [at(1, 0, 0, 0)];
    expect(counted(across, at(-1, 0, 0, 1))).toBe(4 * 4);
    expect(counted(across, at(-1, 0, 50, 3))).toBe(4 * 5);
    expect(counted(across, at(-1, half + 20, 0, 1))).toBe(4);
    expect(counted(across, at(-1, half + 30, 0, 1))).toBe(4);
    expect(counted(across, at(-1, half + 40, 0, 1))).toBe(0);
    expect(counted([at(1, 0, 0, 1)], at(-1, 0, 0, 1))).toBe(4 * 32);
  });

  it("counts only cells at the same top, so a plate raised over the held piece is no overlap until the piece rests at its height", () => {
    expect(counted([piece(half, 0, 8)], held(0, 0))).toBe(0);
    expect(counted([piece(half, 0, 8)], held(0, 0, 8))).toBe(16 * 32);
  });

  it("counts road cells over road cells only: sidewalk over sidewalk, or road over sidewalk, is no road overlap", () => {
    const straight = roadBaseplate("44336");
    const at = (id: number, x: number): RoadPlacement => ({
      id,
      x,
      z: 0,
      yLdu: 0,
      rot: 0,
      surface: straight,
    });
    expect(counted([at(1, PLATE_SPAN - 6 * STUD)], at(-1, 0))).toBe(0);
    expect(counted([at(1, PLATE_SPAN - 7 * STUD)], at(-1, 0))).toBe(0);
    expect(counted([at(1, PLATE_SPAN - 13 * STUD)], at(-1, 0))).toBe(32);
  });

  it("finds placed road across bucket edges of the index, from pieces on either side of them", () => {
    const pieces = [-3, -1, 0, 1, 2, 5].map((tile) => piece(tile * PLATE_SPAN + 3, 0, 0));
    const placed = pieces.map((placement, id) => ({ ...placement, id }));
    for (const x of [-2 * PLATE_SPAN, -PLATE_SPAN + 10, 3, PLATE_SPAN - 17, 4 * PLATE_SPAN]) {
      const brute = placed.reduce((sum, one) => sum + Math.min(1, counted([one], held(x, 0))), 0);
      expect(counted(placed, held(x, 0)) > 0, `${x}`).toBe(brute > 0);
    }
    expect(counted(placed, held(3, 0))).toBe(32 * 32);
    expect(counted(placed, held(PLATE_SPAN + 3 - half, 0))).toBe(32 * 32);
    expect(counted(placed, held(4 * PLATE_SPAN + 3, 0))).toBe(0);
  });
});

describe("road-edge snap", () => {
  const straight: RoadPlacement = {
    id: 0,
    x: 0,
    z: 0,
    yLdu: 0,
    rot: 0,
    surface: roadBaseplate("44336"),
  };
  const roads = world([straight]);
  const { network } = roads;
  const curve = roadBaseplate("44342");
  const openEnd = cellExtent(straight).maxZ;

  it("turns a curve to whichever quarter turn joins its lanes to an open straight end, from any starting rotation", () => {
    for (const preferred of QUARTER_TURNS) {
      const snap = snapToRoadEdge(
        roads,
        curve,
        preferred,
        1,
        ON_THE_TABLE,
        0,
        openEnd + 200,
        ANY_TURN,
      );
      expect(snap).not.toBeNull();
      if (!snap) continue;
      const fit = network.fit(
        { id: 1, x: snap.x, z: snap.z, yLdu: 0, rot: snap.rot, surface: curve },
        new RoadFit(),
      );
      expect(fit.mismatchedCells).toBe(0);
      expect(fit.joinedRoadCells).toBeGreaterThan(0);
      expect(snap.joinedRoadCells).toBe(fit.joinedRoadCells);
      expect(snap.z - PLATE_SPAN / 2).toBe(openEnd);
    }
  });

  it.each([
    ["next", 1],
    ["previous", -1],
  ] as const)(
    "offers the curve's other lane-joining turn when the user asks for the %s rotation",
    (_, direction) => {
      for (const preferred of QUARTER_TURNS) {
        const first = snapToRoadEdge(
          roads,
          curve,
          preferred,
          1,
          ON_THE_TABLE,
          0,
          openEnd + 200,
          ANY_TURN,
        );
        if (!first) throw new Error("the curve does not snap to the open end");
        const turned = (first.rot + direction + 4) % 4;
        const next = snapToRoadEdge(
          roads,
          curve,
          turned,
          direction,
          ON_THE_TABLE,
          0,
          openEnd + 200,
          ANY_TURN,
        );
        expect(next?.rot).not.toBe(first.rot);
        expect(next?.joinedRoadCells).toBe(first.joinedRoadCells);
      }
    },
  );

  it("snaps a turned non-square end strip flush onto the open end at a turn whose lanes meet it, and never into the end", () => {
    const strip = rowsOf(roadBaseplate("44336"), 0, 2);
    for (const preferred of QUARTER_TURNS) {
      const snap = snapToRoadEdge(
        roads,
        strip,
        preferred,
        1,
        ON_THE_TABLE,
        0,
        openEnd + 30,
        ANY_TURN,
      );
      expect(snap, `preferred ${preferred}`).not.toBeNull();
      if (!snap) continue;
      const placed = { id: -1, x: snap.x, z: snap.z, yLdu: 0, rot: snap.rot, surface: strip };
      expect(snap.rot % 2).toBe(0);
      expect(cellExtent(placed).minZ).toBe(openEnd);
      expect(roadOverlapCells(roads, placed)).toBe(0);
      expect(network.fit(placed, new RoadFit()).mismatchedCells).toBe(0);
    }
  });

  it("snaps a piece beside a sidewalk only flush with the neighbour's corner, never part-way along it", () => {
    const sideX = cellExtent(straight).maxX;
    for (const cursorZ of [-260, -60, 0, 140, 300]) {
      const snap = snapToRoadEdge(roads, curve, 0, 1, ON_THE_TABLE, sideX + 300, cursorZ, ANY_TURN);
      expect(snap).toEqual({
        x: sideX + PLATE_SPAN / 2,
        z: straight.z,
        rot: 2,
        metCells: 32,
        joinedCells: 0,
        joinedRoadCells: 0,
      });
    }
  });

  it("never snaps a crossroads beside a straight's sidewalk, where every turn would butt a road end into it", () => {
    const crossroads = roadBaseplate("44343");
    const sideX = cellExtent(straight).maxX;
    for (const preferred of QUARTER_TURNS) {
      for (const cursorZ of [-260, 0, 300]) {
        const snap = snapToRoadEdge(
          roads,
          crossroads,
          preferred,
          1,
          ON_THE_TABLE,
          sideX + 300,
          cursorZ,
          ANY_TURN,
        );
        expect(snap).toBeNull();
      }
    }
  });

  it("snaps a clean road join whether or not a crossroads beside it is flush with its corner", () => {
    const turned: RoadPlacement = { ...straight, rot: 3 };
    for (const crossroadsX of [-640, -660, -720]) {
      const crossroads: RoadPlacement = {
        id: 1,
        x: crossroadsX,
        z: -PLATE_SPAN,
        yLdu: 0,
        rot: 3,
        surface: roadBaseplate("44343"),
      };
      const both = world([turned, crossroads]);
      const snap = snapToRoadEdge(both, straight.surface, 0, 1, ON_THE_TABLE, -400, -160, ANY_TURN);
      expect(snap).toMatchObject({ x: -PLATE_SPAN, z: 0, joinedRoadCells: 20 });
    }
  });

  it("never snaps a piece onto the footprint of a road plate raised above it, where the joining pose isn't there", () => {
    const raised: RoadPlacement = { ...straight, id: 1, z: PLATE_SPAN, yLdu: 8 };
    const both = world([straight, raised]);
    const raisedExtent = cellExtent(raised);
    const restingOnTheRaisedPlate: RestingHeights = {
      restingYLdu: (x, z, rot) => {
        const ghost = cellExtent({ ...straight, x, z, rot });
        const under =
          ghost.minX < raisedExtent.maxX &&
          ghost.maxX > raisedExtent.minX &&
          ghost.minZ < raisedExtent.maxZ &&
          ghost.maxZ > raisedExtent.minZ;
        return under ? raised.yLdu : 0;
      },
    };
    for (const preferred of QUARTER_TURNS) {
      const snap = snapToRoadEdge(
        both,
        straight.surface,
        preferred,
        1,
        restingOnTheRaisedPlate,
        0,
        openEnd + 200,
        ANY_TURN,
      );
      expect(snap).toBeNull();
    }
  });

  it("snaps a piece flush against a road plate at a sub-stud phase, joining its road end, never into it or short of it", () => {
    for (const offsetZ of [-7, 7]) {
      const offset: RoadPlacement = { ...straight, id: 1, x: PLATE_SPAN, z: PLATE_SPAN + offsetZ };
      const both = world([straight, offset]);
      const snap = snapToRoadEdge(
        both,
        straight.surface,
        0,
        1,
        ON_THE_TABLE,
        PLATE_SPAN + 80,
        0,
        ANY_TURN,
      );
      expect(snap).toEqual({
        x: PLATE_SPAN,
        z: offsetZ,
        rot: 0,
        metCells: 32,
        joinedCells: 32,
        joinedRoadCells: 20,
      });
    }
  });

  it("never snaps an 8-stud dual carriageway end onto a 6-stud road end, whatever the rotation", () => {
    const dual = roadBaseplate("30225b");
    for (const preferred of QUARTER_TURNS) {
      const snap = snapToRoadEdge(
        roads,
        dual,
        preferred,
        1,
        ON_THE_TABLE,
        0,
        openEnd + 200,
        ANY_TURN,
      );
      expect(snap).toBeNull();
    }
  });
});

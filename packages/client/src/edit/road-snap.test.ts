import { NO_STUD, RoadFit, RoadNetwork, type RoadPlacement, type RoadSurface } from "@brr/domain";
import { describe, expect, it } from "vitest";
import measured from "../../../../docs/verified-facts/geometry.json" with { type: "json" };
import { ANY_TURN, cellExtent, coveredCells, coversRoad, snapToRoadEdge } from "./road-snap.ts";

const STUD = 20;
const PLATE_SPAN = 640;
const QUARTER_TURNS = [0, 1, 2, 3];

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

function world(placements: ReadonlyArray<RoadPlacement>) {
  return { network: new RoadNetwork(placements), extents: placements.map(cellExtent) };
}

describe("road-edge snap", () => {
  const straight: RoadPlacement = {
    id: 0,
    x: 0,
    z: 0,
    yLdu: 0,
    rot: 0,
    surface: roadBaseplate("44336"),
  };
  const { network, extents } = world([straight]);
  const curve = roadBaseplate("44342");
  const openEnd = cellExtent(straight).maxZ;

  it("turns a curve to whichever quarter turn joins its lanes to an open straight end, from any starting rotation", () => {
    for (const preferred of QUARTER_TURNS) {
      const snap = snapToRoadEdge(
        network,
        extents,
        curve,
        preferred,
        1,
        0,
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
          network,
          extents,
          curve,
          preferred,
          1,
          0,
          0,
          openEnd + 200,
          ANY_TURN,
        );
        if (!first) throw new Error("the curve does not snap to the open end");
        const turned = (first.rot + direction + 4) % 4;
        const next = snapToRoadEdge(
          network,
          extents,
          curve,
          turned,
          direction,
          0,
          0,
          openEnd + 200,
          ANY_TURN,
        );
        expect(next?.rot).not.toBe(first.rot);
        expect(next?.joinedRoadCells).toBe(first.joinedRoadCells);
      }
    },
  );

  it("snaps a piece beside a sidewalk only flush with the neighbour's corner, never part-way along it", () => {
    const sideX = cellExtent(straight).maxX;
    for (const cursorZ of [-260, -60, 0, 140, 300]) {
      const snap = snapToRoadEdge(network, extents, curve, 0, 1, 0, sideX + 300, cursorZ, ANY_TURN);
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
          network,
          extents,
          crossroads,
          preferred,
          1,
          0,
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
      const snap = snapToRoadEdge(
        both.network,
        both.extents,
        straight.surface,
        0,
        1,
        0,
        -400,
        -160,
        ANY_TURN,
      );
      expect(snap).toMatchObject({ x: -PLATE_SPAN, z: 0, joinedRoadCells: 20 });
    }
  });

  it("never snaps a piece onto the footprint of a road plate raised above it, where the joining pose isn't there", () => {
    const raised: RoadPlacement = { ...straight, id: 1, z: PLATE_SPAN, yLdu: 8 };
    const both = world([straight, raised]);
    for (const preferred of QUARTER_TURNS) {
      const snap = snapToRoadEdge(
        both.network,
        both.extents,
        straight.surface,
        preferred,
        1,
        0,
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
        both.network,
        both.extents,
        straight.surface,
        0,
        1,
        0,
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

  it("counts the held piece's exact cells inside other road pieces' footprints once each, on every side and at any whole-LDU offset", () => {
    const ghost = cellExtent({ ...straight, x: 0, z: 0 });
    const piece = (x: number, z: number) => cellExtent({ ...straight, id: 1, x, z });
    const half = PLATE_SPAN / 2;
    expect(coveredCells([piece(half, 0)], ghost, 0, 0)).toBe(16 * 32);
    expect(coveredCells([piece(PLATE_SPAN, 0)], ghost, 0, 0)).toBe(0);
    expect(coveredCells([piece(PLATE_SPAN - 7, 0)], ghost, 0, 0)).toBe(32);
    expect(coveredCells([piece(PLATE_SPAN + 7, 0)], ghost, 0, 0)).toBe(0);
    expect(coveredCells([piece(PLATE_SPAN, 0)], ghost, 7, 0)).toBe(32);
    expect(coveredCells([piece(-(PLATE_SPAN - 7), 0)], ghost, 0, 0)).toBe(32);
    expect(coveredCells([piece(-PLATE_SPAN, 0)], ghost, -7, 0)).toBe(32);
    expect(coveredCells([piece(-PLATE_SPAN, 0)], ghost, 0, 0)).toBe(0);
    expect(coveredCells([piece(0, PLATE_SPAN - 7)], ghost, 0, 0)).toBe(32);
    expect(coveredCells([piece(0, -(PLATE_SPAN - 7))], ghost, 0, 0)).toBe(32);
    expect(coveredCells([piece(PLATE_SPAN, PLATE_SPAN)], ghost, 0, 0)).toBe(0);
    expect(coveredCells([piece(-2 * PLATE_SPAN, -2 * PLATE_SPAN)], ghost, 0, 0)).toBe(0);
    expect(
      coveredCells([piece(half, 0), piece(-2 * PLATE_SPAN, 2 * PLATE_SPAN)], ghost, 0, 0),
    ).toBe(16 * 32);
    expect(coveredCells([piece(7 - half, 0), piece(7 + half, 0)], ghost, 0, 0)).toBe(32 * 32);
  });

  it("finds a road footprint under the held piece down to a 1 LDU sliver on every side, and none flush beside it", () => {
    const ghost = cellExtent({ ...straight, x: 0, z: 0 });
    const piece = (x: number, z: number) => [cellExtent({ ...straight, id: 1, x, z })];
    const near = PLATE_SPAN - 1;
    const covering = [
      [near, 0],
      [-near, 0],
      [0, near],
      [0, -near],
      [near, near],
    ] as const;
    const clear = [
      [PLATE_SPAN, 0],
      [PLATE_SPAN + 1, 0],
      [-PLATE_SPAN, 0],
      [PLATE_SPAN, PLATE_SPAN],
      [near, -PLATE_SPAN],
    ] as const;
    for (const [x, z] of covering)
      expect(coversRoad(piece(x, z), ghost, 0, 0), `${x}, ${z}`).toBe(true);
    for (const [x, z] of clear)
      expect(coversRoad(piece(x, z), ghost, 0, 0), `${x}, ${z}`).toBe(false);
  });

  it("never snaps an 8-stud dual carriageway end onto a 6-stud road end, whatever the rotation", () => {
    const dual = roadBaseplate("30225b");
    for (const preferred of QUARTER_TURNS) {
      const snap = snapToRoadEdge(
        network,
        extents,
        dual,
        preferred,
        1,
        0,
        0,
        openEnd + 200,
        ANY_TURN,
      );
      expect(snap).toBeNull();
    }
  });
});

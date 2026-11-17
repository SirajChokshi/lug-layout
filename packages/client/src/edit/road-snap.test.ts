import { NO_STUD, RoadNetwork, type RoadPlacement, type RoadSurface } from "@brr/domain";
import { describe, expect, it } from "vitest";
import measured from "../../../../docs/verified-facts/geometry.json" with { type: "json" };
import { cellExtent, snapToRoadEdge } from "./road-snap.ts";

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
      const snap = snapToRoadEdge(network, extents, curve, preferred, 0, 0, openEnd + 200);
      expect(snap).not.toBeNull();
      if (!snap) continue;
      const fit = network.fit({
        id: 1,
        x: snap.x,
        z: snap.z,
        yLdu: 0,
        rot: snap.rot,
        surface: curve,
      });
      expect(fit.mismatchedCells).toBe(0);
      expect(fit.joinedRoadCells).toBeGreaterThan(0);
      expect(snap.joinedRoadCells).toBe(fit.joinedRoadCells);
      expect(snap.z - PLATE_SPAN / 2).toBe(openEnd);
    }
  });

  it("offers the curve's other lane-joining turn when the user asks for the next rotation", () => {
    const first = snapToRoadEdge(network, extents, curve, 0, 0, 0, openEnd + 200);
    expect(first).not.toBeNull();
    if (!first) return;
    const next = snapToRoadEdge(network, extents, curve, (first.rot + 1) % 4, 0, 0, openEnd + 200);
    expect(next?.rot).not.toBe(first.rot);
    expect(next?.joinedRoadCells).toBe(first.joinedRoadCells);
  });

  it("snaps a piece beside a sidewalk only flush with the neighbour's corner, never part-way along it", () => {
    const sideX = cellExtent(straight).maxX;
    for (const cursorZ of [-260, -60, 0, 140, 300]) {
      const snap = snapToRoadEdge(network, extents, curve, 0, 0, sideX + 300, cursorZ);
      expect(snap?.joinedRoadCells).toBe(0);
      expect(snap?.x).toBe(sideX + PLATE_SPAN / 2);
      expect(snap?.z).toBe(straight.z);
    }
  });

  it("never snaps an 8-stud dual carriageway end onto a 6-stud road end, whatever the rotation", () => {
    const dual = roadBaseplate("30225b");
    for (const preferred of QUARTER_TURNS) {
      const snap = snapToRoadEdge(network, extents, dual, preferred, 0, 0, openEnd + 200);
      expect(snap?.joinedRoadCells ?? 0).toBe(0);
    }
  });
});

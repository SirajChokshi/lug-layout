import { describe, expect, it } from "vitest";
import measured from "../../../docs/verified-facts/geometry.json" with { type: "json" };
import { NO_STUD, RoadNetwork, type RoadPlacement, type RoadSurface } from "./road-joins.ts";

interface MeasuredGeometry {
  readonly roadStudZones: ReadonlyArray<{
    readonly part: string;
    readonly map: ReadonlyArray<string>;
  }>;
  readonly recessedRoadPlates: ReadonlyArray<{
    readonly part: string;
    readonly thicknessLdu: number;
    readonly recessFloorBelowTopLdu: number;
    readonly studMap: ReadonlyArray<string>;
  }>;
}

const geometry: MeasuredGeometry = measured;
const STUD = 20;

function surfaceFromMap(
  map: ReadonlyArray<string>,
  cell: (stud: boolean) => [number, number, number],
): RoadSurface {
  const rows = map.length;
  const columns = map[0]?.length ?? 0;
  const top = new Int32Array(rows * columns);
  const stud = new Int32Array(rows * columns);
  const road = new Uint8Array(rows * columns);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const [t, s, r] = cell(map[row]?.[column] === "o");
      top[row * columns + column] = t;
      stud[row * columns + column] = s;
      road[row * columns + column] = r;
    }
  }
  return { minX: (-columns * STUD) / 2, minZ: (-rows * STUD) / 2, columns, rows, top, stud, road };
}

function recessedPlate(part: string): RoadSurface {
  const plate = geometry.recessedRoadPlates.find((entry) => entry.part === part);
  if (!plate) throw new Error(`${part} is not measured`);
  const top = plate.thicknessLdu;
  return surfaceFromMap(plate.studMap, (stud) => [
    top,
    stud ? top - plate.recessFloorBelowTopLdu : NO_STUD,
    1,
  ]);
}

function roadBaseplate(part: string): RoadSurface {
  const zones = geometry.roadStudZones.find((entry) => entry.part === part);
  if (!zones) throw new Error(`${part} is not measured`);
  return surfaceFromMap(zones.map, (stud) => (stud ? [0, 0, 0] : [0, NO_STUD, 1]));
}

function at(
  id: number,
  surface: RoadSurface,
  x: number,
  z: number,
  rot = 0,
  yLdu = 0,
): RoadPlacement {
  return { id, x, z, yLdu, rot, surface };
}

describe("road joins (layout rule 7)", () => {
  const plate = recessedPlate("69958");

  it("joins two abutted 69958 plates on every cell of the shared edge, in any order and turned a quarter", () => {
    const side = new RoadNetwork([at(0, plate, 0, 0), at(1, plate, 320, 0)]).report();
    const swapped = new RoadNetwork([at(0, plate, 320, 0), at(1, plate, 0, 0)]).report();
    const turned = new RoadNetwork([at(0, plate, 0, 0, 1), at(1, plate, 0, -320, 1)]).report();
    for (const report of [side, swapped, turned]) {
      expect(report.joinedCells).toBe(16);
      expect(report.mismatchedCells).toBe(0);
      expect(report.openCells).toBe(2 * 3 * 16);
    }
  });

  it("rejects the same plates shifted one stud along the shared edge, where the edge strips no longer line up", () => {
    const report = new RoadNetwork([at(0, plate, 0, 0), at(1, plate, 320, 20)]).report();
    expect(report.mismatchedCells).toBeGreaterThan(0);
    expect(report.joinedCells + report.mismatchedCells).toBe(15);
  });

  it("rejects a plate one plate higher than its neighbour", () => {
    const report = new RoadNetwork([at(0, plate, 0, 0), at(1, plate, 320, 0, 0, 8)]).report();
    expect(report.joinedCells).toBe(0);
    expect(report.mismatchedCells).toBe(16);
  });

  it("joins 6-stud road baseplate ends but rejects a 6-stud end against an 8-stud dual end", () => {
    const sixStud = roadBaseplate("44336");
    const dual = roadBaseplate("30225b");
    const same = new RoadNetwork([at(0, sixStud, 0, 0), at(1, sixStud, 0, 640)]).report();
    const mixed = new RoadNetwork([at(0, sixStud, 0, 0), at(1, dual, 0, 640)]).report();
    expect(same.joinedCells).toBe(32);
    expect(same.mismatchedCells).toBe(0);
    expect(mixed.mismatchedCells).toBeGreaterThan(0);
  });

  it("reports overlapping pieces and refuses them as a fit", () => {
    const network = new RoadNetwork([at(0, plate, 0, 0), at(1, plate, 160, 0)]);
    expect(network.report().overlaps).toEqual([[0, 1]]);
    expect(network.fit(at(2, plate, 0, 160)).overlappingCells).toBeGreaterThan(0);
    expect(new RoadNetwork([at(0, plate, 0, 0)]).fit(at(1, plate, 0, 320))).toEqual({
      joinedCells: 16,
      mismatchedCells: 0,
      overlappingCells: 0,
    });
  });
});

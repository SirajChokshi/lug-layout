import { isRot90, rot90Cos, rot90Sin } from "@brr/math";
import { describe, expect, it } from "vitest";
import measured from "../../../docs/verified-facts/geometry.json" with { type: "json" };
import {
  NO_STUD,
  NO_TOP,
  PLACEMENT_CELL_INTS,
  PLACEMENT_JOINED,
  PLACEMENT_MISMATCHED,
  RoadNetwork,
  placedCells,
  roadwayCells,
  type RoadJoinReport,
  type RoadPlacement,
  type RoadPlacementJoin,
  type RoadSide,
  type RoadSurface,
} from "./road-joins.ts";
import { RoadFit } from "./road-fit.ts";

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

type CellFacts = readonly [top: number, stud: number, road: number];

const geometry: MeasuredGeometry = measured;
const STUD = 20;
const PLATE = 8;
const CHUNK = 32 * STUD;
const SIXTEENTHS = 16;

function surfaceOf(
  columns: number,
  rows: number,
  cell: (column: number, row: number) => CellFacts,
): RoadSurface {
  const top = new Int32Array(rows * columns);
  const stud = new Int32Array(rows * columns);
  const road = new Uint8Array(rows * columns);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const [t, s, r] = cell(column, row);
      top[row * columns + column] = sixteenths(t, NO_TOP);
      stud[row * columns + column] = sixteenths(s, NO_STUD);
      road[row * columns + column] = r;
    }
  }
  return {
    minX: (-columns * STUD) / 2,
    minZ: (-rows * STUD) / 2,
    columns,
    rows,
    topSixteenths: top,
    studSixteenths: stud,
    road,
    occupied: Uint8Array.from(top, (t) => (t === NO_TOP ? 0 : 1)),
  };
}

function sixteenths(ldu: number, absent: number): number {
  return ldu === absent ? absent : ldu * SIXTEENTHS;
}

function surfaceFromMap(
  map: ReadonlyArray<string>,
  cell: (stud: boolean) => CellFacts,
): RoadSurface {
  return surfaceOf(map[0]?.length ?? 0, map.length, (column, row) =>
    cell(map[row]?.[column] === "o"),
  );
}

function strip(cells: ReadonlyArray<readonly [top: number, road: number]>): RoadSurface {
  return surfaceOf(1, cells.length, (_, row) => {
    const [top, road] = cells[row] ?? [0, 0];
    return [top, NO_STUD, road];
  });
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

function fitOf(network: RoadNetwork, candidate: RoadPlacement, into = new RoadFit()) {
  return { ...network.fit(candidate, into) };
}

function cleanFitOf(network: RoadNetwork, candidate: RoadPlacement, into = new RoadFit()) {
  const fit = network.cleanFit(candidate, into);
  return fit && { ...fit };
}

function cleanContactOf(network: RoadNetwork, candidate: RoadPlacement, into = new RoadFit()) {
  const fit = network.cleanContact(candidate, into);
  return fit && { ...fit };
}

function seamAt(report: RoadJoinReport, sides: readonly [RoadSide, RoadSide], line: number) {
  return report.segments.filter((s) => sides.includes(s.side) && s.line === line);
}

const ACROSS_X = ["minX", "maxX"] as const;
const ACROSS_Z = ["minZ", "maxZ"] as const;

const NO_FIT = {
  metCells: 0,
  equalCells: 0,
  joinedCells: 0,
  joinedRoadCells: 0,
  mismatchedCells: 0,
  overlappingCells: 0,
};

function joinedFit(cells: number, roadCells = cells) {
  return {
    ...NO_FIT,
    metCells: cells,
    equalCells: cells,
    joinedCells: cells,
    joinedRoadCells: roadCells,
  };
}

describe("road joins (layout rule 7)", () => {
  const plate = recessedPlate("69958");
  const plateTop = geometry.recessedRoadPlates.find((p) => p.part === "69958")?.thicknessLdu ?? 0;

  it("joins two abutted 69958 plates on every cell of the shared edge, in any order and turned a quarter", () => {
    const side = new RoadNetwork([at(0, plate, 0, 0), at(1, plate, 320, 0)]).report();
    const swapped = new RoadNetwork([at(0, plate, 320, 0), at(1, plate, 0, 0)]).report();
    const turned = new RoadNetwork([at(0, plate, 0, 0, 1), at(1, plate, 0, -320, 1)]).report();
    for (const report of [side, swapped, turned]) {
      expect(report.joinedCells).toBe(16);
      expect(report.mismatchedCells).toBe(0);
      expect(report.openCells).toBe(2 * 3 * 16);
      expect(Array.from(report.placementCells)).toEqual([16, 0, 0, 0]);
    }
  });

  it("joins road at a fractional top only to road at the same fractional top, and leaves it open beside whole-LDU road", () => {
    const fractionalTop = PLATE + 0.25;
    const raised = strip([
      [fractionalTop, 1],
      [fractionalTop, 1],
    ]);
    const level = strip([
      [PLATE, 1],
      [PLATE, 1],
    ]);
    const alike = new RoadNetwork([at(0, raised, 0, 0), at(1, raised, STUD, 0)]).report();
    const unlike = new RoadNetwork([at(0, raised, 0, 0), at(1, level, STUD, 0)]).report();
    expect(alike).toMatchObject({ joinedCells: 2, mismatchedCells: 0 });
    expect(unlike).toMatchObject({ joinedCells: 0, mismatchedCells: 0, overlaps: [] });
    expect(seamAt(unlike, ACROSS_X, STUD / 2).map((segment) => segment.topLdu)).toEqual([
      fractionalTop,
      PLATE,
    ]);
  });

  it("rejects the same plates shifted one stud along the shared edge, where the edge strips no longer line up", () => {
    const report = new RoadNetwork([at(0, plate, 0, 0), at(1, plate, 320, 20)]).report();
    expect(report.mismatchedCells).toBeGreaterThan(0);
    expect(report.joinedCells + report.mismatchedCells).toBe(15);
  });

  it("doesn't join a plate one plate higher than its neighbour; both edges at the step are open", () => {
    const report = new RoadNetwork([at(0, plate, 0, 0), at(1, plate, 320, 0, 0, PLATE)]).report();
    expect(report).toMatchObject({ joinedCells: 0, mismatchedCells: 0, openCells: 2 * 4 * 16 });
    expect(Array.from(report.placementCells)).toEqual([0, 0, 0, 0]);
    expect(seamAt(report, ACROSS_X, 160)).toEqual([
      expect.objectContaining({ placement: 0, side: "maxX", status: "open", topLdu: plateTop }),
      expect.objectContaining({
        placement: 1,
        side: "minX",
        status: "open",
        topLdu: plateTop + PLATE,
      }),
    ]);
  });

  it("joins 6-stud road baseplate ends but rejects a 6-stud end against an 8-stud dual end", () => {
    const sixStud = roadBaseplate("44336");
    const dual = roadBaseplate("30225b");
    const same = new RoadNetwork([at(0, sixStud, 0, 0), at(1, sixStud, 0, 640)]).report();
    const mixed = new RoadNetwork([at(0, sixStud, 0, 0), at(1, dual, 0, 640)]).report();
    expect(same.joinedCells).toBe(32);
    expect(same.mismatchedCells).toBe(0);
    expect(mixed.mismatchedCells).toBeGreaterThan(0);
    const sixStudEnd = fitOf(new RoadNetwork([at(0, sixStud, 0, 0)]), at(1, sixStud, 0, 640));
    expect(sixStudEnd).toEqual(joinedFit(32, 20));
  });

  it("leaves a road end against a baseplate's studded side open instead of mismatching it, and isn't a clean contact", () => {
    const sixStud = roadBaseplate("44336");
    const end = at(0, sixStud, 0, 0);
    const side = at(1, sixStud, 0, 640, 1);
    const report = new RoadNetwork([end, side]).report();
    expect(cleanFitOf(new RoadNetwork([end]), side)).toBeNull();
    expect(cleanContactOf(new RoadNetwork([end]), side)).toBeNull();
    expect(fitOf(new RoadNetwork([end]), side)).toEqual({
      ...NO_FIT,
      metCells: 32,
      equalCells: 12,
    });
    expect(report).toMatchObject({ joinedCells: 0, mismatchedCells: 0, openCells: 4 * 20 });
    expect(seamAt(report, ACROSS_Z, 320)).toEqual([
      expect.objectContaining({ placement: 0, side: "maxZ", from: -200, to: 200, status: "open" }),
    ]);
  });

  it("meets two road baseplates sidewalk to sidewalk without joining them: a clean contact, not a clean join", () => {
    const sixStud = roadBaseplate("44336");
    const beside = () => new RoadNetwork([at(0, sixStud, 0, 0)]);
    const neighbour = at(1, sixStud, 640, 0);
    const met = { ...NO_FIT, metCells: 32, equalCells: 32 };
    expect(cleanFitOf(beside(), neighbour)).toBeNull();
    expect(cleanContactOf(beside(), neighbour)).toEqual(met);
    expect(fitOf(beside(), neighbour)).toEqual(met);
    expect(new RoadNetwork([at(0, sixStud, 0, 0), neighbour]).report()).toMatchObject({
      joinedCells: 0,
      mismatchedCells: 0,
      openCells: 4 * 20,
    });
  });

  it("neither joins nor mismatches a model whose tiled edge stands higher than the road beside it", () => {
    const fenced = surfaceOf(8, 8, (column, row) => {
      const edge = column === 0 || row === 0 || column === 7 || row === 7;
      return edge ? [plateTop + 40, NO_STUD, 1] : [plateTop, NO_STUD, 1];
    });
    const report = new RoadNetwork([at(0, plate, 0, 0), at(1, fenced, 240, 0)]).report();
    expect(report).toMatchObject({ joinedCells: 0, mismatchedCells: 0, overlaps: [] });
    expect(seamAt(report, ACROSS_X, 160)).toEqual([
      expect.objectContaining({ placement: 0, side: "maxX", status: "open", topLdu: plateTop }),
      expect.objectContaining({
        placement: 1,
        side: "minX",
        status: "open",
        topLdu: plateTop + 40,
      }),
    ]);
  });

  it("leaves a model's road open beside its own lower cells, and joins a plate set flush into that recess", () => {
    const rimTop = 4 * PLATE;
    const pitTop = PLATE;
    const rimmed = surfaceOf(6, 6, (column, row) => {
      const rim = column === 0 || row === 0 || column === 5 || row === 5;
      return rim ? [rimTop, NO_STUD, 1] : [pitTop, pitTop, 0];
    });
    const inlay = surfaceOf(4, 4, () => [rimTop - pitTop, NO_STUD, 1]);
    const alone = new RoadNetwork([at(0, rimmed, 0, 0)]).report();
    const filled = new RoadNetwork([at(0, rimmed, 0, 0), at(1, inlay, 0, 0, 0, pitTop)]).report();
    expect(alone).toMatchObject({ joinedCells: 0, openCells: 4 * 4 + 4 * 6 });
    expect(filled).toMatchObject({
      joinedCells: 4 * 4,
      mismatchedCells: 0,
      openCells: 4 * 6,
      overlaps: [],
    });
  });

  it("leaves a model's road open only where a piece could be set beside it: not against its own walls, its own studless lower cells or its own columns whose top isn't on the lattice", () => {
    const wall: CellFacts = [5 * PLATE, NO_STUD, 0];
    const studlessBelow: CellFacts = [0, NO_STUD, 0];
    const studdedBelow: CellFacts = [0, 0, 0];
    const empty: CellFacts = [NO_TOP, NO_STUD, 0];
    const road: CellFacts = [PLATE, NO_STUD, 1];
    const layout: ReadonlyArray<ReadonlyArray<CellFacts>> = [
      [empty, studlessBelow, studdedBelow, empty, empty],
      [wall, road, road, road, empty],
      [empty, wall, studdedBelow, empty, empty],
    ];
    const unlatticedColumn = 1 * 5 + 4;
    const surface = surfaceOf(5, 3, (column, row) => layout[row]?.[column] ?? empty);
    const occupied = surface.occupied.slice();
    occupied[unlatticedColumn] = 1;
    const sidewalk = { ...surface, occupied };
    const report = new RoadNetwork([at(0, sidewalk, 0, 0)]).report();
    const open = report.segments.map(({ side, line, from, to }) => ({ side, line, from, to }));
    expect(report).toMatchObject({ joinedCells: 0, mismatchedCells: 0, openCells: 4 });
    expect(open.toSorted((a, b) => a.side.localeCompare(b.side))).toEqual([
      { side: "maxZ", line: 10, from: -10, to: 30 },
      { side: "minZ", line: -10, from: -10, to: 30 },
    ]);
  });

  it("gives a cell with no surface nothing to overlap or meet: an L-shaped surface's missing corner takes another piece flush", () => {
    const ell = surfaceOf(4, 4, (column, row) =>
      column >= 2 && row < 2 ? [NO_TOP, NO_STUD, 1] : [PLATE, NO_STUD, 1],
    );
    const corner = surfaceOf(2, 2, () => [PLATE, NO_STUD, 1]);
    const alone = new RoadNetwork([at(0, ell, 0, 0)]);
    expect(alone.report()).toMatchObject({ joinedCells: 0, openCells: 16, overlaps: [] });
    expect(fitOf(alone, at(1, corner, 20, -20))).toEqual(joinedFit(4));
    expect(fitOf(alone, at(1, ell, 80, 0))).toEqual(joinedFit(2));
    expect(new RoadNetwork([at(0, ell, 0, 0), at(1, corner, 20, -20)]).report()).toMatchObject({
      joinedCells: 4,
      openCells: 16,
      overlaps: [],
    });
    const cornerless = (missingColumn: number, missingRow: number) =>
      surfaceOf(2, 2, (column, row) =>
        column === missingColumn && row === missingRow ? [NO_TOP, NO_STUD, 0] : [PLATE, NO_STUD, 1],
      );
    const missingCornersMet = new RoadNetwork([
      at(0, cornerless(1, 0), 0, 0),
      at(1, cornerless(0, 1), 20, -20),
    ]).report();
    expect(missingCornersMet).toMatchObject({ joinedCells: 0, mismatchedCells: 0, overlaps: [] });
  });

  it("joins plates only where their cell edges coincide exactly, whatever whole-LDU pose they sit at", () => {
    const placed = new RoadNetwork([at(0, plate, 7, 3)]);
    expect(seamAt(placed.report(), ACROSS_X, 167)).toEqual([
      {
        placement: 0,
        side: "maxX",
        line: 167,
        from: -157,
        to: 163,
        topLdu: plateTop,
        status: "open",
      },
    ]);
    expect(fitOf(placed, at(1, plate, 327, 3))).toEqual(joinedFit(16));
    for (const [x, z] of [
      [317, 3],
      [326, 3],
      [328, 3],
      [337, 3],
      [327, 4],
      [327, 12],
      [327, 22],
    ] as const) {
      expect(fitOf(placed, at(1, plate, x, z)), `at ${x}, ${z}`).toEqual(NO_FIT);
    }
    const stud = fitOf(placed, at(1, plate, 327, 23));
    expect(stud.mismatchedCells).toBeGreaterThan(0);
    expect(stud.joinedCells + stud.mismatchedCells).toBe(15);
  });

  it("refuses a pose that isn't whole LDU", () => {
    expect(() => new RoadNetwork([at(0, plate, 0.5, 0)])).toThrow(RangeError);
    expect(() => new RoadNetwork([]).fit(at(0, plate, 0, 0, 0, 0.25), new RoadFit())).toThrow(
      RangeError,
    );
  });

  it("refuses a height whose sixteenths would wrap, instead of joining road far above to road far below", () => {
    const wraps = 2 ** 27;
    expect(() => new RoadNetwork([at(0, plate, 0, 0, 0, wraps)])).toThrow(RangeError);
    expect(() =>
      new RoadNetwork([at(0, plate, 0, 0, 0, -wraps)]).fit(
        at(1, plate, 640, 0, 0, wraps),
        new RoadFit(),
      ),
    ).toThrow(RangeError);
    expect(() => new RoadNetwork([at(0, plate, 0, 0, 0, wraps - 1)])).not.toThrow();
  });

  it("keeps surfaces stacked at different tops apart: they neither overlap nor join, and a join beside them stands", () => {
    const network = new RoadNetwork([
      at(0, plate, 0, 0),
      at(1, plate, 320, 0),
      at(2, plate, 0, 0, 0, plateTop),
    ]);
    const report = network.report();
    expect(report).toMatchObject({ joinedCells: 16, mismatchedCells: 0, overlaps: [] });
    expect(fitOf(network, at(3, plate, 320, 0, 0, plateTop))).toEqual(joinedFit(16));
  });

  it("joins four plates stacked on one road baseplate, whose block holds hundreds of stacked cells", () => {
    const base = roadBaseplate("44336");
    const alone = new RoadNetwork([at(0, base, 320, 320)]).report();
    const stacked = new RoadNetwork([
      at(0, base, 320, 320),
      at(1, plate, 160, 160),
      at(2, plate, 480, 160),
      at(3, plate, 160, 480),
      at(4, plate, 480, 480),
    ]).report();
    expect(stacked).toMatchObject({
      joinedCells: 4 * 16,
      mismatchedCells: 0,
      openCells: alone.openCells + 4 * 2 * 16,
      overlaps: [],
    });
  });

  it("reports overlapping pieces and refuses them as a fit, leaving the caller's result empty", () => {
    const overlapping = () => new RoadNetwork([at(0, plate, 0, 0), at(1, plate, 160, 0)]);
    expect(overlapping().report().overlaps).toEqual([[0, 1]]);
    const twice = new RoadNetwork([at(0, plate, 0, 0), at(1, plate, 160, 0), at(2, plate, 0, 160)]);
    expect(twice.report().overlaps).toEqual([
      [0, 1],
      [0, 2],
      [1, 2],
    ]);
    const reused = new RoadFit();
    overlapping().fit(at(2, plate, 0, 320), reused);
    expect(cleanFitOf(overlapping(), at(2, plate, 0, 160), reused)).toBeNull();
    expect({ ...reused }).toEqual(NO_FIT);
    overlapping().fit(at(2, plate, 0, 320), reused);
    expect(cleanContactOf(overlapping(), at(2, plate, 0, 160), reused)).toBeNull();
    expect({ ...reused }).toEqual(NO_FIT);
    expect(fitOf(overlapping(), at(2, plate, 0, 160)).overlappingCells).toBeGreaterThan(0);
    const single = () => new RoadNetwork([at(0, plate, 0, 0)]);
    expect(cleanFitOf(single(), at(1, plate, 0, 320))).toEqual(joinedFit(16));
    expect(fitOf(single(), at(1, plate, 0, 320))).toEqual(joinedFit(16));
    expect(cleanFitOf(single(), at(1, plate, 0, 320, 0, PLATE))).toBeNull();
    expect(cleanFitOf(single(), at(1, plate, 0, 640))).toBeNull();
  });

  it("refuses a pose it has already fitted as a clean join or contact when that fit mismatches or overlaps", () => {
    const network = new RoadNetwork([at(0, plate, 0, 0)]);
    for (const pose of [at(1, plate, 320, 20), at(1, plate, 160, 0)]) {
      const fit = fitOf(network, pose);
      expect(fit.mismatchedCells + fit.overlappingCells).toBeGreaterThan(0);
      expect(cleanFitOf(network, pose)).toBeNull();
      expect(cleanContactOf(network, pose)).toBeNull();
    }
  });

  it("joins, overlaps and fits against pieces added one at a time after construction", () => {
    const network = new RoadNetwork([]);
    network.add(at(0, plate, 0, 0));
    network.add(at(1, plate, 320, 0));
    const abutted = network.report();
    network.add(at(2, plate, 960, 0));

    expect(abutted).toMatchObject({ placements: 2, joinedCells: 16, mismatchedCells: 0 });
    expect(fitOf(network, at(3, plate, 640, 0))).toEqual(joinedFit(32));
    expect(fitOf(network, at(3, plate, 320, 320, 0, PLATE))).toEqual(NO_FIT);
    network.add(at(3, plate, 1120, 0));
    expect(network.report().overlaps).toEqual([[2, 3]]);
  });

  it("forgets its remembered fits on clear, so a pose asked before and after reads the network as it is", () => {
    const network = new RoadNetwork([at(0, plate, 0, 0)]);
    const beside = at(1, plate, 320, 0);
    const before = fitOf(network, beside);
    network.clear();
    expect(before).toEqual(joinedFit(16));
    expect(fitOf(network, beside)).toEqual(NO_FIT);
    expect(cleanContactOf(network, beside)).toBeNull();
  });

  it("answers two surfaces asked at the same pose on one network each by its own cells", () => {
    const network = new RoadNetwork([at(0, plate, 0, 0)]);
    const sidewalk = surfaceOf(16, 16, () => [plateTop, NO_STUD, 0]);
    const asPlate = fitOf(network, at(1, plate, 320, 0));
    const asSidewalk = fitOf(network, at(1, sidewalk, 320, 0));
    expect(asPlate).toEqual(joinedFit(16));
    expect(asSidewalk).toEqual(
      fitOf(new RoadNetwork([at(0, plate, 0, 0)]), at(1, sidewalk, 320, 0)),
    );
    expect(asSidewalk).not.toEqual(asPlate);
    expect(fitOf(network, at(1, plate, 320, 0))).toEqual(joinedFit(16));
  });

  it("answers the same pose on two networks with different pieces each by its own pieces", () => {
    const pose = at(9, plate, 320, 0);
    const joined = new RoadNetwork([at(0, plate, 0, 0)]);
    const apart = new RoadNetwork([at(0, plate, 0, 0, 0, PLATE)]);
    expect(fitOf(joined, pose)).toEqual(joinedFit(16));
    expect(fitOf(apart, pose)).toEqual(NO_FIT);
    expect(fitOf(joined, pose)).toEqual(joinedFit(16));
  });

  it("fits beside the lowest and the highest of five plates stacked in one block", () => {
    const stack = [0, 1, 2, 3, 4].map((level) => at(level, plate, 160, 160, 0, level * plateTop));
    const network = new RoadNetwork(stack);
    expect(fitOf(network, at(5, plate, 480, 160))).toEqual(joinedFit(16));
    expect(fitOf(network, at(5, plate, 480, 160, 0, 4 * plateTop))).toEqual(joinedFit(16));
  });

  it("fits a plate raised off the table beside another raised the same height, where nothing sits at table height", () => {
    const raised = 3 * PLATE;
    const network = new RoadNetwork([at(0, plate, 0, 0, 0, raised)]);
    expect(fitOf(network, at(1, plate, 320, 0, 0, raised))).toEqual(joinedFit(16));
    expect(fitOf(network, at(1, plate, 320, 0))).toEqual(NO_FIT);
  });

  it("gives the roadway as the network's exact road squares, leaving out absent and sidewalk cells", () => {
    const corner = surfaceOf(2, 2, (column, row) =>
      column === 1 && row === 0
        ? [NO_TOP, NO_STUD, 1]
        : [PLATE, NO_STUD, column === 0 && row === 1 ? 0 : 1],
    );
    const placement = at(0, corner, 7, 3);
    expect(placedCells(placement)).toHaveLength(3);
    expect(roadwayCells(placement)).toEqual([
      { minX: -13, minZ: -17, maxX: 7, maxZ: 3 },
      { minX: 7, minZ: 3, maxX: 27, maxZ: 23 },
    ]);
    const tile = surfaceOf(1, 1, () => [PLATE, NO_STUD, 1]);
    expect(fitOf(new RoadNetwork([placement]), at(1, tile, 37, 13))).toEqual(joinedFit(1));
  });

  it("forgets every piece on clear, and joins pieces added afterwards as if it were new", () => {
    const network = new RoadNetwork([at(0, plate, 0, 0), at(1, plate, 160, 0)]);
    network.clear();
    const cleared = { report: network.report(), fit: fitOf(network, at(2, plate, 0, 0)) };
    network.add(at(3, plate, 320, 0));

    expect(cleared.report).toMatchObject({ placements: 0, joinedCells: 0, overlaps: [] });
    expect(cleared.fit).toEqual(NO_FIT);
    expect(fitOf(network, at(4, plate, 0, 0))).toEqual(joinedFit(16));
  });
});

describe("seam runs", () => {
  const T = PLATE;

  it("ends a seam run at a gap: road on one side before it and on the other side after it stays open", () => {
    const left = strip([
      [T, 1],
      [T, 0],
      [T, 0],
    ]);
    const right = strip([
      [T, 0],
      [T + PLATE, 0],
      [T, 1],
    ]);
    const report = new RoadNetwork([at(0, left, 0, 0), at(1, right, STUD, 0)]).report();
    expect(report).toMatchObject({ joinedCells: 0, mismatchedCells: 0 });
  });

  it("keeps a seam run going across a change of top both sides make: road on one side below it and on the other above it mismatches", () => {
    const left = strip([
      [T, 1],
      [T + PLATE, 0],
    ]);
    const right = strip([
      [T, 0],
      [T + PLATE, 1],
    ]);
    const report = new RoadNetwork([at(0, left, 0, 0), at(1, right, STUD, 0)]).report();
    expect(report).toMatchObject({ joinedCells: 0, mismatchedCells: 2 });
  });

  it("fits cleanly beside a gapped one-sided run when the other side joins", () => {
    const gapped = strip([
      [T, 0],
      [T + PLATE, 0],
      [T, 1],
    ]);
    const lead = strip([
      [T, 1],
      [T, 0],
      [T, 0],
    ]);
    const network = () => new RoadNetwork([at(0, lead, 0, 0), at(1, gapped, 2 * STUD, 0)]);
    const clean = cleanFitOf(network(), at(2, gapped, STUD, 0));
    const fit = fitOf(network(), at(2, gapped, STUD, 0));
    expect(fit).toMatchObject({ joinedCells: 3, mismatchedCells: 0, overlappingCells: 0 });
    expect(clean).toEqual(fit);
  });

  it("fits cleanly when one seam meets a sidewalk on one neighbour and joins road on the next", () => {
    const one = (road: number) => strip([[T, road]]);
    const network = () => new RoadNetwork([at(0, one(0), 0, 0), at(1, one(1), 0, STUD)]);
    const candidate = at(
      2,
      strip([
        [T, 1],
        [T, 1],
      ]),
      STUD,
      STUD / 2,
    );
    const clean = cleanFitOf(network(), candidate);
    const fit = fitOf(network(), candidate);
    expect(fit).toMatchObject({ joinedCells: 1, mismatchedCells: 0, overlappingCells: 0 });
    expect(clean).toEqual(fit);
  });
});

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function pick<T>(random: () => number, choices: ReadonlyArray<T>): T {
  const choice = choices[Math.floor(random() * choices.length)];
  if (choice === undefined) throw new Error("nothing to pick from");
  return choice;
}

function randomSurface(random: () => number): RoadSurface {
  const columns = 1 + Math.floor(random() * 4);
  const rows = 1 + Math.floor(random() * 4);
  const top = new Int32Array(rows * columns);
  const stud = new Int32Array(rows * columns);
  const road = new Uint8Array(rows * columns);
  for (let cell = 0; cell < rows * columns; cell++) {
    top[cell] = random() < 0.15 ? NO_TOP : pick(random, [PLATE, 2 * PLATE]) * SIXTEENTHS;
    road[cell] = random() < 0.6 ? 1 : 0;
    stud[cell] = pick(random, [NO_STUD, top[cell] ?? 0, (top[cell] ?? 0) - PLATE * SIXTEENTHS]);
  }
  const minX = -STUD * Math.floor(random() * columns);
  const minZ = -STUD * Math.floor(random() * rows);
  const occupied = Uint8Array.from(top, (t) => (t === NO_TOP ? 0 : 1));
  return { minX, minZ, columns, rows, topSixteenths: top, studSixteenths: stud, road, occupied };
}

const PHASES = [0, 3, 10, 17];

function randomLayout(random: () => number, phased: boolean): ReadonlyArray<RoadPlacement> {
  const count = 2 + Math.floor(random() * 5);
  const surfaces = [randomSurface(random), randomSurface(random), randomSurface(random)];
  const shared = [pick(random, PHASES), pick(random, PHASES)] as const;
  const phase = (axis: 0 | 1) =>
    !phased ? 0 : random() < 0.9 ? shared[axis] : pick(random, PHASES);
  const coordinate = (axis: 0 | 1) => STUD * Math.floor(random() * 7 - 3) + phase(axis);
  return Array.from({ length: count }, (_, id) =>
    at(
      id,
      pick(random, surfaces),
      coordinate(0),
      coordinate(1),
      Math.floor(random() * 4),
      pick(random, [0, PLATE]),
    ),
  );
}

function shuffled<T>(random: () => number, items: ReadonlyArray<T>): ReadonlyArray<T> {
  const order = [...items];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j] as T, order[i] as T];
  }
  return order;
}

function turnedQuarter(placement: RoadPlacement): RoadPlacement {
  return { ...placement, x: placement.z, z: -placement.x, rot: (placement.rot + 1) % 4 };
}

function moved(placement: RoadPlacement, dx: number, dz: number, idShift = 0): RoadPlacement {
  return { ...placement, id: placement.id + idShift, x: placement.x + dx, z: placement.z + dz };
}

function counts(report: RoadJoinReport) {
  const { joinedCells, openCells, mismatchedCells } = report;
  return { joinedCells, openCells, mismatchedCells };
}

function cellsById(placements: ReadonlyArray<RoadPlacement>, report: RoadJoinReport) {
  return placements
    .map((placement, p) => {
      const joined = report.placementCells[p * PLACEMENT_CELL_INTS + PLACEMENT_JOINED] ?? 0;
      const mismatched = report.placementCells[p * PLACEMENT_CELL_INTS + PLACEMENT_MISMATCHED] ?? 0;
      return `${placement.id} ${joined} ${mismatched}`;
    })
    .toSorted();
}

function columnSum(report: RoadJoinReport, column: number): number {
  let sum = 0;
  for (let cell = column; cell < report.placementCells.length; cell += PLACEMENT_CELL_INTS) {
    sum += report.placementCells[cell] ?? 0;
  }
  return sum;
}

function segmentKeys(report: RoadJoinReport): ReadonlyArray<string> {
  return report.segments
    .map((s) => `${s.placement} ${s.side} ${s.line} ${s.from} ${s.to} ${s.topLdu} ${s.status}`)
    .toSorted();
}

function shapeKeys(report: RoadJoinReport): ReadonlyArray<string> {
  return report.segments
    .map((s) => `${s.placement} ${s.to - s.from} ${s.topLdu} ${s.status}`)
    .toSorted();
}

const OPPOSITE = { minX: "maxX", maxX: "minX", minZ: "maxZ", maxZ: "minZ" } as const;
const DIRECTIONS = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
] as const;

function squaresOf(placement: RoadPlacement): ReadonlyMap<string, string> {
  const { surface, rot } = placement;
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn`);
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const squares = new Map<string, string>();
  for (let row = 0; row < surface.rows; row++) {
    for (let column = 0; column < surface.columns; column++) {
      const index = row * surface.columns + column;
      const top = surface.topSixteenths[index] ?? NO_TOP;
      if (top === NO_TOP) continue;
      const stud = surface.studSixteenths[index] ?? NO_STUD;
      const raisedStud = stud === NO_STUD ? NO_STUD : stud + placement.yLdu * SIXTEENTHS;
      const localX = surface.minX + column * STUD + STUD / 2;
      const localZ = surface.minZ + row * STUD + STUD / 2;
      const centreX = placement.x + cos * localX + sin * localZ;
      const centreZ = placement.z - sin * localX + cos * localZ;
      squares.set(
        `${centreX} ${centreZ} ${top + placement.yLdu * SIXTEENTHS}`,
        `${surface.road[index] ?? 0} ${raisedStud}`,
      );
    }
  }
  return squares;
}

function squareBeside(square: string, dx: number, dz: number): string {
  const [x = 0, z = 0, top = 0] = square.split(" ").map(Number);
  return `${x + dx * STUD} ${z + dz * STUD} ${top}`;
}

function overlappingSquares(network: ReadonlyArray<RoadPlacement>, candidate: RoadPlacement) {
  const placed = new Set(network.flatMap((placement) => [...squaresOf(placement).keys()]));
  return [...squaresOf(candidate).keys()].filter((square) => placed.has(square)).length;
}

function overlapPairs(placements: ReadonlyArray<RoadPlacement>) {
  const squares = placements.map((placement) => new Set(squaresOf(placement).keys()));
  const pairs: Array<readonly [number, number]> = [];
  placements.forEach((a, i) => {
    placements.forEach((b, j) => {
      if (j <= i || ![...(squares[i] ?? [])].some((square) => squares[j]?.has(square))) return;
      pairs.push([Math.min(a.id, b.id), Math.max(a.id, b.id)]);
    });
  });
  return pairs.toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
}

function meetingSquares(network: ReadonlyArray<RoadPlacement>, candidate: RoadPlacement) {
  const own = squaresOf(candidate);
  const holders = network.map(squaresOf);
  let met = 0;
  let equal = 0;
  for (const [square, facts] of own) {
    for (const [dx, dz] of DIRECTIONS) {
      const beside = squareBeside(square, dx, dz);
      if (own.has(beside)) continue;
      for (const held of holders) {
        if (!held.has(beside) || held.has(square)) continue;
        met++;
        if (held.get(beside) === facts) equal++;
      }
    }
  }
  return { met, equal };
}

function movedSegmentKeys(report: RoadJoinReport, dx: number, dz: number): ReadonlyArray<string> {
  return report.segments
    .map((s) => {
      const acrossX = s.side === "minX" || s.side === "maxX";
      const line = s.line + (acrossX ? dx : dz);
      const shift = acrossX ? dz : dx;
      return `${s.placement} ${s.side} ${line} ${s.from + shift} ${s.to + shift} ${s.topLdu} ${s.status}`;
    })
    .toSorted();
}

describe("road joins on seeded layouts", () => {
  const LAYOUTS = 400;

  it("gives every joined or mismatched edge cell a facing cell of another placement with the same status", () => {
    const random = seeded(7);
    for (let layout = 0; layout < LAYOUTS; layout++) {
      const report = new RoadNetwork(randomLayout(random, true)).report();
      const units = new Map<string, Set<number>>();
      for (const s of report.segments) {
        for (let along = s.from; along < s.to; along += STUD) {
          const key = `${s.side} ${s.line} ${along} ${s.topLdu} ${s.status}`;
          units.set(key, (units.get(key) ?? new Set()).add(s.placement));
        }
      }
      for (const s of report.segments) {
        if (s.status === "open") continue;
        for (let along = s.from; along < s.to; along += STUD) {
          const facing = units.get(
            `${OPPOSITE[s.side]} ${s.line} ${along} ${s.topLdu} ${s.status}`,
          );
          expect([...(facing ?? [])].some((placement) => placement !== s.placement)).toBe(true);
        }
      }
    }
  });

  it("reports the same joins, open cells, mismatches, overlaps and per-placement road cells whatever order the pieces are placed in, the per-placement cells summing to the totals", () => {
    const random = seeded(11);
    for (let layout = 0; layout < LAYOUTS; layout++) {
      const placements = randomLayout(random, true);
      const order = shuffled(random, placements);
      const forward = new RoadNetwork(placements).report();
      const reordered = new RoadNetwork(order).report();
      expect(counts(reordered)).toEqual(counts(forward));
      expect(reordered.overlaps).toEqual(forward.overlaps);
      expect(segmentKeys(reordered)).toEqual(segmentKeys(forward));
      expect(cellsById(order, reordered)).toEqual(cellsById(placements, forward));
      expect(columnSum(forward, PLACEMENT_JOINED)).toBe(forward.joinedCells);
      expect(columnSum(forward, PLACEMENT_MISMATCHED)).toBe(2 * forward.mismatchedCells);
    }
  });

  it("reports the same joins, open cells, mismatches and overlaps after turning the whole layout a quarter", () => {
    const random = seeded(13);
    for (let layout = 0; layout < LAYOUTS; layout++) {
      const placements = randomLayout(random, true);
      const report = new RoadNetwork(placements).report();
      const turned = new RoadNetwork(placements.map(turnedQuarter)).report();
      expect(counts(turned)).toEqual(counts(report));
      expect(turned.overlaps).toEqual(report.overlaps);
      expect(shapeKeys(turned)).toEqual(shapeKeys(report));
    }
  });

  it("reports the same joins, open cells, mismatches and overlaps after moving the whole layout by any whole number of LDU", () => {
    const random = seeded(23);
    for (let layout = 0; layout < LAYOUTS; layout++) {
      const placements = randomLayout(random, true);
      const dx = Math.floor(random() * 1400) - 700;
      const dz = Math.floor(random() * 1400) - 700;
      const report = new RoadNetwork(placements).report();
      const shifted = new RoadNetwork(placements.map((p) => moved(p, dx, dz))).report();
      expect(counts(shifted)).toEqual(counts(report));
      expect(shifted.overlaps).toEqual(report.overlaps);
      expect(segmentKeys(shifted)).toEqual(movedSegmentKeys(report, dx, dz));
    }
  });

  it("reports a layout and a copy of it four chunks away as exactly twice the layout", () => {
    const random = seeded(29);
    for (let layout = 0; layout < LAYOUTS; layout++) {
      const placements = randomLayout(random, true);
      const far = 4 * CHUNK * pick(random, [1, -1]);
      const [dx, dz] = pick(random, [
        [far, 0],
        [0, far],
        [far, -far],
      ] as const);
      const copy = placements.map((p) => moved(p, dx, dz, placements.length));
      const one = counts(new RoadNetwork(placements).report());
      const two = counts(new RoadNetwork([...placements, ...copy]).report());
      expect(two).toEqual({
        joinedCells: 2 * one.joinedCells,
        openCells: 2 * one.openCells,
        mismatchedCells: 2 * one.mismatchedCells,
      });
    }
  });

  it("fits a candidate to the squares it meets and overlaps and to exactly what adding it would change in the report, and gates clean joins and clean contacts on that fit", () => {
    const random = seeded(17);
    for (let layout = 0; layout < LAYOUTS; layout++) {
      const placements = randomLayout(random, true);
      const placed = placements.slice(0, -1);
      const candidate = placements.at(-1);
      if (!candidate) throw new Error("a layout has a candidate");
      const before = new RoadNetwork(placed).report();
      const after = new RoadNetwork(placements).report();
      expect(after.overlaps).toEqual(overlapPairs(placements));
      const fit = fitOf(new RoadNetwork(placed), candidate);
      const meeting = meetingSquares(placed, candidate);
      expect(fit).toMatchObject({
        metCells: meeting.met,
        equalCells: meeting.equal,
        joinedCells: after.joinedCells - before.joinedCells,
        mismatchedCells: after.mismatchedCells - before.mismatchedCells,
        overlappingCells: overlappingSquares(placed, candidate),
      });
      const clean = fit.mismatchedCells === 0 && fit.overlappingCells === 0;
      const flush = fit.metCells > 0 && fit.equalCells === fit.metCells;
      expect(cleanFitOf(new RoadNetwork(placed), candidate)).toEqual(
        clean && fit.joinedCells > 0 ? fit : null,
      );
      expect(cleanContactOf(new RoadNetwork(placed), candidate)).toEqual(
        clean && flush ? fit : null,
      );
    }
  });

  it("answers many poses, asked in mixed order on one network with one reused result, as fresh networks do", () => {
    const random = seeded(19);
    const reused = new RoadFit();
    const asks = [fitOf, cleanFitOf, cleanContactOf];
    for (let layout = 0; layout < LAYOUTS / 4; layout++) {
      const placements = randomLayout(random, true);
      const placed = placements.slice(0, -1);
      const candidate = placements.at(-1);
      if (!candidate) throw new Error("a layout has a candidate");
      const shared = new RoadNetwork(placed);
      for (let probe = 0; probe < 48; probe++) {
        const pose = {
          ...candidate,
          x: candidate.x + STUD * Math.floor(random() * 5 - 2),
          z: candidate.z + STUD * Math.floor(random() * 5 - 2),
          rot: Math.floor(random() * 4),
          yLdu: pick(random, [0, PLATE]),
        };
        const ask = pick(random, asks);
        expect(ask(shared, pose, reused)).toEqual(ask(new RoadNetwork(placed), pose));
      }
    }
  });

  it("reports and fits a network cleared and filled again exactly as one built fresh from the same pieces", () => {
    const random = seeded(31);
    const reused = new RoadNetwork([]);
    for (let layout = 0; layout < LAYOUTS; layout++) {
      const placements = randomLayout(random, true);
      const placed = placements.slice(0, -1);
      const candidate = placements.at(-1);
      if (!candidate) throw new Error("a layout has a candidate");
      reused.clear();
      for (const placement of placed) reused.add(placement);
      const fresh = new RoadNetwork(placed);
      expect(segmentKeys(reused.report())).toEqual(segmentKeys(fresh.report()));
      expect(reused.report().overlaps).toEqual(fresh.report().overlaps);
      expect(fitOf(reused, candidate)).toEqual(fitOf(fresh, candidate));
    }
  });
});

const NETWORKS = 2000;
const DIFFERENTIAL_TIMEOUT_MS = 30_000;
const MAX_STEPS = 12;
const HALF_STUD_LDU = STUD / 2;
const QUARTER_TURNS = 4;
const STEPS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];

function everySurface(): ReadonlyArray<RoadSurface> {
  return [
    ...geometry.recessedRoadPlates.map((plate) => recessedPlate(plate.part)),
    ...geometry.roadStudZones.map((zones) => roadBaseplate(zones.part)),
  ];
}

function strokeNetwork(
  random: () => number,
  surfaces: ReadonlyArray<RoadSurface>,
): RoadPlacement[] {
  const surface = pick(random, surfaces);
  const tileLdu = surface.columns * STUD;
  const placements: RoadPlacement[] = [];
  const visited: Array<readonly [number, number]> = [];
  let x = 0;
  let z = 0;
  let step = pick(random, STEPS);
  const steps = 2 + Math.floor(random() * (MAX_STEPS - 1));
  for (let k = 0; k < steps; k++) {
    const roll = random();
    if (roll < 0.25) step = pick(random, STEPS);
    if (roll > 0.85 && visited.length > 0) [x, z] = pick(random, visited);
    x += step[0] * tileLdu;
    z += step[1] * tileLdu;
    visited.push([x, z]);
    if (random() < 0.12) continue;
    const offLattice = random() < 0.08 ? HALF_STUD_LDU : 0;
    const overlap = random() < 0.08 ? tileLdu / 2 : 0;
    placements.push({
      id: 0,
      x: x + offLattice + overlap,
      z,
      yLdu: random() < 0.15 ? 8 : 0,
      rot: Math.floor(random() * QUARTER_TURNS),
      surface: random() < 0.1 ? pick(random, surfaces) : surface,
    });
  }
  const ids = placements.map((_, k) => 3 * k + Math.floor(random() * 3));
  for (let k = ids.length - 1; k > 0; k--) {
    const other = Math.floor(random() * (k + 1));
    [ids[k], ids[other]] = [ids[other] ?? 0, ids[k] ?? 0];
  }
  return placements.map((placement, k) => ({ ...placement, id: ids[k] ?? 0 }));
}

function joinFromReport(report: RoadJoinReport, id: number): RoadPlacementJoin {
  const overlap = report.overlaps.find(([a, b]) => a === id || b === id);
  return {
    mismatched: report.segments.some((s) => s.placement === id && s.status === "mismatch"),
    overlapPartner: overlap ? (overlap[0] === id ? overlap[1] : overlap[0]) : null,
  };
}

describe("placementJoin", () => {
  it(
    "equals a fresh report's mismatch and first overlap for every placement of 2,000 generated road strokes, from one refilled network",
    () => {
      const random = seeded(0x60ad);
      const surfaces = everySurface();
      const reused = new RoadNetwork([]);
      const seen = { mismatched: 0, overlapped: 0, clean: 0 };
      for (let n = 0; n < NETWORKS; n++) {
        const placements = strokeNetwork(random, surfaces);
        const report = new RoadNetwork(placements).report();
        reused.clear();
        for (const placement of placements) reused.add(placement);
        for (const { id } of placements) {
          const expected = joinFromReport(report, id);
          expect(reused.placementJoin(id)).toEqual(expected);
          if (expected.mismatched) seen.mismatched++;
          if (expected.overlapPartner !== null) seen.overlapped++;
          if (!expected.mismatched && expected.overlapPartner === null) seen.clean++;
        }
      }
      expect(seen.mismatched).toBeGreaterThan(0);
      expect(seen.overlapped).toBeGreaterThan(0);
      expect(seen.clean).toBeGreaterThan(0);
    },
    DIFFERENTIAL_TIMEOUT_MS,
  );
});

const EDIT_SEQUENCES = 300;
const EDITS_PER_SEQUENCE = 24;
const FAR_LDU = 4 * CHUNK;

function placementsOf(random: () => number, surfaces: ReadonlyArray<RoadSurface>): RoadPlacement[] {
  const strokes = strokeNetwork(random, surfaces);
  const phased = randomLayout(random, true).map((placement) => ({
    ...placement,
    id: 1000 + placement.id,
  }));
  return [...strokes, ...phased];
}

function probeNear(random: () => number, around: RoadPlacement): RoadPlacement {
  return {
    ...around,
    x: around.x + STUD * Math.floor(random() * 7 - 3),
    z: around.z + STUD * Math.floor(random() * 7 - 3),
    rot: Math.floor(random() * QUARTER_TURNS),
    yLdu: pick(random, [0, PLATE]),
  };
}

function earliestWithId(live: ReadonlyArray<RoadPlacement>, id: number): number {
  return live.findIndex((placement) => placement.id === id);
}

describe("road network kept up to date by adds and removes", () => {
  it(
    "reports, fits and joins after every one or two adds and removes of 300 generated edit sequences exactly as a network built fresh from the pieces left, in the order they were added",
    () => {
      const random = seeded(0x1ead);
      const surfaces = everySurface();
      const asks = [fitOf, cleanFitOf, cleanContactOf];
      const seen = { removed: 0, sharedIds: 0, overlaps: 0, joined: 0, far: 0 };
      for (let sequence = 0; sequence < EDIT_SEQUENCES; sequence++) {
        const pool = placementsOf(random, surfaces);
        const live: RoadPlacement[] = [];
        const network = new RoadNetwork([]);
        const editOnce = (): void => {
          const roll = random();
          if (live.length > 0 && roll < 0.4) {
            const { id } = pick(random, live);
            network.remove(id);
            live.splice(earliestWithId(live, id), 1);
            seen.removed++;
          } else if (live.length > 0 && roll < 0.47) {
            const twin = { ...pick(random, live) };
            network.add(twin);
            live.push(twin);
            seen.sharedIds++;
          } else if (roll < 0.57) {
            const far = moved(pick(random, pool), FAR_LDU * pick(random, [1, 2, -1]), FAR_LDU);
            network.add(far);
            live.push(far);
            seen.far++;
          } else {
            const placement = pick(random, pool);
            network.add(placement);
            live.push(placement);
          }
        };
        for (let step = 0; step < EDITS_PER_SEQUENCE; step++) {
          editOnce();
          if (random() < 0.25) editOnce();
          const fresh = new RoadNetwork(live);
          const report = fresh.report();
          expect(network.report()).toEqual(report);
          if (report.overlaps.length > 0) seen.overlaps++;
          if (report.joinedCells > 0) seen.joined++;
          const ask = pick(random, asks);
          const pose = probeNear(random, pick(random, live.length > 0 ? live : pool));
          expect(ask(network, pose)).toEqual(ask(new RoadNetwork(live), pose));
          const asked = live.length > 0 ? pick(random, live).id : 0;
          expect(network.placementJoin(asked)).toEqual(fresh.placementJoin(asked));
        }
      }
      expect(Object.values(seen).every((count) => count > 0)).toBe(true);
    },
    DIFFERENTIAL_TIMEOUT_MS,
  );

  it("refuses to remove an id it doesn't hold", () => {
    const network = new RoadNetwork([at(4, roadBaseplate("44336"), 0, 0, 0, 0)]);
    network.remove(4);
    expect(() => network.remove(4)).toThrow(RangeError);
  });
});

const LAYOUTS_FOR_IDS = 400;

describe("road ids", () => {
  it("reports a layout whose ids rise with gaps exactly as the same layout numbered 0, 1, 2…, read through the renumbering", () => {
    const random = seeded(0x1d5);
    const surfaces = everySurface();
    for (let layout = 0; layout < LAYOUTS_FOR_IDS; layout++) {
      const placements = placementsOf(random, surfaces);
      const dense = placements.map((placement, rank) => ({ ...placement, id: rank }));
      let next = Math.floor(random() * 5);
      const sparseIds = dense.map(() => (next += 1 + Math.floor(random() * 9)));
      const sparse = dense.map((placement, rank) => ({ ...placement, id: sparseIds[rank] ?? 0 }));
      const rankOf = new Map(sparseIds.map((id, rank) => [id, rank]));
      const back = (id: number): number => rankOf.get(id) ?? Number.NaN;
      const report = new RoadNetwork(sparse).report();
      expect({
        ...report,
        overlaps: report.overlaps.map(([a, b]) => [back(a), back(b)]),
        segments: report.segments.map((segment) => ({
          ...segment,
          placement: back(segment.placement),
        })),
      }).toEqual(new RoadNetwork(dense).report());
    }
  });
});

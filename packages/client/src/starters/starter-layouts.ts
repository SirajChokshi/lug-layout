import type { TurnSign } from "@brr/domain";
import type { Rot90 } from "@brr/math";

export interface StarterPiece {
  readonly item: string;
  readonly col: number;
  readonly row: number;
  readonly rot: Rot90;
  readonly xStuds: number;
  readonly zStuds: number;
}

export type StarterSegment =
  | { readonly kind: "straight"; readonly count: number }
  | { readonly kind: "half-turn"; readonly sign: TurnSign };

export interface TileArea {
  readonly col: number;
  readonly row: number;
  readonly cols: number;
  readonly rows: number;
}

export interface StarterTrackRun {
  readonly heading: number;
  readonly segments: ReadonlyArray<StarterSegment>;
  readonly centredOn: TileArea;
}

export interface StarterLayout {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  readonly tile: string;
  readonly pieces: ReadonlyArray<StarterPiece>;
  readonly track: ReadonlyArray<StarterTrackRun>;
}

const GREEN_BASEPLATE = "ldraw:3811@2";
const LIGHT_GREY_BASEPLATE = "ldraw:3811@71";
const GREEN_HALF_BASEPLATE = "ldraw:3857@2";
const ROAD_STRAIGHT = "ldraw:44336p04@72";
const ROAD_CROSSROADS = "ldraw:44343p03@72";
const MILS_ROAD_CURVE = "generated:mils-road-curve";
const GREEN_GROCER = "omr:10185-1";
const PET_SHOP = "omr:10218-1";
const MARKET_STREET = "omr:10190-1";
const TRAIN_STATION = "omr:2150-1";
const METRO_STATION = "omr:4554-1";
const CARGO_STATION = "omr:4555-1";

function oval(straightsPerSide: number, centredOn: TileArea): StarterTrackRun {
  return {
    heading: 0,
    centredOn,
    segments: [
      { kind: "straight", count: straightsPerSide },
      { kind: "half-turn", sign: 1 },
      { kind: "straight", count: straightsPerSide },
      { kind: "half-turn", sign: 1 },
    ],
  };
}

function at(item: string, col: number, rowIndex: number, rot: Rot90 = 0): StarterPiece {
  return { item, col, row: rowIndex, rot, xStuds: 0, zStuds: 0 };
}

function nudged(piece: StarterPiece, xStuds: number, zStuds: number): StarterPiece {
  return { ...piece, xStuds, zStuds };
}

function row(
  item: string,
  rowIndex: number,
  cols: ReadonlyArray<number>,
  rot: Rot90 = 0,
): ReadonlyArray<StarterPiece> {
  return cols.map((col) => at(item, col, rowIndex, rot));
}

export const SHIPPED_STARTER_LAYOUTS: ReadonlyArray<StarterLayout> = [
  {
    id: "oval-town",
    title: "Small oval town",
    blurb: "A 9V oval on green baseplates, a street of road plates and three modular buildings.",
    tile: GREEN_BASEPLATE,
    pieces: [
      ...row(GREEN_BASEPLATE, 0, [0, 1, 2, 3]),
      ...row(GREEN_BASEPLATE, 1, [0, 1, 2, 3]),
      ...row(GREEN_BASEPLATE, 2, [0, 1, 2, 3]),
      ...row(ROAD_STRAIGHT, 3, [0, 1, 2, 3], 1),
      at(GREEN_GROCER, 0, 4, 2),
      at(PET_SHOP, 1, 4, 2),
      at(GREEN_BASEPLATE, 2, 4),
      at(MARKET_STREET, 3, 4, 2),
    ],
    track: [oval(2, { col: 0, row: 0, cols: 4, rows: 3 })],
  },
  {
    id: "crossroads-square",
    title: "Crossroads square",
    blurb:
      "A crossroads plate with four road arms, three modular buildings on the corners and a park.",
    tile: GREEN_BASEPLATE,
    pieces: [
      at(ROAD_CROSSROADS, 1, 1),
      at(ROAD_STRAIGHT, 1, 0),
      at(ROAD_STRAIGHT, 1, 2),
      at(ROAD_STRAIGHT, 0, 1, 1),
      at(ROAD_STRAIGHT, 2, 1, 1),
      at(GREEN_GROCER, 0, 0),
      at(PET_SHOP, 2, 0),
      at(MARKET_STREET, 0, 2, 2),
      at(GREEN_BASEPLATE, 2, 2),
    ],
    track: [],
  },
  {
    id: "mils-ring",
    title: "MILS city block",
    blurb:
      "Four MILS road-curve modules joined into a ring road, with Green Grocer and Pet Shop across the street.",
    tile: GREEN_BASEPLATE,
    pieces: [
      at(MILS_ROAD_CURVE, 0, 0, 2),
      at(MILS_ROAD_CURVE, 1, 0, 1),
      at(MILS_ROAD_CURVE, 0, 1, 3),
      at(MILS_ROAD_CURVE, 1, 1, 0),
      at(GREEN_GROCER, 0, 2, 2),
      at(PET_SHOP, 1, 2, 2),
    ],
    track: [],
  },
  {
    id: "station-yard",
    title: "Station yard",
    blurb: "A long 9V oval with two stations on a platform row and a cargo station in the infield.",
    tile: GREEN_BASEPLATE,
    pieces: [
      ...row(LIGHT_GREY_BASEPLATE, 0, [0, 1, 2, 3, 4, 5]),
      nudged(at(TRAIN_STATION, 0, 0), 8, 2),
      nudged(at(METRO_STATION, 3, 0), 16, 2),
      ...row(GREEN_BASEPLATE, 1, [0, 1, 2, 3, 4, 5]),
      at(GREEN_BASEPLATE, 0, 2),
      at(CARGO_STATION, 1, 2, 1),
      nudged(at(GREEN_HALF_BASEPLATE, 2, 2, 1), 16, 0),
      ...row(GREEN_BASEPLATE, 2, [3, 4, 5]),
      ...row(GREEN_BASEPLATE, 3, [0, 1, 2, 3, 4, 5]),
    ],
    track: [oval(6, { col: 0, row: 1, cols: 6, rows: 3 })],
  },
];

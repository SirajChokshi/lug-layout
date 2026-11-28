import {
  AXIS_NEG_X,
  AXIS_NEG_Y,
  AXIS_NEG_Z,
  AXIS_POS_X,
  AXIS_POS_Y,
  AXIS_POS_Z,
  CAP_FAR,
  CAP_ROOT,
  type CellVolumes,
  type ConnectionSolver,
  ConnectorTable,
  FootprintGrid,
  GENDER_FEMALE,
  GENDER_MALE,
  MateReport,
  ModelConnectors,
  NO_PARTNER,
  NO_SHAPE,
  SECTION_AXLE,
  SECTION_FEMALE_FINGER,
  SECTION_MALE_FINGER,
  SECTION_ROUND,
  type SnapShapes,
  SOURCE_INFERRED,
  SOURCE_SHADOW,
  STATUS_UNVERIFIED,
  STATUS_VERIFIED,
  type LatticePose,
  type OverlapHit,
  type TrackEnd,
  VolumeIndex,
  WORLD_TRACK_FRAME,
} from "@brr/domain";
import { ASSET_FETCHER, EMPTY_COLUMN, PART_BUNDLE_LOADER, type IAssetFetcher } from "@brr/catalog";
import {
  PLATE_LDU,
  isRot90,
  pose16,
  rot90Cos,
  rot90Sin,
  SIXTEENTHS_PER_LDU,
  STUD_LDU,
  zeta16,
  ZETA16_COEFFICIENT_COUNT,
  type Rot90,
} from "@brr/math";
import type { PartTechnic } from "@brr/schema/bundle";
import { Container } from "inversify";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { fixtureBundleFetcher } from "../edit/fixture-model.test-support.ts";
import { distinctJoints } from "../edit/placement-hover.ts";
import { connectorKind, mateCounts } from "../edit/placement-hover-view.ts";
import type { HoverMateCount, PlacedModelView } from "../edit/placement-hover.ts";
import type { PlaceablePartCells } from "../edit/placeable.ts";
import { InThreadModelImporter } from "../import/in-thread-importer.test-support.ts";
import {
  CONNECTION_SOLVER,
  CONNECTOR_TABLES,
  MODEL_IMPORTER,
  PLACEABLE_CATALOG,
  PLACEMENT_SEARCH,
  SNAP_MATING,
  SNAP_SHAPES,
} from "../tokens.ts";
import { partBoxes, type PartBoxes } from "./part-boxes.ts";
import { FrozenTechnic } from "./frozen-technic.ts";
import { typedArraysConstructedDuring } from "./typed-arrays.test-support.ts";
import { FrozenVolumes } from "./placeable-volumes.ts";
import { MateZones, type PlacedParts } from "./mate-zones.ts";
import {
  SETTLED_AT_ONCE,
  placementChoice,
  type IPlacementSearch,
  type PlacementChoice,
  type PlacementWindow,
} from "./placement-search.ts";

const HALF = STUD_LDU / 2;
const SLAB_LDU = 4;
const BRICK_LDU = 3 * PLATE_LDU;
const BASEPLATE = 1;
const BRICK = 2;
const PLATE = 3;
const BORED = 4;
const OTHER = 5;
const LAID = 6;
const Z = 2;
const STEPS = 16;
const WIDE = 8 * STEPS;
const BORE = 6 * STEPS;
const BORE_RADII = [WIDE, WIDE, ...Array.from({ length: 16 }, () => BORE), WIDE, WIDE];
const RIDGED = [WIDE, WIDE, ...Array.from({ length: 18 }, () => BORE + 4)];
const LINE_X = STUD_LDU;
const LINE_Y = 14;
const BLOCK = [0, 0, 0, 2 * STUD_LDU, BRICK_LDU, STUD_LDU];
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const ORIGIN: LatticePose = { x: 0, z: 0, yPlates: 0, rot: 0 };
const TEST_ITEM = "test:piece";
const TABLE_Y_PLATES = 0;

type Box = ReadonlyArray<number>;
type Spec = readonly [shape: number, gender: number, x: number, y: number, z: number, axis: number];

interface Fixture {
  readonly search: IPlacementSearch;
  readonly solver: ConnectionSolver;
  readonly shapes: SnapShapes;
  readonly connectors: (
    parts: ReadonlyArray<ConnectorTable | null>,
    trackEnds?: ReadonlyArray<TrackEnd>,
  ) => ModelConnectors;
  readonly stud: number;
  readonly receptor: (depth: number) => number;
  readonly boreEnd: number;
  readonly slidingBoreEnd: number;
  readonly pinEnd: (length: number) => number;
  readonly freePin: number;
}

interface Parts {
  readonly boxes: PartBoxes;
  readonly technic: FrozenTechnic;
}

interface Piece {
  readonly connectors: ModelConnectors;
  readonly volumes: FrozenVolumes;
  readonly parts: Parts;
}

function fixture(prelude: (shapes: SnapShapes) => void = () => {}): Fixture {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  const shapes = container.get(SNAP_SHAPES);
  prelude(shapes);
  const mating = container.get(SNAP_MATING);
  return {
    search: container.get(PLACEMENT_SEARCH),
    solver: container.get(CONNECTION_SOLVER),
    shapes,
    connectors: (parts, trackEnds = []) =>
      ModelConnectors.fromParts(
        parts,
        {
          count: parts.length,
          partIndex: parts.map((_, i) => i),
          matrices: Float64Array.from(parts.flatMap(() => IDENTITY)),
        },
        mating,
        trackEnds,
      ),
    stud: shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [6], [4]),
    receptor: (depth) => shapes.intern(CAP_FAR, false, [SECTION_ROUND], [6], [depth]),
    boreEnd: shapes.intern(
      0,
      false,
      [SECTION_ROUND, SECTION_ROUND, SECTION_ROUND],
      [8, 6, 8],
      [2, 16, 2],
    ),
    slidingBoreEnd: shapes.intern(
      0,
      true,
      [SECTION_ROUND, SECTION_ROUND, SECTION_ROUND],
      [8, 6, 8],
      [2, 16, 2],
    ),
    pinEnd: (length) => shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [6], [length]),
    freePin: shapes.intern(0, false, [SECTION_ROUND], [6], [2 * STUD_LDU]),
  };
}

function table(specs: ReadonlyArray<Spec>): ConnectorTable {
  return new ConnectorTable(
    Uint16Array.from(specs, ([shape]) => shape),
    Uint8Array.from(specs, ([, gender]) => gender),
    new Uint8Array(specs.length).fill(SOURCE_SHADOW),
    new Uint8Array(specs.length).fill(STATUS_VERIFIED),
    Int32Array.from(
      specs.flatMap(([, , x, y, z]) => [x, y, z]),
      (ldu) => ldu * SIXTEENTHS_PER_LDU,
    ),
    Int8Array.from(specs, ([, , , , , axis]) => axis),
    new Float64Array(specs.length * 3),
    new Uint16Array(specs.length),
    new Float64Array(specs.length * 3),
    [],
  );
}

function grid(
  width: number,
  depth: number,
  shape: number,
  gender: number,
  y: number,
  axis: number,
): ConnectorTable {
  const specs: Spec[] = [];
  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < width; i++) {
      specs.push([shape, gender, i * STUD_LDU + HALF, y, j * STUD_LDU + HALF, axis]);
    }
  }
  return table(specs);
}

function sixteenths(ldu: number): number {
  return Math.round(ldu * SIXTEENTHS_PER_LDU);
}

function boxCells(
  cellX0: number,
  cellZ0: number,
  width: number,
  depth: number,
  boxes: ReadonlyArray<Box>,
): PlaceablePartCells {
  const start = [0];
  const instance: number[] = [];
  const cellBox: number[] = [];
  const heightBox: number[] = [];
  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < width; i++) {
      const left = (cellX0 + i) * STUD_LDU;
      const near = (cellZ0 + j) * STUD_LDU;
      boxes.forEach(([x0 = 0, y0 = 0, z0 = 0, x1 = 0, y1 = 0, z1 = 0], b) => {
        const clipped = [
          Math.max(x0, left) - left,
          Math.max(z0, near) - near,
          Math.min(x1, left + STUD_LDU) - left,
          Math.min(z1, near + STUD_LDU) - near,
        ];
        if ((clipped[2] ?? 0) <= (clipped[0] ?? 0) || (clipped[3] ?? 0) <= (clipped[1] ?? 0))
          return;
        instance.push(b);
        cellBox.push(...clipped.map(sixteenths));
        heightBox.push(sixteenths(y0), sixteenths(y1));
      });
      start.push(instance.length);
    }
  }
  return {
    start: Int32Array.from(start),
    instance: Uint32Array.from(instance),
    cellBox: Int16Array.from(cellBox),
    heightBox: Int32Array.from(heightBox),
  };
}

function boxVolumes(
  cellX0: number,
  cellZ0: number,
  width: number,
  depth: number,
  boxes: ReadonlyArray<Box>,
): FrozenVolumes {
  const parts = boxCells(cellX0, cellZ0, width, depth, boxes);
  const cells = width * depth;
  const columnBottom = new Int16Array(cells);
  const columnTop = new Int16Array(cells).fill(EMPTY_COLUMN);
  for (let c = 0; c < cells; c++) {
    const first = parts.start[c] ?? 0;
    const end = parts.start[c + 1] ?? 0;
    if (end === first) continue;
    let bottom = Number.POSITIVE_INFINITY;
    let top = Number.NEGATIVE_INFINITY;
    for (let r = first; r < end; r++) {
      bottom = Math.min(bottom, (parts.heightBox[2 * r] ?? 0) / SIXTEENTHS_PER_LDU);
      top = Math.max(top, (parts.heightBox[2 * r + 1] ?? 0) / SIXTEENTHS_PER_LDU);
    }
    columnBottom[c] = Math.floor(bottom / PLATE_LDU);
    columnTop[c] = Math.ceil(top / PLATE_LDU);
  }
  return FrozenVolumes.ofPlaceable({
    cells: { cellX0, cellZ0, width, depth, columnBottom, columnTop, parts },
    slabBoxes: new Float32Array(0),
  });
}

function columns(
  width: number,
  depth: number,
  bottom: number,
  top: number,
  x0 = 0,
  z0 = 0,
): FrozenVolumes {
  const count = width * depth;
  return FrozenVolumes.ofPlaceable({
    cells: {
      cellX0: x0,
      cellZ0: z0,
      width,
      depth,
      columnBottom: new Int16Array(count),
      columnTop: new Int16Array(count).fill(top / PLATE_LDU),
      parts: boxCells(x0, z0, width, depth, [
        [
          x0 * STUD_LDU,
          bottom,
          z0 * STUD_LDU,
          (x0 + width) * STUD_LDU,
          top,
          (z0 + depth) * STUD_LDU,
        ],
      ]),
    },
    slabBoxes:
      bottom < 0
        ? Float32Array.of(
            x0 * STUD_LDU,
            bottom,
            z0 * STUD_LDU,
            (x0 + width) * STUD_LDU,
            0,
            (z0 + depth) * STUD_LDU,
          )
        : new Float32Array(0),
  });
}

function partsOf(
  boxes: ReadonlyArray<Box>,
  technic: ReadonlyArray<PartTechnic | null> = [],
): Parts {
  const measured = partBoxes(boxes.flat());
  return {
    boxes: measured,
    technic: FrozenTechnic.ofParts(
      boxes.map((_, i) => technic[i] ?? null),
      {
        count: boxes.length,
        partIndex: boxes.map((_, i) => i),
        matrices: Float64Array.from(boxes.flatMap(() => IDENTITY)),
      },
      measured.boxes,
    ),
  };
}

function place(
  f: Fixture,
  owner: number,
  piece: Piece,
  pose: LatticePose = ORIGIN,
  item: string = TEST_ITEM,
): void {
  f.search.add(
    owner,
    piece.connectors,
    piece.volumes,
    piece.parts.boxes,
    piece.parts.technic,
    pose,
    item,
  );
}

function choose(
  f: Fixture,
  piece: Piece,
  at: PlacementWindow,
  moving: number | null = null,
): PlacementChoice {
  const choice = placementChoice();
  f.search.search(
    piece.connectors,
    piece.volumes,
    piece.parts.boxes,
    piece.parts.technic,
    at,
    TABLE_Y_PLATES,
    moving,
    choice,
  );
  return choice;
}

const EVERY_SLICE_OVERDUE = 0;

function chooseInSlices(
  f: Fixture,
  piece: Piece,
  at: PlacementWindow,
  betweenSlices: () => void = () => {},
): SlicedChoice {
  const choice = placementChoice();
  const ticket = f.search.begin(
    piece.connectors,
    piece.volumes,
    piece.parts.boxes,
    piece.parts.technic,
    at,
    TABLE_Y_PLATES,
    null,
    choice,
  );
  let slices = 1;
  if (ticket !== SETTLED_AT_ONCE) {
    while (f.search.advance(ticket, EVERY_SLICE_OVERDUE) === "running") {
      betweenSlices();
      slices++;
    }
  }
  return { choice, slices };
}

interface SlicedChoice {
  readonly choice: PlacementChoice;
  readonly slices: number;
}

function stranded(placement: number) {
  return { kind: "stranded", placement };
}

function fullVerdict(choice: PlacementChoice) {
  return {
    pose: [choice.x, choice.z, choice.yPlates, choice.rot],
    votes: choice.votes,
    accepted: choice.accepted,
    hit: choice.accepted ? null : { ...choice.overlap },
  };
}

function window(x: number, z: number, cells: number, yPlates = 0, plates = 1): PlacementWindow {
  return {
    x,
    z,
    yPlates,
    rot: 0,
    cells,
    plates,
    turns: 1,
    radiusLdu: cells * STUD_LDU,
    firstTurn: 0,
  };
}

function world(f: Fixture): Piece {
  place(f, BASEPLATE, {
    connectors: f.connectors([grid(4, 4, f.stud, GENDER_MALE, 0, AXIS_POS_Y)]),
    volumes: columns(4, 4, -SLAB_LDU, 0),
    parts: partsOf([[0, -SLAB_LDU, 0, 4 * STUD_LDU, 0, 4 * STUD_LDU]]),
  });
  place(f, BRICK, {
    connectors: f.connectors([
      grid(1, 1, f.stud, GENDER_MALE, BRICK_LDU, AXIS_POS_Y),
      grid(1, 1, f.receptor(BRICK_LDU - 4), GENDER_FEMALE, 0, AXIS_NEG_Y),
    ]),
    volumes: columns(1, 1, 0, BRICK_LDU),
    parts: partsOf([[0, 0, 0, STUD_LDU, BRICK_LDU, STUD_LDU]]),
  });
  return {
    connectors: f.connectors([
      grid(2, 2, f.stud, GENDER_MALE, PLATE_LDU, AXIS_POS_Y),
      grid(2, 2, f.receptor(4), GENDER_FEMALE, 0, AXIS_NEG_Y),
    ]),
    volumes: columns(2, 2, 0, PLATE_LDU),
    parts: partsOf([[0, 0, 0, 2 * STUD_LDU, PLATE_LDU, 2 * STUD_LDU]]),
  };
}

function bore(fromZ: number): PartTechnic {
  return {
    stepsPerLdu: STEPS,
    holes: [{ axis: Z, at: [LINE_X, LINE_Y], from: fromZ, radii: BORE_RADII }],
    shaft: null,
  };
}

const PIN: PartTechnic = {
  stepsPerLdu: STEPS,
  holes: [],
  shaft: {
    axis: Z,
    at: [LINE_X, LINE_Y],
    components: [
      { from: -STUD_LDU, radii: RIDGED.toReversed(), pin: null },
      { from: 0, radii: RIDGED, pin: null },
    ],
  },
};

function boreEnds(f: Fixture, fromZ: number): ConnectorTable {
  return table([
    [f.boreEnd, GENDER_FEMALE, LINE_X, LINE_Y, fromZ, AXIS_NEG_Z],
    [f.boreEnd, GENDER_FEMALE, LINE_X, LINE_Y, fromZ + STUD_LDU, AXIS_POS_Z],
  ]);
}

function boredBlock(f: Fixture, withConnectors = true): Piece {
  return {
    connectors: f.connectors([withConnectors ? boreEnds(f, 0) : null]),
    volumes: columns(2, 1, 0, BRICK_LDU),
    parts: partsOf([BLOCK], [withConnectors ? bore(0) : null]),
  };
}

function pinnedBlock(f: Fixture, pinLength: number, extra: ReadonlyArray<Box> = []): Piece {
  const ownBlock = [0, 0, -STUD_LDU, 2 * STUD_LDU, BRICK_LDU, 0];
  const pin = [LINE_X - 8, LINE_Y - 8, -STUD_LDU, LINE_X + 8, LINE_Y + 8, STUD_LDU];
  const end = f.pinEnd(pinLength);
  return {
    connectors: f.connectors([
      boreEnds(f, -STUD_LDU),
      table([
        [end, GENDER_MALE, LINE_X, LINE_Y, 0, AXIS_POS_Z],
        [end, GENDER_MALE, LINE_X, LINE_Y, 0, AXIS_NEG_Z],
      ]),
      ...extra.map(() => null),
    ]),
    volumes: boxVolumes(0, -1, 2, 2, [ownBlock, pin, ...extra]),
    parts: partsOf([ownBlock, pin, ...extra], [bore(-STUD_LDU), PIN]),
  };
}

function straightEnd(studs: number, heading: number): TrackEnd {
  const coefficients = Array.from({ length: ZETA16_COEFFICIENT_COUNT }, () => 0n);
  coefficients[0] = BigInt(studs);
  return {
    pose: pose16(zeta16(coefficients), heading),
    yPlates: 0,
    instance: 0,
    frame: WORLD_TRACK_FRAME,
  };
}

function verdict(choice: PlacementChoice): readonly [boolean, number, number] {
  return [choice.accepted, choice.votes, choice.accepted ? -1 : choice.overlap.owner];
}

const NO_STUD_SHAPES: ReadonlySet<number> = new Set();

describe("PlacementSearch", () => {
  it("takes the nearest mated pose that fits when the cursor pose collides, breaking an equal-distance tie by lattice order", () => {
    const f = fixture();
    const choice = choose(f, world(f), window(0, 0, 1));
    expect([choice.accepted, choice.x, choice.z, choice.yPlates, choice.votes]).toEqual([
      true,
      0,
      STUD_LDU,
      0,
      4,
    ]);
  });

  it("refuses with the top pose's overlap when every candidate collides, unless that volume is moving", () => {
    const f = fixture();
    const plate = world(f);
    const refused = choose(f, plate, window(0, 0, 0));
    expect([refused.accepted, refused.x, refused.z, refused.votes]).toEqual([false, 0, 0, 4]);
    expect(refused.overlap).toEqual({
      owner: BRICK,
      instance: 0,
      bottomLdu: 0,
      topLdu: BRICK_LDU,
      cellX: 0,
      cellZ: 0,
      candidateInstance: 0,
      candidateBottomLdu: 0,
      candidateTopLdu: PLATE_LDU,
    });
    expect(choose(f, plate, window(0, 0, 0), BRICK).accepted).toBe(true);
    f.search.remove(BRICK);
    const freed = choose(f, plate, window(0, 0, 0));
    expect([freed.accepted, freed.votes]).toEqual([true, 4]);
  });

  it("refuses an unmated model at the cursor where it collides, and never moves it to a free cell nearby", () => {
    const f = fixture();
    const plate = world(f);
    const away = 10 * STUD_LDU;
    place(
      f,
      OTHER,
      {
        connectors: f.connectors([null]),
        volumes: columns(1, 1, 0, BRICK_LDU),
        parts: partsOf([[0, 0, 0, STUD_LDU, BRICK_LDU, STUD_LDU]]),
      },
      { x: away, z: away, yPlates: 0, rot: 0 },
    );
    const choice = choose(f, plate, window(away, away, 2));
    expect([choice.accepted, choice.x, choice.z, choice.votes, choice.overlap.owner]).toEqual([
      false,
      away,
      away,
      0,
      OTHER,
    ]);
  });

  it("refuses only where a held part's box meets a placed part's box, so a held part fits under an overhang whose column it shares", () => {
    const f = fixture();
    const baseplate = [0, -SLAB_LDU, 0, 2 * STUD_LDU, 0, STUD_LDU] as const;
    const overhangingPlate = [0, 5 * PLATE_LDU, 0, STUD_LDU, 6 * PLATE_LDU, STUD_LDU] as const;
    const solidBoxes = [[...baseplate], [...overhangingPlate]];
    const solid: Piece = {
      connectors: f.connectors([null, null]),
      volumes: FrozenVolumes.ofPlaceable({
        cells: {
          cellX0: 0,
          cellZ0: 0,
          width: 2,
          depth: 1,
          columnBottom: Int16Array.of(0, 0),
          columnTop: Int16Array.of(6, 0),
          parts: boxCells(0, 0, 2, 1, solidBoxes),
        },
        slabBoxes: Float32Array.from(baseplate),
      }),
      parts: partsOf(solidBoxes),
    };
    place(f, OTHER, solid);
    const held = (cells: number, pinTop: number, slab: ReadonlyArray<Box>): Piece => {
      const boxes = [[0, 0, 0, STUD_LDU, pinTop * PLATE_LDU, STUD_LDU], ...slab];
      return {
        connectors: f.connectors(boxes.map(() => null)),
        volumes: FrozenVolumes.ofPlaceable({
          cells: {
            cellX0: 0,
            cellZ0: 0,
            width: cells,
            depth: 1,
            columnBottom: new Int16Array(cells),
            columnTop: Int16Array.from({ length: cells }, (_, c) => (c === 0 ? pinTop : 0)),
            parts: boxCells(0, 0, cells, 1, boxes),
          },
          slabBoxes: Float32Array.from(slab.flat()),
        }),
        parts: partsOf(boxes),
      };
    };
    const pinAndBaseplate = held(2, 3, [[STUD_LDU, -SLAB_LDU, 0, 2 * STUD_LDU, 0, STUD_LDU]]);
    const pinOnly = held(1, 3, []);
    const pieceVerdict = (piece: Piece) => {
      const choice = choose(f, piece, window(0, 0, 0, 0, 0));
      const { cellX, cellZ, instance, candidateInstance } = choice.overlap;
      return choice.accepted ? "accepted" : [cellX, cellZ, instance, candidateInstance];
    };

    expect({
      pinAndBaseplate: pieceVerdict(pinAndBaseplate),
      pinOnly: pieceVerdict(pinOnly),
    }).toEqual({
      pinAndBaseplate: [1, 0, 0, 1],
      pinOnly: "accepted",
    });
  });

  it("constructs no typed array once warm, however the assist window moves, searched whole or one unit per slice", async () => {
    const f = fixture();
    const plate = world(f);
    const windows = [0, 1, 2, 3, 4].flatMap((i) =>
      [0, 1, 2].map((j) => window(i * STUD_LDU, j * STUD_LDU, 2)),
    );
    const sweep = () => {
      for (const at of windows) {
        choose(f, plate, at);
        chooseInSlices(f, plate, at);
      }
    };
    sweep();

    expect(await typedArraysConstructedDuring(sweep)).toBe(0);
  });

  it("settles a search advanced one unit per slice on exactly the choice it makes whole, held turn and turn probe alike", () => {
    const f = fixture();
    const plate = world(f);
    const windows = [0, 1, 2, 3, 4].flatMap((i) =>
      [0, 1, 2].flatMap((j) => {
        const held = window(i * STUD_LDU, j * STUD_LDU, 2, 0, 2);
        return [held, { ...held, turns: 4, firstTurn: 1 }];
      }),
    );
    const whole = windows.map((at) => fullVerdict(choose(f, plate, at)));
    const sliced = windows.map((at) => chooseInSlices(f, plate, at));

    expect(sliced.map(({ choice }) => fullVerdict(choice))).toEqual(whole);
    expect(Math.max(...sliced.map(({ slices }) => slices))).toBeGreaterThan(1);
  });

  it("answers a placed model's overlap, mates and table footing while a sliced search is paused, and the search still settles on the choice it makes whole", () => {
    const f = fixture();
    const plate = world(f);
    place(f, PLATE, plate, { x: 2 * STUD_LDU, z: 2 * STUD_LDU, yPlates: 0, rot: 0 });
    const far = 40 * STUD_LDU;
    const wall = 35;
    const wallBores = Array.from({ length: 80 }, (_, n): Spec => [
      f.boreEnd,
      GENDER_FEMALE,
      LINE_X + (n % 4) * STUD_LDU,
      LINE_Y + Math.floor(n / 16) * BRICK_LDU,
      (Math.floor(n / 4) % 4) * STUD_LDU,
      AXIS_NEG_Z,
    ]);
    place(
      f,
      wall,
      {
        connectors: f.connectors([table(wallBores)]),
        volumes: columns(5, 4, 0, 5 * BRICK_LDU),
        parts: partsOf([[0, 0, 0, 5 * STUD_LDU, 5 * BRICK_LDU, 4 * STUD_LDU]]),
      },
      { x: far - 6 * STUD_LDU, z: 0, yPlates: 0, rot: 0 },
    );
    place(f, BORED, boredBlock(f), { x: far, z: 0, yPlates: 0, rot: 0 });
    const pin = pinnedBlock(f, STUD_LDU);
    const windows = [0, 1, 2].map((i) => window(far + i * STUD_LDU, STUD_LDU, 2, 1, 1));
    const whole = windows.map((at) => fullVerdict(choose(f, pin, at)));
    const measure = () =>
      [BASEPLATE, BRICK, PLATE, wall, BORED].map((placement) => [
        f.search.overlapOf(placement),
        f.search.holdingMates(placement),
        f.search.standsOnTable(placement, TABLE_Y_PLATES),
      ]);
    const idle = measure();
    const paused: Array<ReturnType<typeof measure>> = [];
    const sliced = windows.map((at) => chooseInSlices(f, pin, at, () => paused.push(measure())));

    expect(sliced.map(({ choice }) => fullVerdict(choice))).toEqual(whole);
    expect(paused.length).toBeGreaterThan(0);
    expect(new Set(paused.map((answers) => JSON.stringify(answers)))).toEqual(
      new Set([JSON.stringify(idle)]),
    );
  });

  it("gives exactly precise's verdict wherever assist ends at the cursor pose: nothing mated in reach, or the cursor pose itself mated and free", () => {
    const f = fixture();
    const plate = world(f);
    const away = 10 * STUD_LDU;
    place(
      f,
      OTHER,
      {
        connectors: f.connectors([null]),
        volumes: columns(1, 1, 0, BRICK_LDU),
        parts: partsOf([[0, 0, 0, STUD_LDU, BRICK_LDU, STUD_LDU]]),
      },
      { x: away, z: away, yPlates: 0, rot: 0 },
    );
    const cursors = [
      [away, away],
      [away + 4 * STUD_LDU, away],
      [0, STUD_LDU],
    ] as const;
    const assist = cursors.map(([x, z]) => fullVerdict(choose(f, plate, window(x, z, 2))));
    const precise = cursors.map(([x, z]) => fullVerdict(choose(f, plate, window(x, z, 0, 0, 0))));

    expect({ assist, accepted: precise.map((row) => row.accepted) }).toEqual({
      assist: precise,
      accepted: [false, true, true],
    });
  });

  it("stacks a brick on a brick through stud mates that name no partner, since columns stop at the body top below the studs", () => {
    const f = fixture();
    const brick: Piece = {
      connectors: f.connectors([
        grid(2, 2, f.stud, GENDER_MALE, BRICK_LDU, AXIS_POS_Y),
        grid(2, 2, f.receptor(BRICK_LDU - 4), GENDER_FEMALE, 0, AXIS_NEG_Y),
      ]),
      volumes: columns(2, 2, 0, BRICK_LDU),
      parts: partsOf([[0, 0, 0, 2 * STUD_LDU, BRICK_LDU, 2 * STUD_LDU]]),
    };
    place(f, BRICK, brick);
    const choice = choose(f, brick, window(0, 0, 0, 3, 1));
    expect([choice.accepted, choice.x, choice.z, choice.yPlates, choice.votes]).toEqual([
      true,
      0,
      0,
      3,
      4,
    ]);
  });

  it("blocks one placeable's own cells at every pose it is placed at, through removals and re-adds", () => {
    const f = fixture();
    const [first, raised, turned, moved] = [11, 12, 13, 14];
    const ellBoxes = [
      [0, 0, 0, 2 * STUD_LDU, BRICK_LDU, STUD_LDU],
      [0, 0, STUD_LDU, STUD_LDU, BRICK_LDU, 2 * STUD_LDU],
    ];
    const ell: Piece = {
      connectors: f.connectors([null, null]),
      volumes: FrozenVolumes.ofPlaceable({
        cells: {
          cellX0: 0,
          cellZ0: 0,
          width: 2,
          depth: 2,
          columnBottom: new Int16Array(4),
          columnTop: Int16Array.of(3, 3, 3, EMPTY_COLUMN),
          parts: boxCells(0, 0, 2, 2, ellBoxes),
        },
        slabBoxes: new Float32Array(0),
      }),
      parts: partsOf(ellBoxes),
    };
    const column: Piece = {
      connectors: f.connectors([null]),
      volumes: columns(1, 1, 0, 3 * BRICK_LDU),
      parts: partsOf([[0, 0, 0, STUD_LDU, 3 * BRICK_LDU, STUD_LDU]]),
    };
    const at = (cellX: number, cellZ: number): readonly [boolean, number, number] => {
      const choice = choose(f, column, window(cellX * STUD_LDU, cellZ * STUD_LDU, 0, 0, 0));
      return choice.accepted ? [true, 0, 0] : [false, choice.overlap.owner, choice.overlap.topLdu];
    };
    place(f, first, ell, ORIGIN);
    place(f, raised, ell, { x: 5 * STUD_LDU + HALF, z: 2 * STUD_LDU, yPlates: 3, rot: 0 });
    place(f, turned, ell, { x: -5 * STUD_LDU, z: 2 * STUD_LDU, yPlates: 0, rot: 1 });
    expect([at(1, 0), at(1, 1), at(7, 2), at(7, 3), at(-5, 0), at(-4, 0)]).toEqual([
      [false, first, BRICK_LDU],
      [true, 0, 0],
      [false, raised, 2 * BRICK_LDU],
      [true, 0, 0],
      [false, turned, BRICK_LDU],
      [true, 0, 0],
    ]);
    f.search.remove(first);
    f.search.remove(raised);
    place(f, moved, ell, { x: 10 * STUD_LDU, z: -3 * STUD_LDU, yPlates: 2, rot: 0 });
    expect([at(1, 0), at(7, 2), at(11, -3), at(11, -2), at(10, -2), at(-5, 0)]).toEqual([
      [true, 0, 0],
      [true, 0, 0],
      [false, moved, BRICK_LDU + 2 * PLATE_LDU],
      [true, 0, 0],
      [false, moved, BRICK_LDU + 2 * PLATE_LDU],
      [false, turned, BRICK_LDU],
    ]);
  });

  it("finds the placement outside a removed group that the removal would leave with no mate and not resting on the table", () => {
    const f = fixture();
    const plate = world(f);
    place(f, PLATE, plate, { x: 2 * STUD_LDU, z: 2 * STUD_LDU, yPlates: 0, rot: 0 });
    const onTable = (placement: number): boolean => placement === BASEPLATE;
    const none = { kind: "none" };
    expect(f.search.strandedByRemoval(new Set([BASEPLATE]), onTable)).toEqual(stranded(BRICK));
    expect(f.search.strandedByRemoval(new Set([BASEPLATE]), () => true)).toEqual(none);
    expect(f.search.strandedByRemoval(new Set([BASEPLATE, BRICK]), onTable)).toEqual(
      stranded(PLATE),
    );
    f.search.remove(BRICK);
    expect(f.search.strandedByRemoval(new Set([BASEPLATE]), onTable)).toEqual(stranded(PLATE));
    expect(f.search.strandedByRemoval(new Set([PLATE]), onTable)).toEqual(none);
    expect(f.search.strandedByRemoval(new Set([BASEPLATE, PLATE]), onTable)).toEqual(none);
    const choice = choose(f, plate, window(2 * STUD_LDU, 2 * STUD_LDU, 0), PLATE);
    expect([choice.accepted, choice.votes]).toEqual([true, 4]);
  });

  it("counts as holding a placed model the mates on its connectors that don't face up: under it or beside it, never above it", () => {
    const f = fixture();
    const plate = world(f);
    const floating = 31;
    const pinned = 32;
    place(f, PLATE, plate, { x: 2 * STUD_LDU, z: 2 * STUD_LDU, yPlates: 0, rot: 0 });
    place(f, floating, plate, { x: 2 * STUD_LDU, z: 2 * STUD_LDU, yPlates: 5, rot: 0 });
    const far = 40 * STUD_LDU;
    place(f, BORED, boredBlock(f), { x: far, z: 0, yPlates: 4, rot: 0 });
    place(f, pinned, pinnedBlock(f, STUD_LDU), { x: far, z: 0, yPlates: 4, rot: 0 });
    expect(
      [BASEPLATE, BRICK, PLATE, floating, BORED, pinned].map((placement) =>
        f.search.holdingMates(placement),
      ),
    ).toEqual([0, 1, 4, 0, 1, 1]);
  });

  it("stands a placed model on the table only where one of its cells reaches the table plane with nothing of another placement under it", () => {
    const f = fixture();
    const plate = world(f);
    const straddling = 31;
    const loose = 32;
    const raised = 33;
    const sunk = 34;
    place(f, PLATE, plate, { x: 2 * STUD_LDU, z: 2 * STUD_LDU, yPlates: 0, rot: 0 });
    place(f, straddling, plate, { x: 3 * STUD_LDU, z: 0, yPlates: 0, rot: 0 });
    place(f, loose, plate, { x: 10 * STUD_LDU, z: 0, yPlates: 0, rot: 0 });
    place(f, raised, plate, { x: 10 * STUD_LDU, z: 5 * STUD_LDU, yPlates: 3, rot: 0 });
    place(
      f,
      sunk,
      {
        ...plate,
        volumes: columns(2, 2, -2 * PLATE_LDU, PLATE_LDU),
        parts: partsOf([[0, -2 * PLATE_LDU, 0, 2 * STUD_LDU, PLATE_LDU, 2 * STUD_LDU]]),
      },
      { x: 20 * STUD_LDU, z: 0, yPlates: 1, rot: 0 },
    );
    expect(
      [BASEPLATE, BRICK, PLATE, straddling, loose, raised, sunk].map((placement) =>
        f.search.standsOnTable(placement, TABLE_Y_PLATES),
      ),
    ).toEqual([true, false, false, true, true, false, true]);
  });
});

describe("PlacementSearch mate zones", () => {
  it("lets a pin end wider than a bore sit in it only where it mates that bore, and only over the mated length", () => {
    const f = fixture();
    place(f, BORED, boredBlock(f));
    expect({
      seated: verdict(choose(f, pinnedBlock(f, STUD_LDU), window(0, 0, 0, 0, 0))),
      onePlateUp: verdict(choose(f, pinnedBlock(f, STUD_LDU), window(0, 0, 0, 1, 0))),
      matedOverHalfItsLength: verdict(choose(f, pinnedBlock(f, HALF), window(0, 0, 0, 0, 0))),
    }).toEqual({
      seated: [true, 1, -1],
      onePlateUp: [false, 0, BORED],
      matedOverHalfItsLength: [false, 1, BORED],
    });
  });

  it("judges a placed pair's overlap as search judges the pose, from either side, with each one's own volume exempt", () => {
    const f = fixture();
    place(f, BORED, boredBlock(f));
    const pinned = 21;
    const placedAt = (pinLength: number, yPlates: number) => {
      place(f, pinned, pinnedBlock(f, pinLength), { x: 0, z: 0, yPlates, rot: 0 });
      const both = [f.search.overlapOf(pinned), f.search.overlapOf(BORED)];
      f.search.remove(pinned);
      return both;
    };
    expect({
      seated: placedAt(STUD_LDU, 0),
      onePlateUp: placedAt(STUD_LDU, 1),
      matedOverHalfItsLength: placedAt(HALF, 0),
    }).toEqual({
      seated: [-1, -1],
      onePlateUp: [BORED, pinned],
      matedOverHalfItsLength: [BORED, pinned],
    });
  });

  it("names a placed pair's overlap while a placement beside them still reads its connector tables", () => {
    const f = fixture();
    const plate = world(f);
    const at = { x: 2 * STUD_LDU, z: 2 * STUD_LDU, yPlates: 1, rot: 0 };
    place(f, PLATE, plate, at);
    place(f, OTHER, plate, at);
    f.search.awaitTables(LAID, plate.volumes, { ...at, x: 4 * STUD_LDU });
    expect([f.search.overlapOf(PLATE), f.search.overlapOf(OTHER)]).toEqual([OTHER, PLATE]);
  });

  it("scopes a mate's exemption to the mated pair: another part of the model, or another placement in the same cells, still collides", () => {
    const f = fixture();
    place(f, BORED, boredBlock(f));
    const overhang = choose(
      f,
      pinnedBlock(f, STUD_LDU, [[0, LINE_Y + 2, 0, LINE_X - 8, BRICK_LDU, 4]]),
      window(0, 0, 0, 0, 0),
    );
    place(f, OTHER, boredBlock(f, false));
    const sameCells = choose(f, pinnedBlock(f, STUD_LDU), window(0, 0, 0, 0, 0));
    expect({
      overhang: [overhang.accepted, overhang.overlap.owner, overhang.overlap.cellX],
      sameCellsOtherPlacement: [sameCells.accepted, sameCells.overlap.owner],
    }).toEqual({
      overhang: [false, BORED, 0],
      sameCellsOtherPlacement: [false, OTHER],
    });
  });

  it("lands a pin held where it clears a sliding bore on the stud lattice, not at the nearest depth the slide allows", () => {
    const f = fixture();
    place(f, BORED, {
      connectors: f.connectors([
        table([
          [f.slidingBoreEnd, GENDER_FEMALE, LINE_X, LINE_Y, 0, AXIS_NEG_Z],
          [f.slidingBoreEnd, GENDER_FEMALE, LINE_X, LINE_Y, STUD_LDU, AXIS_POS_Z],
        ]),
      ]),
      volumes: columns(2, 1, 0, BRICK_LDU),
      parts: partsOf([BLOCK], [bore(0)]),
    });
    const freePin = [LINE_X - 6, LINE_Y - 6, -HALF, LINE_X + 6, LINE_Y + 6, STUD_LDU + HALF];
    const held = {
      connectors: f.connectors([
        table([
          [f.freePin, GENDER_MALE, LINE_X, LINE_Y, -HALF, AXIS_POS_Z],
          [f.freePin, GENDER_MALE, LINE_X, LINE_Y, STUD_LDU + HALF, AXIS_NEG_Z],
        ]),
      ]),
      volumes: boxVolumes(0, -1, 2, 3, [freePin]),
      parts: partsOf([freePin]),
    };
    const choice = choose(f, held, window(0, 2 * STUD_LDU, 1, 0, 0));
    expect([choice.accepted, choice.x, choice.z, choice.votes > 0]).toEqual([
      true,
      0,
      STUD_LDU,
      true,
    ]);
  });

  it("seats a free pin through a through bore, whose two end faces pair with the bore's two openings as one joint", () => {
    const f = fixture();
    place(f, BORED, {
      connectors: f.connectors([
        table([
          [f.slidingBoreEnd, GENDER_FEMALE, LINE_X, LINE_Y, 0, AXIS_NEG_Z],
          [f.slidingBoreEnd, GENDER_FEMALE, LINE_X, LINE_Y, STUD_LDU, AXIS_POS_Z],
        ]),
      ]),
      volumes: columns(2, 1, 0, BRICK_LDU),
      parts: partsOf([BLOCK], [bore(0)]),
    });
    const throughPin: PartTechnic = {
      stepsPerLdu: STEPS,
      holes: [],
      shaft: {
        axis: Z,
        at: [LINE_X, LINE_Y],
        components: [
          { from: -HALF, radii: Array.from({ length: 2 * STUD_LDU }, () => BORE + 4), pin: null },
        ],
      },
    };
    const choice = choose(
      f,
      {
        connectors: f.connectors([
          table([
            [f.freePin, GENDER_MALE, LINE_X, LINE_Y, -HALF, AXIS_POS_Z],
            [f.freePin, GENDER_MALE, LINE_X, LINE_Y, STUD_LDU + HALF, AXIS_NEG_Z],
          ]),
        ]),
        volumes: columns(2, 3, 0, BRICK_LDU, 0, -1),
        parts: partsOf(
          [[LINE_X - 6, LINE_Y - 6, -HALF, LINE_X + 6, LINE_Y + 6, STUD_LDU + HALF]],
          [throughPin],
        ),
      },
      window(0, 0, 0, 0, 0),
    );
    expect(choice.accepted).toBe(true);
  });

  it("counts each joint once across kinds: a pin whose two faces are different kinds is one joint in its bore, beside held receptors each a joint on its own stud", () => {
    const f = fixture();
    place(f, BASEPLATE, {
      connectors: f.connectors([grid(4, 4, f.stud, GENDER_MALE, 0, AXIS_POS_Y)]),
      volumes: columns(4, 4, -SLAB_LDU, 0),
      parts: partsOf([[0, -SLAB_LDU, 0, 4 * STUD_LDU, 0, 4 * STUD_LDU]]),
    });
    place(f, BORED, {
      connectors: f.connectors([
        table([
          [f.slidingBoreEnd, GENDER_FEMALE, LINE_X, LINE_Y, 0, AXIS_NEG_Z],
          [f.slidingBoreEnd, GENDER_FEMALE, LINE_X, LINE_Y, STUD_LDU, AXIS_POS_Z],
        ]),
      ]),
      volumes: columns(2, 1, 0, BRICK_LDU),
      parts: partsOf([BLOCK], [bore(0)]),
    });
    const held = f.connectors([
      table([
        [f.freePin, GENDER_MALE, LINE_X, LINE_Y, -HALF, AXIS_POS_Z],
        [f.pinEnd(2 * STUD_LDU), GENDER_MALE, LINE_X, LINE_Y, STUD_LDU + HALF, AXIS_NEG_Z],
      ]),
      grid(2, 1, f.receptor(4), GENDER_FEMALE, 0, AXIS_NEG_Y),
    ]);
    const report = new MateReport();
    f.search.evaluate(held, ORIGIN, report);
    const mates = mateCounts(report, f.shapes, NO_STUD_SHAPES, () => null);
    const studs = mates.filter((mate) => mate.kind.gender === "female");
    const pins = mates.filter((mate) => mate.kind.gender === "male");

    expect({
      kinds: [studs.length, pins.length],
      summedPerKind: mates.reduce((sum, mate) => sum + mate.joints, 0),
      distinct: distinctJoints(mates),
      solver: report.jointCount,
      studsAndPins: [distinctJoints(studs), distinctJoints(pins)],
    }).toEqual({
      kinds: [1, 2],
      summedPerKind: 4,
      distinct: 3,
      solver: 3,
      studsAndPins: [2, 1],
    });
  });

  it("excuses two track pieces' overlap only where their mated ends join them", () => {
    const f = fixture();
    const length = 16;
    const tab = 4;
    const width = 8;
    const laid = [0, 0, 0, length * STUD_LDU + tab, PLATE_LDU, width * STUD_LDU];
    place(f, LAID, {
      connectors: f.connectors([null], [straightEnd(length, 0)]),
      volumes: boxVolumes(0, 0, length + 1, width, [laid]),
      parts: partsOf([laid]),
    });
    const nextPiece = [-tab, 0, 0, length * STUD_LDU, PLATE_LDU, width * STUD_LDU];
    const next: Piece = {
      connectors: f.connectors([null], [straightEnd(0, 8)]),
      volumes: boxVolumes(-1, 0, length + 1, width, [nextPiece]),
      parts: partsOf([nextPiece]),
    };
    const atTheEnd = window(length * STUD_LDU, 0, 0, 0, 0);
    const joinedAtTheEnd = choose(f, next, atTheEnd);
    place(f, OTHER, {
      connectors: f.connectors([null]),
      volumes: columns(1, 1, 0, PLATE_LDU, length - 1, 0),
      parts: partsOf([[(length - 1) * STUD_LDU, 0, 0, length * STUD_LDU, PLATE_LDU, STUD_LDU]]),
    });
    const notTheMatedPiece = choose(f, next, atTheEnd);
    expect({
      joinedAtTheEnd: [joinedAtTheEnd.accepted, joinedAtTheEnd.x, joinedAtTheEnd.votes],
      notTheMatedPiece: [notTheMatedPiece.accepted, notTheMatedPiece.overlap.owner],
    }).toEqual({
      joinedAtTheEnd: [true, length * STUD_LDU, 1],
      notTheMatedPiece: [false, OTHER],
    });
  });
});

function brickWithStudAndReceptor(f: Fixture): Piece {
  return {
    connectors: f.connectors([
      table([
        [f.stud, GENDER_MALE, HALF, BRICK_LDU, HALF, AXIS_POS_Y],
        [f.receptor(BRICK_LDU - 4), GENDER_FEMALE, HALF, 0, HALF, AXIS_NEG_Y],
      ]),
    ]),
    volumes: columns(1, 1, 0, BRICK_LDU),
    parts: partsOf([[0, 0, 0, STUD_LDU, BRICK_LDU, STUD_LDU]]),
  };
}

function bricksStepped(f: Fixture): Piece {
  const lower = [0, 0, 0, STUD_LDU, BRICK_LDU, STUD_LDU];
  const upper = [STUD_LDU, BRICK_LDU, 0, 2 * STUD_LDU, 2 * BRICK_LDU, STUD_LDU];
  return {
    connectors: f.connectors([
      table([[f.receptor(BRICK_LDU - 4), GENDER_FEMALE, HALF, 0, HALF, AXIS_NEG_Y]]),
      table([
        [f.receptor(BRICK_LDU - 4), GENDER_FEMALE, STUD_LDU + HALF, BRICK_LDU, HALF, AXIS_NEG_Y],
      ]),
    ]),
    volumes: boxVolumes(0, 0, 2, 1, [lower, upper]),
    parts: partsOf([lower, upper]),
  };
}

describe("PlacementSearch assist support", () => {
  const WALL = 7;
  const CEILING = 8;
  const FLOOR = 9;
  const PILLAR = 10;
  const CEILING_UNDERSIDE_PLATES = 4;
  const PILLAR_TOP_LDU = 4 * PLATE_LDU;
  const HELD_PLATES = 1;
  const NO_HIT = -1;

  type Neighbour = "wall" | "ceiling" | "floor" | "pillar";

  function scene(neighbours: ReadonlyArray<Neighbour>): Fixture {
    const f = fixture();
    const studAt = (top: number): Piece => ({
      connectors: f.connectors([grid(1, 1, f.stud, GENDER_MALE, top, AXIS_POS_Y)]),
      volumes: columns(1, 1, 0, top),
      parts: partsOf([[0, 0, 0, STUD_LDU, top, STUD_LDU]]),
    });
    for (const neighbour of neighbours) {
      switch (neighbour) {
        case "wall":
          place(f, WALL, {
            connectors: f.connectors([null]),
            volumes: columns(1, 1, 0, BRICK_LDU),
            parts: partsOf([[0, 0, 0, STUD_LDU, BRICK_LDU, STUD_LDU]]),
          });
          break;
        case "ceiling":
          place(f, CEILING, brickWithStudAndReceptor(f), {
            x: STUD_LDU,
            z: 0,
            yPlates: CEILING_UNDERSIDE_PLATES,
            rot: 0,
          });
          break;
        case "floor":
          place(f, FLOOR, studAt(PLATE_LDU), { x: 2 * STUD_LDU, z: 0, yPlates: 0, rot: 0 });
          break;
        case "pillar":
          place(f, PILLAR, studAt(PILLAR_TOP_LDU), { x: 2 * STUD_LDU, z: 0, yPlates: 0, rot: 0 });
          break;
        default: {
          const unknown: never = neighbour;
          throw new Error(`no neighbour ${String(unknown)}`);
        }
      }
    }
    return f;
  }

  function sandwich(): Fixture {
    const f = scene(["wall", "ceiling"]);
    place(
      f,
      FLOOR,
      {
        connectors: f.connectors([grid(1, 1, f.stud, GENDER_MALE, PLATE_LDU, AXIS_POS_Y)]),
        volumes: columns(1, 1, 0, PLATE_LDU),
        parts: partsOf([[0, 0, 0, STUD_LDU, PLATE_LDU, STUD_LDU]]),
      },
      { x: STUD_LDU, z: 0, yPlates: 0, rot: 0 },
    );
    return f;
  }

  const outcome = (choice: PlacementChoice) => [
    choice.accepted,
    choice.x,
    choice.yPlates,
    choice.accepted ? NO_HIT : choice.overlap.owner,
  ];

  it.each([
    {
      name: "a nearer pose that only hangs from the ceiling and a farther one resting on the floor's stud",
      f: () => scene(["ceiling", "floor"]),
      held: brickWithStudAndReceptor,
      cursorX: 0,
      cells: 2,
      chosen: [true, 2 * STUD_LDU, HELD_PLATES, NO_HIT],
      atCursor: [false, 0, HELD_PLATES, NO_HIT],
    },
    {
      name: "a cursor pose that only hangs and a resting pose within reach",
      f: () => scene(["ceiling", "floor"]),
      held: brickWithStudAndReceptor,
      cursorX: STUD_LDU,
      cells: 1,
      chosen: [true, 2 * STUD_LDU, HELD_PLATES, NO_HIT],
      atCursor: [true, STUD_LDU, HELD_PLATES, NO_HIT],
    },
    {
      name: "held-out pair 4245, 3 in: the only mated pose in reach hangs from above, so assist keeps precise's refusal at the cursor",
      f: () => scene(["wall", "ceiling"]),
      held: brickWithStudAndReceptor,
      cursorX: 0,
      cells: 1,
      chosen: [false, 0, HELD_PLATES, WALL],
      atCursor: [false, 0, HELD_PLATES, WALL],
    },
    {
      name: "held-out pair 78, flush: the only mated pose in reach takes a stud from below but presses its own stud up into a partner, so assist keeps precise's refusal at the cursor",
      f: sandwich,
      held: brickWithStudAndReceptor,
      cursorX: 0,
      cells: 1,
      chosen: [false, 0, HELD_PLATES, WALL],
      atCursor: [false, 0, HELD_PLATES, WALL],
    },
    {
      name: "the only mated pose in reach takes a stud at the held model's upper layer while its lowest layer has nothing under it, so assist keeps precise's refusal at the cursor",
      f: () => scene(["wall", "pillar"]),
      held: bricksStepped,
      cursorX: 0,
      cells: 1,
      chosen: [false, 0, HELD_PLATES, WALL],
      atCursor: [false, 0, HELD_PLATES, WALL],
    },
    {
      name: "a mated cursor pose that only hangs, which assist keeps as precise does",
      f: () => scene(["ceiling"]),
      held: brickWithStudAndReceptor,
      cursorX: STUD_LDU,
      cells: 1,
      chosen: [true, STUD_LDU, HELD_PLATES, NO_HIT],
      atCursor: [true, STUD_LDU, HELD_PLATES, NO_HIT],
    },
  ])(
    "takes the nearest mated pose that rests on its lowest layer with nothing pressed up into a partner, and otherwise precise's verdict at the cursor: $name",
    ({ f: build, held, cursorX, cells, chosen, atCursor }) => {
      const f = build();
      const piece = held(f);
      const assist = choose(f, piece, window(cursorX, 0, cells, HELD_PLATES, 0));
      const precise = choose(f, piece, window(cursorX, 0, 0, HELD_PLATES, 0));
      expect({ assist: outcome(assist), precise: outcome(precise) }).toEqual({
        assist: chosen,
        precise: atCursor,
      });
    },
  );

  it("settles a sliced search on exactly the pose the whole search takes when it must walk past a nearer pose that only hangs", () => {
    const once = scene(["ceiling", "floor"]);
    const whole = choose(once, brickWithStudAndReceptor(once), window(0, 0, 2, HELD_PLATES, 0));
    const f = scene(["ceiling", "floor"]);
    const sliced = chooseInSlices(f, brickWithStudAndReceptor(f), window(0, 0, 2, HELD_PLATES, 0));
    expect([sliced.choice.x, sliced.choice.yPlates, sliced.choice.accepted]).toEqual([
      whole.x,
      whole.yPlates,
      whole.accepted,
    ]);
    expect([whole.x, sliced.slices > 1]).toEqual([2 * STUD_LDU, true]);
  });
});

interface Listed {
  readonly piece: Piece;
  readonly pose: LatticePose;
  readonly item: string;
}

class LiveWorld {
  readonly listed = new Map<number, Listed>();

  constructor(readonly search: IPlacementSearch) {}

  readonly restsOnTable = (placement: number): boolean =>
    this.listed.get(placement)?.pose.yPlates === TABLE_Y_PLATES;

  place(placement: number, piece: Piece, pose: LatticePose, item: string = TEST_ITEM): void {
    this.search.add(
      placement,
      piece.connectors,
      piece.volumes,
      piece.parts.boxes,
      piece.parts.technic,
      pose,
      item,
    );
    this.listed.set(placement, { piece, pose, item });
  }

  replace(placement: number): void {
    const entry = this.listed.get(placement);
    if (!entry) throw new Error(`placement ${placement} isn't listed`);
    this.search.remove(placement);
    this.listed.delete(placement);
    this.place(placement, entry.piece, entry.pose, entry.item);
  }

  stranded(removed: ReadonlySet<number>): unknown {
    return this.search.strandedByRemoval(removed, this.restsOnTable);
  }

  disagreement(removed: ReadonlySet<number>): unknown {
    const local = this.stranded(removed);
    const everyModel = this.everyModelChecked(removed);
    return JSON.stringify(local) === JSON.stringify(everyModel)
      ? null
      : { removed: [...removed], local, everyModel };
  }

  everyModelChecked(removed: ReadonlySet<number>): unknown {
    const report = new MateReport();
    const mated: Array<readonly [number, Listed]> = [];
    for (const [placement, entry] of this.listed) {
      if (removed.has(placement)) continue;
      this.search.evaluate(entry.piece.connectors, entry.pose, report);
      if (report.count > 0) mated.push([placement, entry]);
    }
    const lowestFirst = mated.toSorted(([, a], [, b]) => {
      if (listedBefore(a, b)) return -1;
      return listedBefore(b, a) ? 1 : 0;
    });
    return this.search.withdrawn(removed, () => {
      for (const [placement, entry] of lowestFirst) {
        this.search.evaluate(entry.piece.connectors, entry.pose, report);
        if (report.count === 0 && !this.restsOnTable(placement)) return stranded(placement);
      }
      return { kind: "none" };
    });
  }
}

function listedBefore(a: Listed, b: Listed): boolean {
  return lowerFirst(a.pose, a.item, b.pose, b.item);
}

function lowerFirst(
  pose: LatticePose,
  item: string,
  other: LatticePose,
  otherItem: string,
): boolean {
  const keys = [
    pose.yPlates - other.yPlates,
    pose.x - other.x,
    pose.z - other.z,
    pose.rot - other.rot,
  ];
  const differing = keys.find((key) => key !== 0);
  return differing === undefined ? item < otherItem : differing < 0;
}

const LCG_MULTIPLIER = 1664525;
const LCG_INCREMENT = 1013904223;
const UINT32_RANGE = 2 ** 32;

function seeded(seed: number): (below: number) => number {
  let state = seed >>> 0;
  return (below) => {
    state = (Math.imul(state, LCG_MULTIPLIER) + LCG_INCREMENT) >>> 0;
    return Math.floor((state / UINT32_RANGE) * below);
  };
}

function block(f: Fixture, width: number, depth: number, heightLdu: number): Piece {
  return {
    connectors: f.connectors([
      grid(width, depth, f.stud, GENDER_MALE, heightLdu, AXIS_POS_Y),
      grid(width, depth, f.receptor(heightLdu - 4), GENDER_FEMALE, 0, AXIS_NEG_Y),
    ]),
    volumes: columns(width, depth, 0, heightLdu),
    parts: partsOf([[0, 0, 0, width * STUD_LDU, heightLdu, depth * STUD_LDU]]),
  };
}

function studdedSlab(f: Fixture, width: number, depth: number): Piece {
  return {
    connectors: f.connectors([grid(width, depth, f.stud, GENDER_MALE, 0, AXIS_POS_Y)]),
    volumes: columns(width, depth, -SLAB_LDU, 0),
    parts: partsOf([[0, -SLAB_LDU, 0, width * STUD_LDU, 0, depth * STUD_LDU]]),
  };
}

function singleConnector(f: Fixture, spec: Spec, cell: Box): Piece {
  return {
    connectors: f.connectors([table([spec])]),
    volumes: boxVolumes(0, 0, 1, 1, [cell]),
    parts: partsOf([cell]),
  };
}

const CELL: Box = [0, 0, 0, STUD_LDU, PLATE_LDU, STUD_LDU];

function jumperPlate(f: Fixture): Piece {
  return {
    connectors: f.connectors([
      table([
        [f.receptor(4), GENDER_FEMALE, HALF, 0, HALF, AXIS_NEG_Y],
        [f.receptor(4), GENDER_FEMALE, HALF + STUD_LDU, 0, HALF, AXIS_NEG_Y],
        [f.stud, GENDER_MALE, STUD_LDU, PLATE_LDU, HALF, AXIS_POS_Y],
      ]),
    ]),
    volumes: columns(2, 1, 0, PLATE_LDU),
    parts: partsOf([[0, 0, 0, 2 * STUD_LDU, PLATE_LDU, STUD_LDU]]),
  };
}

function sideStudded(f: Fixture): Piece {
  return {
    connectors: f.connectors([
      table([
        [f.stud, GENDER_MALE, HALF, BRICK_LDU, HALF, AXIS_POS_Y],
        [f.receptor(BRICK_LDU - 4), GENDER_FEMALE, HALF, 0, HALF, AXIS_NEG_Y],
        [f.stud, GENDER_MALE, STUD_LDU, LINE_Y, HALF, AXIS_POS_X],
      ]),
    ]),
    volumes: columns(1, 1, 0, BRICK_LDU),
    parts: partsOf([[0, 0, 0, STUD_LDU, BRICK_LDU, STUD_LDU]]),
  };
}

function studdedTrack(f: Fixture, end: TrackEnd): Piece {
  const body = [0, 0, 0, 2 * STUD_LDU, PLATE_LDU, 2 * STUD_LDU];
  return {
    connectors: f.connectors([grid(2, 2, f.stud, GENDER_MALE, PLATE_LDU, AXIS_POS_Y)], [end]),
    volumes: boxVolumes(0, 0, 2, 2, [body]),
    parts: partsOf([body]),
  };
}

function connectorless(f: Fixture): Piece {
  return {
    connectors: f.connectors([null]),
    volumes: columns(2, 2, 0, BRICK_LDU),
    parts: partsOf([[0, 0, 0, 2 * STUD_LDU, BRICK_LDU, 2 * STUD_LDU]]),
  };
}

interface Joints {
  readonly bar: number;
  readonly clip: number;
  readonly hollowStud: number;
  readonly maleFinger: number;
  readonly femaleFinger: number;
  readonly axle: number;
  readonly axleHole: number;
}

const BAR_RADIUS = 4;
const BAR_LENGTH = STUD_LDU;
const CLIP_LENGTH = 4;
const FINGER_WIDTH = 8;
const NO_FINGER_RADIUS = 0;
const AXLE_RADIUS = 4;
const AXLE_LENGTH = 2 * STUD_LDU;
const AXLE_HOLE_LENGTH = 10;

function joints(f: Fixture): Joints {
  return {
    bar: f.shapes.intern(CAP_ROOT, true, [SECTION_ROUND], [BAR_RADIUS], [BAR_LENGTH]),
    clip: f.shapes.intern(0, false, [SECTION_ROUND], [BAR_RADIUS], [CLIP_LENGTH]),
    hollowStud: f.shapes.intern(0, false, [SECTION_ROUND], [BAR_RADIUS], [PLATE_LDU]),
    maleFinger: f.shapes.intern(
      0,
      false,
      [SECTION_MALE_FINGER],
      [NO_FINGER_RADIUS],
      [FINGER_WIDTH],
    ),
    femaleFinger: f.shapes.intern(
      0,
      false,
      [SECTION_FEMALE_FINGER],
      [NO_FINGER_RADIUS],
      [FINGER_WIDTH],
    ),
    axle: f.shapes.intern(CAP_ROOT, true, [SECTION_AXLE], [AXLE_RADIUS], [AXLE_LENGTH]),
    axleHole: f.shapes.intern(0, true, [SECTION_AXLE], [AXLE_RADIUS], [AXLE_HOLE_LENGTH]),
  };
}

interface Site {
  readonly x: number;
  readonly z: number;
  readonly turn: Rot90;
}

function sited(site: Site, x: number, z: number, yPlates: number, rot = 0): LatticePose {
  const cos = rot90Cos(site.turn);
  const sin = rot90Sin(site.turn);
  return {
    x: site.x + cos * x + sin * z,
    z: site.z - sin * x + cos * z,
    yPlates,
    rot: (rot + site.turn) % 4,
  };
}

interface Built {
  readonly carriers: ReadonlyArray<number>;
}

interface Placing {
  place(placement: number, piece: Piece, pose: LatticePose): void;
}

interface Builder {
  readonly live: Placing;
  readonly f: Fixture;
  readonly joints: Joints;
  readonly next: () => number;
  readonly pick: (below: number) => number;
}

type Scenario = (b: Builder, site: Site) => Built;

const RAISED_Y_PLATES = 4;

const towers: Scenario = (b, site) => {
  const base = b.next();
  b.live.place(base, studdedSlab(b.f, 4, 4), sited(site, 0, 0, 0));
  const carriers = [base];
  for (let tower = 0; tower < 2; tower++) {
    let yPlates = 0;
    const cellX = b.pick(3);
    const cellZ = b.pick(3);
    for (let level = 0; level < 1 + b.pick(4); level++) {
      const id = b.next();
      const tall = b.pick(2) === 0;
      const width = 1 + b.pick(2);
      b.live.place(
        id,
        block(b.f, width, 1, tall ? BRICK_LDU : PLATE_LDU),
        sited(site, cellX * STUD_LDU, cellZ * STUD_LDU, yPlates),
      );
      carriers.push(id);
      yPlates += tall ? 3 : 1;
    }
  }
  return { carriers };
};

const singleStudStack: Scenario = (b, site) => {
  const carriers: number[] = [];
  for (let level = 0; level < 2 + b.pick(2); level++) {
    const id = b.next();
    b.live.place(id, block(b.f, 1, 1, BRICK_LDU), sited(site, 0, 0, 3 * level));
    carriers.push(id);
  }
  return { carriers };
};

const jumped: Scenario = (b, site) => {
  const below = b.next();
  const plate = b.next();
  const above = b.next();
  b.live.place(below, block(b.f, 2, 1, BRICK_LDU), sited(site, 0, 0, 0));
  b.live.place(plate, jumperPlate(b.f), sited(site, 0, 0, 3));
  b.live.place(above, block(b.f, 1, 1, BRICK_LDU), sited(site, HALF, 0, 4));
  return { carriers: [below, plate] };
};

const snot: Scenario = (b, site) => {
  const below = b.next();
  const studded = b.next();
  const mounted = b.next();
  b.live.place(below, block(b.f, 1, 1, BRICK_LDU), sited(site, 0, 0, 0));
  b.live.place(studded, sideStudded(b.f), sited(site, 0, 0, 3));
  b.live.place(
    mounted,
    singleConnector(b.f, [b.f.receptor(4), GENDER_FEMALE, 0, LINE_Y, HALF, AXIS_NEG_X], CELL),
    sited(site, STUD_LDU, 0, 3),
  );
  return { carriers: [below, studded] };
};

const pinned: Scenario = (b, site) => {
  const bored = b.next();
  const holder = b.next();
  const yPlates = b.pick(2) === 0 ? 0 : RAISED_Y_PLATES;
  b.live.place(bored, boredBlock(b.f), sited(site, 0, 0, yPlates));
  b.live.place(holder, pinnedBlock(b.f, STUD_LDU), sited(site, 0, 0, yPlates));
  return { carriers: [holder, bored] };
};

const axled: Scenario = (b, site) => {
  const first = b.next();
  const second = b.next();
  const axle = b.next();
  const hole: Spec = [b.joints.axleHole, GENDER_FEMALE, LINE_X, LINE_Y, 0, AXIS_NEG_Z];
  const beam: Box = [0, 0, 0, 2 * STUD_LDU, BRICK_LDU, STUD_LDU];
  b.live.place(first, singleConnector(b.f, hole, beam), sited(site, 0, 0, RAISED_Y_PLATES));
  b.live.place(second, singleConnector(b.f, hole, beam), sited(site, 0, STUD_LDU, RAISED_Y_PLATES));
  b.live.place(
    axle,
    singleConnector(b.f, [b.joints.axle, GENDER_MALE, LINE_X, LINE_Y, 0, AXIS_POS_Z], CELL),
    sited(site, 0, 0, RAISED_Y_PLATES),
  );
  return { carriers: [axle, first] };
};

const clipped: Scenario = (b, site) => {
  const bar = b.next();
  const clip = b.next();
  const hollow = b.next();
  const pole = b.next();
  b.live.place(
    bar,
    singleConnector(b.f, [b.joints.bar, GENDER_MALE, 0, LINE_Y, HALF, AXIS_POS_X], CELL),
    sited(site, 0, 0, RAISED_Y_PLATES),
  );
  b.live.place(
    clip,
    singleConnector(b.f, [b.joints.clip, GENDER_FEMALE, 0, LINE_Y, HALF, AXIS_NEG_X], CELL),
    sited(site, 0, 0, RAISED_Y_PLATES),
  );
  b.live.place(
    hollow,
    singleConnector(
      b.f,
      [b.joints.hollowStud, GENDER_FEMALE, HALF, PLATE_LDU, HALF, AXIS_POS_Y],
      CELL,
    ),
    sited(site, 3 * STUD_LDU, 0, 0),
  );
  b.live.place(
    pole,
    singleConnector(b.f, [b.joints.bar, GENDER_MALE, HALF, 0, HALF, AXIS_NEG_Y], CELL),
    sited(site, 3 * STUD_LDU, 0, 1),
  );
  return { carriers: [bar, hollow] };
};

const hinged: Scenario = (b, site) => {
  const leaf = b.next();
  const flap = b.next();
  b.live.place(
    leaf,
    singleConnector(b.f, [b.joints.maleFinger, GENDER_MALE, 0, LINE_Y, HALF, AXIS_POS_X], CELL),
    sited(site, 0, 0, RAISED_Y_PLATES),
  );
  b.live.place(
    flap,
    singleConnector(b.f, [b.joints.femaleFinger, GENDER_FEMALE, 0, LINE_Y, HALF, AXIS_NEG_X], CELL),
    sited(site, 0, 0, RAISED_Y_PLATES),
  );
  return { carriers: [leaf] };
};

const turntable: Scenario = (b, site) => {
  const base = b.next();
  const top = b.next();
  b.live.place(
    base,
    singleConnector(b.f, [b.f.stud, GENDER_MALE, 0, PLATE_LDU, 0, AXIS_POS_Y], CELL),
    sited(site, 0, 0, 0),
  );
  b.live.place(
    top,
    singleConnector(b.f, [b.f.receptor(4), GENDER_FEMALE, 0, 0, 0, AXIS_NEG_Y], CELL),
    sited(site, 0, 0, 1),
  );
  return { carriers: [base] };
};

const tracked: Scenario = (b, site) => {
  const laid = b.next();
  const joined = b.next();
  b.live.place(laid, studdedTrack(b.f, straightEnd(2, 0)), sited(site, 0, 0, 2));
  b.live.place(joined, studdedTrack(b.f, straightEnd(0, 8)), sited(site, 2 * STUD_LDU, 0, 2));
  return { carriers: [laid] };
};

const loose: Scenario = (b, site) => {
  const standing = b.next();
  const floating = b.next();
  const lone = b.next();
  b.live.place(standing, connectorless(b.f), sited(site, 0, 0, 0));
  b.live.place(floating, connectorless(b.f), sited(site, 0, 3 * STUD_LDU, 2));
  b.live.place(lone, block(b.f, 2, 2, BRICK_LDU), sited(site, 4 * STUD_LDU, 0, 0));
  return { carriers: [standing] };
};

const BIG_STUDS = 48;

const big: Scenario = (b, site) => {
  const base = b.next();
  b.live.place(base, studdedSlab(b.f, BIG_STUDS, BIG_STUDS), sited(site, 0, 0, 0));
  const carriers = [base];
  for (let k = 0; k < 4; k++) {
    const id = b.next();
    b.live.place(
      id,
      block(b.f, 2, 2, BRICK_LDU),
      sited(site, b.pick(BIG_STUDS - 2) * STUD_LDU, b.pick(BIG_STUDS - 2) * STUD_LDU, 0),
    );
    carriers.push(id);
  }
  return { carriers };
};

const SCENARIOS: ReadonlyArray<Scenario> = [
  towers,
  singleStudStack,
  jumped,
  snot,
  pinned,
  axled,
  clipped,
  hinged,
  turntable,
  tracked,
  loose,
];

const SITE_SPACING_LDU = 1200;
const SITES_PER_ROW = 7;
const SITE_ROWS = 7;
const FIRST_GENERATED_ID = 100;
const SINGLE_REMOVALS = 30;
const TEN_REMOVALS = 8;
const HUNDRED_REMOVALS = 3;
const REORDERED_PER_DRAW = 2;
const CARRIER_SHARE_OF_TEN = 5;

interface GeneratedWorld {
  readonly live: LiveWorld;
  readonly solver: ConnectionSolver;
  readonly carriers: ReadonlyArray<number>;
  readonly placements: ReadonlyArray<number>;
}

function generatedWorld(seed: number): GeneratedWorld {
  const f = fixture();
  const live = new LiveWorld(f.search);
  const pick = seeded(seed);
  let id = FIRST_GENERATED_ID;
  const builder: Builder = { live, f, joints: joints(f), next: () => id++, pick };
  const carriers = generatedSites(builder, SITES_PER_ROW * SITE_ROWS);
  return { live, solver: f.solver, carriers, placements: [...live.listed.keys()] };
}

function generatedSites(builder: Builder, sites: number): number[] {
  const { pick } = builder;
  const carriers: number[] = [];
  for (let s = 0; s < sites; s++) {
    const turn = pick(4);
    if (!isRot90(turn)) throw new RangeError(`turn ${turn} is not a quarter turn`);
    const site: Site = {
      x: (s % SITES_PER_ROW) * SITE_SPACING_LDU + pick(2) * HALF,
      z: Math.floor(s / SITES_PER_ROW) * SITE_SPACING_LDU + pick(2) * HALF,
      turn,
    };
    const scenario = s === 0 ? big : (SCENARIOS[pick(SCENARIOS.length)] ?? towers);
    carriers.push(...scenario(builder, site).carriers);
  }
  return carriers;
}

function drawn(
  pick: (below: number) => number,
  from: ReadonlyArray<number>,
  count: number,
  into: Set<number>,
): void {
  for (let tries = 0; into.size < count && tries < 10 * count; tries++) {
    const placement = from[pick(from.length)];
    if (placement !== undefined) into.add(placement);
  }
}

function removalSets(
  generated: GeneratedWorld,
  pick: (below: number) => number,
): ReadonlyArray<ReadonlySet<number>> {
  const sets: Set<number>[] = [];
  for (let k = 0; k < SINGLE_REMOVALS; k++) {
    const one = new Set<number>();
    drawn(pick, pick(5) === 0 ? generated.placements : generated.carriers, 1, one);
    sets.push(one);
  }
  for (let k = 0; k < TEN_REMOVALS; k++) {
    const ten = new Set<number>();
    drawn(pick, generated.carriers, CARRIER_SHARE_OF_TEN, ten);
    drawn(pick, generated.placements, 10, ten);
    sets.push(ten);
  }
  for (let k = 0; k < HUNDRED_REMOVALS; k++) {
    const hundred = new Set<number>();
    drawn(pick, generated.placements, 100, hundred);
    sets.push(hundred);
  }
  return sets;
}

describe("PlacementSearch stranding by removal", () => {
  it.each([1, 2, 3])(
    "names the same stranded placement as checking every placed model and taking the lowest, then by x, z, turn and item, in generated worlds of stacks, jumpers, side studs, pins, axles, clips, hollow studs, hinges, turntables, joined track, connectorless and 2,304-stud models, turned and half a stud off the grid (seed %i)",
    (seed) => {
      const generated = generatedWorld(seed);
      const pick = seeded(seed * 7919);
      const disagreements: unknown[] = [];
      for (const removed of removalSets(generated, pick)) {
        const disagreement = generated.live.disagreement(removed);
        if (disagreement !== null) disagreements.push(disagreement);
        for (let k = 0; k < REORDERED_PER_DRAW; k++) {
          const moved = generated.placements[pick(generated.placements.length)];
          if (moved !== undefined) generated.live.replace(moved);
        }
      }
      expect(disagreements).toEqual([]);
    },
  );

  it("names a model held only by a side pin, a side stud or a track end on a studded model, whose stud boxes miss the removed holder's", () => {
    const f = fixture();
    const live = new LiveWorld(f.search);
    const raised = { x: 0, z: 0, yPlates: RAISED_Y_PLATES, rot: 0 };
    live.place(10, pinnedBlock(f, STUD_LDU), raised);
    live.place(11, boredBlock(f), raised);
    const studAt = { x: 20 * STUD_LDU, z: 0, yPlates: 0, rot: 0 };
    live.place(20, block(f, 1, 1, BRICK_LDU), studAt);
    live.place(21, sideStudded(f), { ...studAt, yPlates: 3 });
    live.place(
      22,
      singleConnector(f, [f.receptor(4), GENDER_FEMALE, 0, LINE_Y, HALF, AXIS_NEG_X], CELL),
      { ...studAt, x: studAt.x + STUD_LDU, yPlates: 3 },
    );
    const trackAt = { x: 40 * STUD_LDU, z: 0, yPlates: 2, rot: 0 };
    live.place(30, studdedTrack(f, straightEnd(2, 0)), trackAt);
    live.place(31, studdedTrack(f, straightEnd(0, 8)), {
      ...trackAt,
      x: trackAt.x + 2 * STUD_LDU,
    });
    expect([
      live.stranded(new Set([10])),
      live.stranded(new Set([21])),
      live.stranded(new Set([30])),
    ]).toEqual([stranded(11), stranded(22), stranded(31)]);
  });

  it("names a model held only by studs, including a 1×1 brick on a 1×1 brick whose stud boxes are one shared point", () => {
    const f = fixture();
    const live = new LiveWorld(f.search);
    live.place(40, block(f, 2, 1, BRICK_LDU), ORIGIN);
    live.place(41, block(f, 2, 1, BRICK_LDU), { ...ORIGIN, yPlates: 3 });
    const single = { x: 10 * STUD_LDU, z: 0, yPlates: 0, rot: 0 };
    live.place(42, block(f, 1, 1, BRICK_LDU), single);
    live.place(43, block(f, 1, 1, BRICK_LDU), { ...single, yPlates: 3 });
    expect([live.stranded(new Set([40])), live.stranded(new Set([42]))]).toEqual([
      stranded(41),
      stranded(43),
    ]);
  });

  it("names the stranded placement first by height, then x, z and turn, then placeable id, whatever order the search holds them", () => {
    const f = fixture();
    const live = new LiveWorld(f.search);
    live.place(50, block(f, 2, 1, BRICK_LDU), ORIGIN);
    live.place(55, block(f, 1, 1, BRICK_LDU), { ...ORIGIN, yPlates: 3 });
    live.place(53, block(f, 1, 1, BRICK_LDU), { ...ORIGIN, x: STUD_LDU, yPlates: 3 });
    const first = live.stranded(new Set([50]));
    live.replace(55);
    expect([first, live.stranded(new Set([50]))]).toEqual([stranded(55), stranded(55)]);
  });

  it("still answers waiting first, for a removed placement that waits and for one that waits beside a removed one, before checking any neighbour", () => {
    const f = fixture();
    const live = new LiveWorld(f.search);
    live.place(60, block(f, 2, 1, BRICK_LDU), ORIGIN);
    live.place(61, block(f, 1, 1, BRICK_LDU), { ...ORIGIN, yPlates: 3 });
    const beside = block(f, 1, 1, BRICK_LDU);
    f.search.awaitTables(62, beside.volumes, { ...ORIGIN, x: 2 * STUD_LDU });
    expect([live.stranded(new Set([60])), live.stranded(new Set([62, 60]))]).toEqual([
      { kind: "waiting", placement: 62, failed: false },
      { kind: "waiting", placement: 62, failed: false },
    ]);
  });

  it("refuses to check a removal while other placements are withdrawn", () => {
    const f = fixture();
    const live = new LiveWorld(f.search);
    live.place(70, block(f, 2, 1, BRICK_LDU), ORIGIN);
    live.place(71, block(f, 1, 1, BRICK_LDU), { ...ORIGIN, yPlates: 3 });
    live.place(72, block(f, 1, 1, BRICK_LDU), { ...ORIGIN, x: 10 * STUD_LDU });
    expect(() => f.search.withdrawn(new Set([72]), () => live.stranded(new Set([70])))).toThrow(
      "placements are already withdrawn",
    );
  });
});

const OFFICIAL_BASEPLATE = "generated:baseplate-3811";
const OFFICIAL_BRICK = "generated:brick-2x4";
const OFFICIAL_JUMPER = "generated:jumper";
const ON_THE_TABLE_FAR_AWAY = 50 * STUD_LDU;

async function officialParts() {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(fixtureBundleFetcher());
  const catalog = container.get(PLACEABLE_CATALOG);
  await catalog.start(await container.get(PART_BUNDLE_LOADER).loadIndex("standard"));
  const tables = container.get(CONNECTOR_TABLES);
  const search = container.get(PLACEMENT_SEARCH);
  const loaded = async (item: string) => {
    const placeable = await catalog.load(catalog.itemRefId(item) ?? -1);
    const { tables: parts } = await tables.load(placeable);
    return { placeable, parts };
  };
  const piece = async (item: string): Promise<Piece> => {
    const { placeable, parts } = await loaded(item);
    const boxes = partBoxes(placeable.partBoxes);
    return {
      connectors: search.model(parts, placeable.partTransforms, []),
      volumes: FrozenVolumes.ofPlaceable(placeable),
      parts: {
        boxes,
        technic: FrozenTechnic.ofParts(
          catalog.parts().map((part) => part.technic),
          placeable.partTransforms,
          boxes.boxes,
        ),
      },
    };
  };
  const officialBrick = await piece(OFFICIAL_BRICK);
  const brick = await loaded(OFFICIAL_BRICK);
  const jumper = await loaded(OFFICIAL_JUMPER);
  const brickPart = brick.placeable.partTransforms.partIndex[0] ?? 0;
  const jumperPart = jumper.placeable.partTransforms.partIndex[0] ?? 0;
  const brickAt = Array.from(brick.placeable.partTransforms.matrices.subarray(0, MATRIX_FLOATS));
  const jumperAt = Array.from(jumper.placeable.partTransforms.matrices.subarray(0, MATRIX_FLOATS));
  const both = Array.from(
    { length: Math.max(brick.parts.length, jumper.parts.length) },
    (_, i) => brick.parts[i] ?? jumper.parts[i] ?? null,
  );
  const custom = (partIndex: ReadonlyArray<number>, matrices: ReadonlyArray<number>): Piece => ({
    ...officialBrick,
    connectors: search.model(
      both,
      { count: partIndex.length, partIndex, matrices: Float64Array.from(matrices) },
      [],
    ),
  });
  return {
    live: new LiveWorld(search),
    solver: container.get(CONNECTION_SOLVER),
    shapes: container.get(SNAP_SHAPES),
    officialBaseplate: await piece(OFFICIAL_BASEPLATE),
    officialBrick,
    officialJumper: await piece(OFFICIAL_JUMPER),
    sideStudPair: custom(
      [brickPart, brickPart],
      [...brickAt, ...turnedOnItsSide(brickAt, BRICK_PAIR_LIFT_LDU)],
    ),
    jumperOnBrick: custom([brickPart, jumperPart], [...brickAt, ...lifted(jumperAt, BRICK_LDU)]),
  };
}

const MATRIX_FLOATS = 12;
const BRICK_PAIR_LIFT_LDU = 2 * BRICK_LDU;

function lifted(matrix: ReadonlyArray<number>, ldu: number): number[] {
  return matrix.map((value, k) => (k === 7 ? value + ldu : value));
}

function turnedOnItsSide(matrix: ReadonlyArray<number>, liftLdu: number): number[] {
  const [a = 0, b = 0, c = 0, x = 0, d = 0, e = 0, f = 0, y = 0, g = 0, h = 0, i = 0, z = 0] =
    matrix;
  return [a, b, c, x, -g, -h, -i, liftLdu - z, d, e, f, y];
}

function seatedNear(live: LiveWorld, piece: Piece, at: PlacementWindow): LatticePose {
  const choice = placementChoice();
  live.search.search(
    piece.connectors,
    piece.volumes,
    piece.parts.boxes,
    piece.parts.technic,
    at,
    TABLE_Y_PLATES,
    null,
    choice,
  );
  if (!choice.accepted || choice.votes === 0) {
    throw new Error(`no mated pose near ${at.x}, ${at.z}, ${at.yPlates}`);
  }
  return { x: choice.x, z: choice.z, yPlates: choice.yPlates, rot: choice.rot };
}

describe("PlacementSearch stranding by removal, on official parts", () => {
  it("names what the generated official-part scenes leave stranded, as checking every placed model does: a 3001 on a 3001 on a 3811, and a 3001 on a 3794b jumper's off-centre stud on a 3001, where the jumper is stranded only when both neighbours go", async () => {
    const { live, officialBaseplate, officialBrick, officialJumper } = await officialParts();
    live.place(80, officialBaseplate, ORIGIN);
    const lower = seatedNear(live, officialBrick, window(2 * STUD_LDU, 2 * STUD_LDU, 1));
    live.place(81, officialBrick, lower);
    live.place(
      82,
      officialBrick,
      seatedNear(live, officialBrick, window(lower.x, lower.z, 1, lower.yPlates + 3)),
    );
    const carrier = { x: ON_THE_TABLE_FAR_AWAY, z: 0, yPlates: 0, rot: 0 };
    live.place(83, officialBrick, carrier);
    const seated = seatedNear(live, officialJumper, window(carrier.x, carrier.z, 1, 3));
    live.place(84, officialJumper, seated);
    live.place(
      85,
      officialBrick,
      seatedNear(live, officialBrick, window(seated.x + HALF, seated.z, 1, seated.yPlates + 1)),
    );
    const placements = [80, 81, 82, 83, 84, 85];
    const disagreements: unknown[] = [];
    for (let a = 0; a < placements.length; a++) {
      for (let b = a; b < placements.length; b++) {
        const disagreement = live.disagreement(new Set([placements[a] ?? 0, placements[b] ?? 0]));
        if (disagreement !== null) disagreements.push(disagreement);
      }
    }
    expect({
      disagreements,
      underTheTop: live.stranded(new Set([81])),
      underAndOverTheJumper: live.stranded(new Set([83, 85])),
      theJumper: live.stranded(new Set([84])),
    }).toEqual({
      disagreements: [],
      underTheTop: stranded(82),
      underAndOverTheJumper: stranded(84),
      theJumper: stranded(85),
    });
  }, 60_000);
});

interface CarryWorld {
  readonly live: LiveWorld;
  readonly solver: ConnectionSolver;
}

type CarryEnding = "cancel" | "drop" | "drop, undo and redo" | "throw";

const CARRY_ENDINGS: ReadonlyArray<CarryEnding> = [
  "cancel",
  "drop",
  "throw",
  "drop, undo and redo",
];
const CARRY_MOVES = 20;
const CARRY_TURN_AT = 10;
const CARRY_STEPS_LDU = [HALF, STUD_LDU, -HALF, 2 * STUD_LDU, STUD_LDU, -STUD_LDU, 8 * STUD_LDU];
const DROPPED = "dropped mid-carry";
const CARRY_TIMEOUT_MS = 60_000;

function droppedBy(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    if (error instanceof Error && error.message === DROPPED) return;
    throw error;
  }
  throw new Error(`the carry wasn't ${DROPPED}`);
}

function carriedTo(
  at: LatticePose,
  dx: number,
  dz: number,
  pivot: LatticePose | null,
): LatticePose {
  const moved = { ...at, x: at.x + dx, z: at.z + dz };
  if (!pivot) return moved;
  return {
    x: pivot.x + (moved.z - pivot.z),
    z: pivot.z - (moved.x - pivot.x),
    yPlates: moved.yPlates,
    rot: (moved.rot + 1) % 4,
  };
}

function reportLine(report: MateReport): string {
  const rows: number[][] = [];
  for (let k = 0; k < report.count; k++) {
    rows.push([
      report.connector[k] ?? 0,
      report.shape[k] ?? 0,
      report.partnerShape[k] ?? 0,
      report.sourceMask[k] ?? 0,
      report.status[k] ?? 0,
      report.family[k] ?? 0,
      report.partner[k] ?? 0,
      report.instance[k] ?? 0,
      report.partnerInstance[k] ?? 0,
      report.joint[k] ?? 0,
      ...report.engagement.subarray(k * 6, (k + 1) * 6),
    ]);
  }
  return JSON.stringify(rows);
}

class CarryAgainstOracle {
  readonly subjectLog: string[] = [];
  readonly oracleLog: string[] = [];
  private readonly report = new MateReport();

  constructor(
    readonly subject: CarryWorld,
    readonly oracle: CarryWorld,
  ) {}

  carry(members: ReadonlyArray<number>, ending: CarryEnding): void {
    const held = new Set(members);
    const from = members.map((id) => this.subject.live.listed.get(id)?.pose ?? ORIGIN);
    const pivotAt = from[0] ?? ORIGIN;
    let dx = 0;
    let dz = 0;
    let targets = from;
    for (let move = 0; move < CARRY_MOVES; move++) {
      const step = CARRY_STEPS_LDU[move % CARRY_STEPS_LDU.length] ?? STUD_LDU;
      if (move % 2 === 0) dx += step;
      else dz += step;
      const pivot = move >= CARRY_TURN_AT ? pivotAt : null;
      targets = from.map((at) => carriedTo(at, dx, dz, pivot));
      const throws = ending === "throw" && move === CARRY_MOVES - 1;
      const asked = targets;
      const subjectMove = (): void => {
        this.ask(this.subject, members, asked, this.subjectLog);
        if (throws) throw new Error(DROPPED);
      };
      if (throws) droppedBy(() => this.subject.live.search.withdrawn(held, subjectMove));
      else this.subject.live.search.withdrawn(held, subjectMove);
      this.eagerly(members, asked);
    }
    if (ending === "drop" || ending === "drop, undo and redo") {
      this.relay(members, targets);
      if (ending === "drop, undo and redo") {
        this.relay(members, from);
        this.relay(members, targets);
      }
    }
    for (const side of [this.subject, this.oracle]) {
      const log = side === this.subject ? this.subjectLog : this.oracleLog;
      this.ask(
        side,
        members,
        members.map((id) => side.live.listed.get(id)?.pose ?? ORIGIN),
        log,
      );
    }
  }

  private ask(
    side: CarryWorld,
    members: ReadonlyArray<number>,
    at: ReadonlyArray<LatticePose>,
    log: string[],
  ): void {
    members.forEach((id, i) => {
      const piece = side.live.listed.get(id)?.piece;
      const pose = at[i];
      if (!piece || !pose) return;
      side.live.search.evaluate(piece.connectors, pose, this.report);
      log.push(`${id} ${JSON.stringify(pose)}: ${reportLine(this.report)}`);
    });
  }

  private eagerly(members: ReadonlyArray<number>, at: ReadonlyArray<LatticePose>): void {
    const { live, solver } = this.oracle;
    for (const id of members) {
      const entry = live.listed.get(id);
      if (entry) solver.remove(entry.piece.connectors, entry.pose, id);
    }
    try {
      this.ask(this.oracle, members, at, this.oracleLog);
    } finally {
      for (const id of members) {
        const entry = live.listed.get(id);
        if (entry) solver.insert(entry.piece.connectors, entry.pose, id);
      }
    }
  }

  private relay(members: ReadonlyArray<number>, to: ReadonlyArray<LatticePose>): void {
    for (const side of [this.subject, this.oracle]) {
      const pieces = members.map((id) => side.live.listed.get(id)?.piece);
      for (const id of members) {
        side.live.search.remove(id);
        side.live.listed.delete(id);
      }
      members.forEach((id, i) => {
        const piece = pieces[i];
        const pose = to[i];
        if (piece && pose) side.live.place(id, piece, pose);
      });
    }
  }
}

const CARRY_GROUPS = [1, 10, 100, 1, 10, 100, 1, 10];

describe("PlacementSearch withdrawals during carries", () => {
  it.each([1, 2])(
    "answers carries of 1, 10 and 100 placements of generated stacks, jumpers, side studs, pins, axles, clips, hinges, turntables and joined track, turned mid-carry and dropped, cancelled, undone and redone or thrown out of, exactly as removing and re-inserting them around each move does (seed %i)",
    (seed) => {
      const subject = generatedWorld(seed);
      const pair = new CarryAgainstOracle(subject, generatedWorld(seed));
      const pick = seeded(seed * 104_729);
      CARRY_GROUPS.forEach((size, k) => {
        const members = new Set<number>();
        drawn(pick, subject.placements, size, members);
        pair.carry([...members], CARRY_ENDINGS[k % CARRY_ENDINGS.length] ?? "cancel");
      });
      expect(pair.subjectLog.length).toBeGreaterThan(0);
      expect(pair.subjectLog).toEqual(pair.oracleLog);
    },
    CARRY_TIMEOUT_MS,
  );
});

type OfficialParts = Awaited<ReturnType<typeof officialParts>>;

const OFFICIAL_ROWS = 10;
const OFFICIAL_COLUMNS = 12;
const OFFICIAL_SPACING_STUDS = 3;
const STACKED_EVERY = 3;

function officialWorld(parts: OfficialParts): ReadonlyArray<number> {
  const { live } = parts;
  live.place(1, parts.officialBaseplate, ORIGIN);
  const seat = seatedNear(live, parts.officialBrick, window(2 * STUD_LDU, 2 * STUD_LDU, 1));
  const kinds = [
    parts.officialBrick,
    parts.officialJumper,
    parts.sideStudPair,
    parts.jumperOnBrick,
  ];
  const placed: number[] = [];
  let id = 2;
  for (let row = 0; row < OFFICIAL_ROWS; row++) {
    for (let column = 0; column < OFFICIAL_COLUMNS; column++) {
      const k = row * OFFICIAL_COLUMNS + column;
      const turn = k % 4;
      if (!isRot90(turn)) throw new RangeError(`turn ${turn} is not a quarter turn`);
      const at = {
        x: seat.x + column * OFFICIAL_SPACING_STUDS * STUD_LDU + (k % 5 === 0 ? HALF : 0),
        z: seat.z + row * OFFICIAL_SPACING_STUDS * STUD_LDU,
        yPlates: seat.yPlates + (k % STACKED_EVERY === 0 ? 3 : 0),
        rot: turn,
      };
      live.place(id, kinds[k % kinds.length] ?? parts.officialBrick, at);
      placed.push(id++);
    }
  }
  return placed;
}

describe("PlacementSearch withdrawals during carries, on official parts", () => {
  it(
    "answers carries of 1, 10 and 100 official 3001s and 3794b jumpers and custom models built from their tables, a 3001 with a 3001 on its side and a 3794b on a 3001, on an official 3811, exactly as removing and re-inserting them around each move does",
    async () => {
      const subject = await officialParts();
      const oracle = await officialParts();
      const placed = officialWorld(subject);
      officialWorld(oracle);
      const pair = new CarryAgainstOracle(subject, oracle);
      const pick = seeded(20261125);
      CARRY_GROUPS.forEach((size, k) => {
        const members = new Set<number>();
        drawn(pick, placed, size, members);
        pair.carry([...members], CARRY_ENDINGS[k % CARRY_ENDINGS.length] ?? "cancel");
      });
      const side = subject.sideStudPair.connectors;
      expect({
        jumperSeatedOnItsBrick: subject.jumperOnBrick.connectors.internalMates > 0,
        sideStuds: Array.from(side.axis.subarray(0, side.count)).some(
          (axis) => axis === AXIS_POS_Z || axis === AXIS_NEG_Z,
        ),
        carried: pair.subjectLog.length > 0,
      }).toEqual({ jumperSeatedOnItsBrick: true, sideStuds: true, carried: true });
      expect(pair.subjectLog).toEqual(pair.oracleLog);
    },
    CARRY_TIMEOUT_MS,
  );
});

interface RecordedPlacement {
  readonly id: number;
  readonly piece: Piece;
  readonly pose: LatticePose;
}

interface Probe {
  readonly name: string;
  readonly piece: Piece;
  readonly pose: LatticePose;
}

interface CanonicalRecipe {
  readonly f: Fixture;
  readonly placed: ReadonlyArray<RecordedPlacement>;
  readonly probes: ReadonlyArray<Probe>;
  readonly walks: ReadonlyArray<ReadonlyArray<Probe>>;
  readonly items: ReadonlyMap<Piece, string>;
}

const CANONICAL_SITES = 16;
const GENERATED_OWNERS = 10;
const GENERATED_ROWS = 300;
const GENERATED_CONNECTORS = 40;
const WITNESS_X = 30_000;
const FIELD_X = 40_000;
const FIELDS = 6;
const LARGE_SLAB = 24;
const LARGE_PLATE = 20;
const FIELD_SPACING = 2000;
const FIELD_ROWS = 8;
const FIELD_PIN_ROWS = 4;
const FIELD_SPREAD = 12;
const FIELD_WALK = 24;
const LONG_PIN = 2 * STUD_LDU;
const SHORT_PIN = 8;
const FIELD_PIN = 16;
const BORE_ROW = 6;
const PIN_ROW = 4;
const REMOVE_CYCLES = 25;
const CANONICAL_CARRIES = 5;
const CANONICAL_CARRY_SIZE = 8;
const WARM_UPS = 40;
const CLASS_WITNESS_SHALLOW = 6;
const CLASS_WITNESS_DEEP = 12;

function internInAnotherOrder(shapes: SnapShapes): void {
  const pin = (length: number): number =>
    shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [6], [length]);
  shapes.intern(0, false, [SECTION_ROUND], [6], [2 * STUD_LDU]);
  shapes.intern(0, true, [SECTION_ROUND, SECTION_ROUND, SECTION_ROUND], [8, 6, 8], [2, 16, 2]);
  shapes.intern(0, false, [SECTION_ROUND, SECTION_ROUND, SECTION_ROUND], [8, 6, 8], [2, 16, 2]);
  for (const length of [LONG_PIN, FIELD_PIN, SHORT_PIN]) pin(length);
  for (const depth of [BRICK_LDU - 4, CLASS_WITNESS_DEEP, CLASS_WITNESS_SHALLOW, 4]) {
    shapes.intern(CAP_FAR, false, [SECTION_ROUND], [6], [depth]);
  }
  pin(4);
}

function boreRow(f: Fixture): Piece {
  const bores = Array.from({ length: BORE_ROW }, (_, k): Spec[] => [
    [f.boreEnd, GENDER_FEMALE, HALF + k * STUD_LDU, LINE_Y, 0, AXIS_NEG_Z],
    [f.boreEnd, GENDER_FEMALE, HALF + k * STUD_LDU, LINE_Y, STUD_LDU, AXIS_POS_Z],
  ]).flat();
  return {
    connectors: f.connectors([table(bores)]),
    volumes: columns(BORE_ROW, 1, 0, BRICK_LDU),
    parts: partsOf([[0, 0, 0, BORE_ROW * STUD_LDU, BRICK_LDU, STUD_LDU]]),
  };
}

function pinRow(f: Fixture): Piece {
  return {
    connectors: f.connectors([
      table(
        Array.from({ length: PIN_ROW }, (_, k): Spec => [
          f.pinEnd(k === PIN_ROW - 1 ? SHORT_PIN : FIELD_PIN),
          GENDER_MALE,
          HALF + k * STUD_LDU,
          LINE_Y,
          0,
          AXIS_NEG_Z,
        ]),
      ),
    ]),
    volumes: columns(PIN_ROW, 1, 0, BRICK_LDU),
    parts: partsOf([[0, 0, 0, PIN_ROW * STUD_LDU, BRICK_LDU, STUD_LDU]]),
  };
}

function studdedBore(f: Fixture): Piece {
  return {
    connectors: f.connectors([
      boreEnds(f, 0),
      table([[f.stud, GENDER_MALE, HALF, BRICK_LDU, HALF, AXIS_POS_Y]]),
    ]),
    volumes: columns(2, 1, 0, BRICK_LDU),
    parts: partsOf([BLOCK, BLOCK], [bore(0), null]),
  };
}

function bareTrack(f: Fixture, end: TrackEnd): Piece {
  const body = [0, 0, 0, 2 * STUD_LDU, PLATE_LDU, 2 * STUD_LDU];
  return {
    connectors: f.connectors([null], [end]),
    volumes: boxVolumes(0, 0, 2, 2, [body]),
    parts: partsOf([body]),
  };
}

function longAndShortPins(f: Fixture): Piece {
  return {
    connectors: f.connectors([
      table([
        [f.pinEnd(LONG_PIN), GENDER_MALE, LINE_X, LINE_Y, 0, AXIS_NEG_Z],
        [f.pinEnd(SHORT_PIN), GENDER_MALE, LINE_X, LINE_Y, 0, AXIS_NEG_Z],
      ]),
    ]),
    volumes: columns(2, 1, 0, BRICK_LDU),
    parts: partsOf([BLOCK]),
  };
}

function twoBorePartner(f: Fixture): Piece {
  const near = [0, 0, -STUD_LDU, 2 * STUD_LDU, BRICK_LDU, 0];
  const far = [0, 0, -2 * STUD_LDU, 2 * STUD_LDU, BRICK_LDU, -STUD_LDU];
  return {
    connectors: f.connectors([boreEnds(f, -STUD_LDU), boreEnds(f, -2 * STUD_LDU)]),
    volumes: boxVolumes(0, -2, 2, 2, [near, far]),
    parts: partsOf([near, far], [bore(-STUD_LDU), bore(-2 * STUD_LDU)]),
  };
}

function contentKey(f: Fixture, piece: Piece): string {
  const model = piece.connectors;
  const connectors = Array.from({ length: model.count }, (_, k) => [
    model.gender[k],
    model.axis[k],
    ...model.origin.subarray(k * 3, k * 3 + 3),
    shapeContent(f.shapes, model.shape[k] ?? NO_SHAPE),
  ]);
  return JSON.stringify([
    connectors,
    [...model.trackHeading],
    [...model.trackPosition],
    [...model.trackYPlates],
  ]);
}

function flat(x: number, z: number, yPlates = 0): LatticePose {
  return { x, z, yPlates, rot: 0 };
}

function reinsertedAs(
  parts: OfficialParts,
  owners: ReadonlyArray<number>,
  first: number,
): number[] {
  return owners.map((owner, k) => {
    const listed = parts.live.listed.get(owner);
    if (!listed) throw new Error(`placement ${owner} isn't listed`);
    parts.live.search.remove(owner);
    parts.live.listed.delete(owner);
    parts.live.place(first + k, listed.piece, listed.pose);
    return first + k;
  });
}

function officialName(parts: OfficialParts, piece: Piece): string {
  return (
    new Map<Piece, string>([
      [parts.officialBaseplate, "3811"],
      [parts.officialBrick, "3001"],
      [parts.officialJumper, "3794b"],
      [parts.sideStudPair, "3001 on its side over a 3001"],
      [parts.jumperOnBrick, "3794b on a 3001"],
    ]).get(piece) ?? "unknown"
  );
}

function canonicalRecipe(f: Fixture, seed: number): CanonicalRecipe {
  const placed: RecordedPlacement[] = [];
  const recorded: Placing = {
    place: (placement, piece, pose) => {
      placed.push({ id: placement, piece, pose });
    },
  };
  let id = FIRST_GENERATED_ID;
  const next = (): number => id++;
  const pick = seeded(seed);
  generatedSites({ live: recorded, f, joints: joints(f), next, pick }, CANONICAL_SITES);
  const probes: Probe[] = [];
  const duplicates = flat(WITNESS_X, 0);
  recorded.place(next(), boredBlock(f), duplicates);
  recorded.place(next(), studdedBore(f), duplicates);
  probes.push({
    name: "pin into two bored items at one pose",
    piece: pinnedBlock(f, STUD_LDU),
    pose: duplicates,
  });
  const classes = flat(WITNESS_X + 10 * STUD_LDU, 0);
  recorded.place(
    next(),
    singleConnector(
      f,
      [f.receptor(CLASS_WITNESS_SHALLOW), GENDER_FEMALE, HALF, 0, HALF, AXIS_NEG_Y],
      CELL,
    ),
    {
      ...classes,
      yPlates: 1,
    },
  );
  recorded.place(
    next(),
    singleConnector(
      f,
      [f.receptor(CLASS_WITNESS_DEEP), GENDER_FEMALE, HALF, 0, HALF, AXIS_NEG_Y],
      CELL,
    ),
    { ...classes, yPlates: 1 },
  );
  probes.push({
    name: "stud under two receptor classes",
    piece: singleConnector(f, [f.stud, GENDER_MALE, HALF, PLATE_LDU, HALF, AXIS_POS_Y], CELL),
    pose: classes,
  });
  const holders = flat(WITNESS_X + 20 * STUD_LDU, 0);
  recorded.place(next(), studdedTrack(f, straightEnd(2, 0)), holders);
  recorded.place(next(), bareTrack(f, straightEnd(2, 0)), holders);
  probes.push({
    name: "track end on two holders",
    piece: studdedTrack(f, straightEnd(0, 8)),
    pose: { ...holders, x: holders.x + 2 * STUD_LDU },
  });
  const instances = flat(WITNESS_X + 30 * STUD_LDU, 0);
  recorded.place(next(), twoBorePartner(f), instances);
  probes.push({
    name: "long and short pin through a two-part partner",
    piece: longAndShortPins(f),
    pose: instances,
  });
  const slab = flat(WITNESS_X + 40 * STUD_LDU, 0);
  recorded.place(next(), studdedSlab(f, LARGE_SLAB, LARGE_SLAB), slab);
  probes.push({
    name: "a large plate on a slab",
    piece: block(f, LARGE_PLATE, LARGE_PLATE, PLATE_LDU),
    pose: slab,
  });
  const walks: Probe[][] = [];
  for (let field = 0; field < FIELDS; field++) {
    const rows: LatticePose[] = [];
    for (let row = 0; row < FIELD_ROWS; row++) {
      const pose = flat(
        FIELD_X + field * FIELD_SPACING + pick(FIELD_SPREAD) * HALF,
        pick(FIELD_SPREAD) * STUD_LDU,
      );
      recorded.place(next(), boreRow(f), pose);
      rows.push(pose);
    }
    for (let walk = 0; walk < FIELD_PIN_ROWS; walk++) {
      const steps: Probe[] = [];
      const start = rows[pick(rows.length)] ?? flat(FIELD_X, 0);
      let pose = { ...start, x: start.x + pick(3) * STUD_LDU, z: start.z + STUD_LDU };
      const piece = pinRow(f);
      for (let s = 0; s < FIELD_WALK; s++) {
        pose =
          s % 2 === 0
            ? { ...pose, x: pose.x + (pick(3) - 1) * STUD_LDU }
            : { ...pose, z: pose.z + (pick(3) - 1) * STUD_LDU };
        steps.push({ name: `field ${field} pin row ${walk} step ${s}`, piece, pose });
      }
      walks.push(steps);
    }
  }
  for (const { piece, pose } of placed)
    probes.push({ name: "a placed piece at its pose", piece, pose });
  const items = new Map<Piece, string>();
  const keys = new Map<string, string>();
  for (const { piece } of [...placed, ...probes, ...walks.flat()]) {
    const key = contentKey(f, piece);
    const item = keys.get(key) ?? `item ${keys.size}`;
    keys.set(key, item);
    items.set(piece, item);
  }
  return { f, placed, probes, walks, items };
}

class CanonicalHistory {
  readonly live: LiveWorld;
  private readonly report = new MateReport();
  private readonly studShapes: ReadonlySet<number>;

  constructor(readonly recipe: CanonicalRecipe) {
    this.live = new LiveWorld(recipe.f.search);
    this.studShapes = new Set([recipe.f.stud]);
  }

  insert(order: ReadonlyArray<number>, idOf: (position: number) => number): void {
    order.forEach((k, position) => {
      const entry = this.recipe.placed[k];
      if (entry) this.live.place(idOf(position), entry.piece, entry.pose);
    });
  }

  readonly view = (owner: number): PlacedModelView | null => {
    const listed = this.live.listed.get(owner);
    if (!listed) return null;
    const item = this.recipe.items.get(listed.piece) ?? "unknown";
    return { item, label: item, pose: listed.pose };
  };

  evaluate(probe: Probe): MateReport {
    this.live.search.evaluate(probe.piece.connectors, probe.pose, this.report);
    return this.report;
  }

  hover(report: MateReport): string {
    return talliesJson(mateCounts(report, this.recipe.f.shapes, this.studShapes, this.view));
  }

  raw(report: MateReport): string {
    const rows: unknown[] = [];
    for (let k = 0; k < report.count; k++) {
      const partner = report.partner[k] ?? NO_PARTNER;
      const view = partner === NO_PARTNER ? null : this.view(partner);
      rows.push([
        report.family[k],
        report.connector[k],
        view ? [view.item, view.pose] : null,
        report.partnerInstance[k],
        shapeContent(this.recipe.f.shapes, report.partnerShape[k] ?? NO_SHAPE),
      ]);
    }
    return JSON.stringify(rows);
  }

  expected(report: MateReport): string {
    return talliesJson(
      specifiedMateCounts(report, this.recipe.f.shapes, this.studShapes, this.view),
    );
  }
}

function shapeContent(shapes: SnapShapes, shape: number): unknown {
  if (shape === NO_SHAPE) return null;
  const first = shapes.firstSection(shape);
  return [
    shapes.caps(shape),
    shapes.slides(shape),
    shapes.groupName(shape),
    Array.from({ length: shapes.sectionCount(shape) }, (_, s) => [
      shapes.internedCode(first + s),
      shapes.internedSize(first + s),
      shapes.span(first + s),
    ]),
  ];
}

function talliesJson(mates: ReadonlyArray<HoverMateCount>): string {
  return JSON.stringify(mates.map((mate) => ({ ...mate, jointIds: [...mate.jointIds] })));
}

function specifiedMateCounts(
  report: MateReport,
  shapes: SnapShapes,
  studShapes: ReadonlySet<number>,
  placedView: (owner: number) => PlacedModelView | null,
): ReadonlyArray<HoverMateCount> {
  const views = Array.from({ length: report.count }, (_, k) => {
    const partner = report.partner[k] ?? NO_PARTNER;
    return (report.shape[k] ?? NO_SHAPE) === NO_SHAPE || partner === NO_PARTNER
      ? null
      : placedView(partner);
  });
  const partnerOrder = (a: number, b: number): number => {
    const noneA = (report.partner[a] ?? NO_PARTNER) === NO_PARTNER;
    const noneB = (report.partner[b] ?? NO_PARTNER) === NO_PARTNER;
    if (noneA !== noneB) return noneA ? -1 : 1;
    const viewA = views[a] ?? null;
    const viewB = views[b] ?? null;
    if (!viewA || !viewB) return (viewA ? 1 : 0) - (viewB ? 1 : 0);
    const keyA = [viewA.pose.yPlates, viewA.pose.x, viewA.pose.z, viewA.pose.rot];
    const keyB = [viewB.pose.yPlates, viewB.pose.x, viewB.pose.z, viewB.pose.rot];
    for (let i = 0; i < keyA.length; i++) {
      if (keyA[i] !== keyB[i]) return (keyA[i] ?? 0) - (keyB[i] ?? 0);
    }
    return viewA.item === viewB.item ? 0 : viewA.item < viewB.item ? -1 : 1;
  };
  const shapeOrder = (a: number, b: number): number => {
    if (a === NO_SHAPE || b === NO_SHAPE) return a === b ? 0 : a === NO_SHAPE ? -1 : 1;
    return shapes.compare(a, b);
  };
  const rows = Array.from({ length: report.count }, (_, k) => k).toSorted(
    (a, b) =>
      (report.family[a] ?? 0) - (report.family[b] ?? 0) ||
      (report.connector[a] ?? 0) - (report.connector[b] ?? 0) ||
      partnerOrder(a, b) ||
      (report.partnerInstance[a] ?? 0) - (report.partnerInstance[b] ?? 0) ||
      shapeOrder(report.partnerShape[a] ?? NO_SHAPE, report.partnerShape[b] ?? NO_SHAPE) ||
      (report.partnerGender[a] ?? 0) - (report.partnerGender[b] ?? 0),
  );
  const labels = new Map<number, number>();
  for (const k of rows) {
    const joint = report.joint[k] ?? 0;
    if (!labels.has(joint)) labels.set(joint, labels.size);
  }
  const tallies = new Map<
    number,
    {
      kind: HoverMateCount["kind"];
      partnerKinds: Map<number, HoverMateCount["kind"]>;
      connectors: number;
      joints: Set<number>;
      partners: Map<number, PlacedModelView>;
      inferred: number;
      unverified: number;
    }
  >();
  for (const k of rows) {
    const shape = report.shape[k] ?? NO_SHAPE;
    if (shape === NO_SHAPE) continue;
    const gender = report.gender[k] ?? 0;
    const tally = tallies.get(shape * 2 + gender) ?? {
      kind: connectorKind(shapes, shape, gender, studShapes),
      partnerKinds: new Map(),
      connectors: 0,
      joints: new Set<number>(),
      partners: new Map(),
      inferred: 0,
      unverified: 0,
    };
    tallies.set(shape * 2 + gender, tally);
    tally.connectors++;
    tally.joints.add(labels.get(report.joint[k] ?? 0) ?? 0);
    const partnerShape = report.partnerShape[k] ?? NO_SHAPE;
    const partnerGender = report.partnerGender[k] ?? 0;
    if (partnerShape !== NO_SHAPE && !tally.partnerKinds.has(partnerShape * 2 + partnerGender)) {
      tally.partnerKinds.set(
        partnerShape * 2 + partnerGender,
        connectorKind(shapes, partnerShape, partnerGender, studShapes),
      );
    }
    const view = views[k] ?? null;
    if (view) tally.partners.set(report.partner[k] ?? NO_PARTNER, view);
    if (((report.sourceMask[k] ?? 0) & SOURCE_INFERRED) !== 0) tally.inferred++;
    if (report.status[k] === STATUS_UNVERIFIED) tally.unverified++;
  }
  return [...tallies.values()].map((tally) => ({
    kind: tally.kind,
    partnerKinds: [...tally.partnerKinds.values()],
    connectors: tally.connectors,
    joints: tally.joints.size,
    jointIds: tally.joints,
    partners: [...tally.partners.values()],
    inferred: tally.inferred,
    unverified: tally.unverified,
  }));
}

function permutation(count: number, pick: (below: number) => number): number[] {
  const order = Array.from({ length: count }, (_, k) => k);
  for (let k = count - 1; k > 0; k--) {
    const j = pick(k + 1);
    const swapped = order[j] ?? 0;
    order[j] = order[k] ?? 0;
    order[k] = swapped;
  }
  return order;
}

const CANONICAL_SEED = 20261125;

function insertedInOrder(f: Fixture): CanonicalHistory {
  const history = new CanonicalHistory(canonicalRecipe(f, CANONICAL_SEED));
  const identity = Array.from({ length: history.recipe.placed.length }, (_, k) => k);
  history.insert(identity, (position) => history.recipe.placed[position]?.id ?? 0);
  return history;
}

function canonicalHistories(): ReadonlyArray<CanonicalHistory> {
  const pick = seeded(CANONICAL_SEED * 31);
  const inOrder = insertedInOrder(fixture());
  const count = inOrder.recipe.placed.length;
  const identity = Array.from({ length: count }, (_, k) => k);
  const permuted = new CanonicalHistory(canonicalRecipe(fixture(), CANONICAL_SEED));
  permuted.insert(permutation(count, pick), (position) => 100_000 + position);
  const edited = insertedInOrder(fixture());
  let fresh = 200_000;
  for (let cycle = 0; cycle < REMOVE_CYCLES; cycle++) {
    const owners = [...edited.live.listed.keys()];
    const owner = owners[pick(owners.length)];
    const listed = owner === undefined ? undefined : edited.live.listed.get(owner);
    if (owner === undefined || !listed) continue;
    edited.live.search.remove(owner);
    edited.live.listed.delete(owner);
    edited.live.place(fresh++, listed.piece, listed.pose);
  }
  for (let carry = 0; carry < CANONICAL_CARRIES; carry++) {
    const owners = [...edited.live.listed.keys()];
    const held = new Set(
      Array.from({ length: CANONICAL_CARRY_SIZE }, () => owners[pick(owners.length)] ?? 0),
    );
    edited.live.search.withdrawn(held, () => {
      for (let k = 0; k < CANONICAL_CARRY_SIZE; k++) {
        const probe = edited.recipe.probes[pick(edited.recipe.probes.length)];
        if (probe) edited.evaluate(probe);
      }
    });
  }
  for (let k = 0; k < WARM_UPS; k++) {
    const probe = edited.recipe.probes[pick(edited.recipe.probes.length)];
    if (probe) edited.evaluate(probe);
  }
  const reinterned = new CanonicalHistory(
    canonicalRecipe(fixture(internInAnotherOrder), CANONICAL_SEED),
  );
  reinterned.insert(identity.toReversed(), (position) => 300_000 + position);
  return [inOrder, permuted, edited, reinterned];
}

describe("mateCounts' canonical join order", () => {
  it("lists the same joins in the same order for the same world however it was reached: inserted in another order under new ids, edited by removals, re-adds under new ids, carries and earlier hovers, or rebuilt with shapes interned and models first turned in another order", () => {
    const histories = canonicalHistories();
    const [inOrder, permuted, edited, reinterned] = histories;
    if (!inOrder || !permuted || !edited || !reinterned) throw new Error("four histories expected");
    const differences: string[] = [];
    inOrder.recipe.probes.forEach((probe, p) => {
      const expected = inOrder.hover(inOrder.evaluate(probe));
      histories.forEach((history, h) => {
        const other = history.recipe.probes[p];
        if (other && history.hover(history.evaluate(other)) !== expected)
          differences.push(`${probe.name} #${p} in history ${h}`);
      });
    });
    const witnessed = (name: string, a: CanonicalHistory, b: CanonicalHistory): boolean => {
      const p = inOrder.recipe.probes.findIndex((probe) => probe.name === name);
      const left = a.recipe.probes[p];
      const right = b.recipe.probes[p];
      return (
        left !== undefined &&
        right !== undefined &&
        a.raw(a.evaluate(left)) !== b.raw(b.evaluate(right))
      );
    };
    let gatherWitness = false;
    const unrelated = inOrder.recipe.probes[0];
    inOrder.recipe.walks.forEach((walk) => {
      walk.forEach((step, s) => {
        const before = walk[s - 1];
        if (!before || !unrelated) return;
        inOrder.evaluate(before);
        const warm = inOrder.evaluate(step);
        const warmRaw = inOrder.raw(warm);
        const warmHover = inOrder.hover(warm);
        inOrder.evaluate(unrelated);
        const cold = inOrder.evaluate(step);
        if (inOrder.raw(cold) !== warmRaw) gatherWitness = true;
        if (inOrder.hover(cold) !== warmHover) differences.push(`${step.name} warm against cold`);
      });
    });
    const instancesProbe = inOrder.recipe.probes.findIndex((probe) =>
      probe.name.startsWith("long and short pin"),
    );
    const secondInstanceFirst = histories.some((history) => {
      const probe = history.recipe.probes[instancesProbe];
      if (!probe) return false;
      const report = history.evaluate(probe);
      for (let k = 0; k < report.count; k++) {
        if (report.connector[k] === 0) return report.partnerInstance[k] === 1;
      }
      return false;
    });
    expect({
      differences,
      gatherCache: gatherWitness,
      chainRecency:
        witnessed("pin into two bored items at one pose", inOrder, edited) ||
        witnessed("pin into two bored items at one pose", inOrder, permuted),
      classIds: witnessed("stud under two receptor classes", inOrder, reinterned),
      trackHolders: witnessed("track end on two holders", inOrder, reinterned),
      secondInstanceFirst,
      shapeIdsDiffer: inOrder.recipe.f.stud !== reinterned.recipe.f.stud,
    }).toEqual({
      differences: [],
      gatherCache: true,
      chainRecency: true,
      classIds: true,
      trackHolders: true,
      secondInstanceFirst: true,
      shapeIdsDiffer: true,
    });
  }, 120_000);

  it("orders every hover's tallies, partners, partner kinds and joint labels as the specification does from all of its rows, changing only their order", () => {
    const inOrder = insertedInOrder(fixture());
    const mismatches: string[] = [];
    const sizes = inOrder.recipe.probes.map((probe) => {
      const report = inOrder.evaluate(probe);
      if (inOrder.hover(report) !== inOrder.expected(report)) mismatches.push(probe.name);
      return report.count;
    });
    expect({
      mismatches,
      spansPowersOfTwo: [3, 17, 65, 257].every((size) => sizes.some((count) => count >= size)),
    }).toEqual({ mismatches: [], spansPowersOfTwo: true });
  }, 120_000);

  it("lists the same joins in the same order on official 3811s, 3001s and 3794b jumpers and custom models built from their tables, for the same world inserted in another order under new ids or edited by removals and re-adds under new ids", async () => {
    const pick = seeded(CANONICAL_SEED * 37);
    const histories = await Promise.all([officialParts(), officialParts(), officialParts()]);
    const [inOrder, permuted, edited] = histories;
    if (!inOrder || !permuted || !edited) throw new Error("three histories expected");
    const placed = histories.map((parts) => officialWorld(parts));
    const permutedOwners = placed[1] ?? [];
    const order = permutation(permutedOwners.length, pick);
    const reinserted = reinsertedAs(
      permuted,
      order.map((k) => permutedOwners[k] ?? 0),
      100_000,
    );
    const permutedAt = Array.from({ length: order.length }, () => 0);
    order.forEach((slot, position) => {
      permutedAt[slot] = reinserted[position] ?? 0;
    });
    const editedOwners = [...(placed[2] ?? [])];
    for (let cycle = 0; cycle < REMOVE_CYCLES; cycle++) {
      const k = pick(editedOwners.length);
      editedOwners[k] = reinsertedAs(edited, [editedOwners[k] ?? 0], 200_000 + cycle)[0] ?? 0;
    }
    const owners = [placed[0] ?? [], permutedAt, editedOwners];
    const report = new MateReport();
    const hovers = histories.map((parts, h) =>
      (owners[h] ?? []).map((owner) => {
        const listed = parts.live.listed.get(owner);
        if (!listed) return "unlisted";
        parts.live.search.evaluate(listed.piece.connectors, listed.pose, report);
        return talliesJson(
          mateCounts(report, parts.shapes, new Set(), (partner) => {
            const other = parts.live.listed.get(partner);
            if (!other) return null;
            const item = officialName(parts, other.piece);
            return { item, label: item, pose: other.pose };
          }),
        );
      }),
    );
    const customIndices = histories.map((parts) =>
      [parts.sideStudPair, parts.jumperOnBrick].map((piece) => [
        [...piece.connectors.origin],
        [...piece.connectors.axis],
        [...piece.connectors.gender],
      ]),
    );
    expect({
      mated: (hovers[0] ?? []).filter((line) => line !== "[]").length > 0,
      permuted: hovers[1],
      edited: hovers[2],
      customIndices: customIndices.slice(1),
    }).toEqual({
      mated: true,
      permuted: hovers[0],
      edited: hovers[0],
      customIndices: [customIndices[0], customIndices[0]],
    });
  }, 120_000);

  it("orders generated reports of every size from 1 to 300, rows in any order and up to every row on one connector, as the specification does", () => {
    const f = fixture();
    const pick = seeded(CANONICAL_SEED * 41);
    const shapes = [
      f.stud,
      f.receptor(4),
      f.receptor(BRICK_LDU - 4),
      f.boreEnd,
      f.pinEnd(FIELD_PIN),
    ];
    const poses = Array.from({ length: GENERATED_OWNERS }, () => ({
      x: pick(4) * STUD_LDU,
      z: pick(4) * STUD_LDU,
      yPlates: pick(3),
      rot: pick(4),
    }));
    const view = (owner: number): PlacedModelView => ({
      item: `item ${owner % 3}`,
      label: `item ${owner % 3}`,
      pose: poses[owner] ?? ORIGIN,
    });
    const studShapes = new Set([f.stud]);
    const engagement = new Float64Array(6);
    const report = new MateReport();
    const mismatches: number[] = [];
    for (let size = 1; size <= GENERATED_ROWS; size++) {
      report.clear();
      for (let k = 0; k < size; k++) {
        const family = pick(3);
        const partner = pick(4) === 0 ? NO_PARTNER : pick(GENERATED_OWNERS);
        const shaped = family !== 2;
        engagement[0] = pick(3);
        engagement[1] = pick(3) * SIXTEENTHS_PER_LDU;
        engagement[2] = pick(3) * SIXTEENTHS_PER_LDU;
        engagement[3] = pick(4);
        engagement[4] = pick(4) + 4;
        engagement[5] = 6;
        report.push(
          pick(1 + (size % GENERATED_CONNECTORS)),
          shaped ? (shapes[pick(shapes.length)] ?? f.stud) : NO_SHAPE,
          pick(2) === 0 ? GENDER_MALE : GENDER_FEMALE,
          shaped ? (shapes[pick(shapes.length)] ?? f.stud) : NO_SHAPE,
          pick(2) === 0 ? GENDER_MALE : GENDER_FEMALE,
          pick(4),
          pick(3),
          partner,
          pick(3),
          partner === NO_PARTNER ? -1 : pick(3),
          pick(2) === 0 ? null : engagement,
        );
        report.assignFamily(k, family);
      }
      const shown = talliesJson(mateCounts(report, f.shapes, studShapes, view));
      if (shown !== talliesJson(specifiedMateCounts(report, f.shapes, studShapes, view))) {
        mismatches.push(size);
      }
    }
    expect(mismatches).toEqual([]);
  });
});

interface NamedPiece extends Piece {
  readonly item: string;
  readonly partOf: (instance: number) => string;
}

interface NamedEntry {
  readonly name: string;
  readonly piece: NamedPiece;
  readonly pose: LatticePose;
}

interface NamingParts {
  readonly search: IPlacementSearch;
  readonly solver: ConnectionSolver;
  readonly shapes: SnapShapes;
  readonly pieces: Readonly<Record<string, NamedPiece>>;
}

interface Blockers {
  readonly names: string[];
  readonly hits: Map<string, OverlapHit>;
}

interface Overlap {
  readonly owner: string;
  readonly cell: readonly [number, number];
  readonly part: string;
  readonly heights: readonly [number, number, number, number];
}

const NAMING_TURNS = 4;
const NOT_BLOCKED = "not blocked";
const IMPORT_HASH = "sha256";
const realBundleRoot = new URL("../../../../tools/asset-pipeline/dist/bundle/", import.meta.url);

function realBundleFetcher(): IAssetFetcher {
  return {
    async bytes(path) {
      const buffer = await readFile(new URL(path, realBundleRoot));
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
    text: (path) => readFile(new URL(path, realBundleRoot), "utf8"),
  };
}

function posedCells(local: CellVolumes, pose: LatticePose): CellVolumes {
  const rot = isRot90(pose.rot) ? pose.rot : 0;
  const cos = rot90Cos(rot);
  const sin = rot90Sin(rot);
  const yLdu = pose.yPlates * PLATE_LDU;
  const cellX = new Int32Array(local.count);
  const cellZ = new Int32Array(local.count);
  const bottomLdu = new Int32Array(local.count);
  const topLdu = new Int32Array(local.count);
  const partsAt = new Int32Array(local.count);
  for (let c = 0; c < local.count; c++) {
    const cx = (local.cellX[c] ?? 0) * STUD_LDU + HALF;
    const cz = (local.cellZ[c] ?? 0) * STUD_LDU + HALF;
    cellX[c] = Math.floor((cos * cx + sin * cz + pose.x) / STUD_LDU);
    cellZ[c] = Math.floor((-sin * cx + cos * cz + pose.z) / STUD_LDU);
    bottomLdu[c] = (local.bottomLdu[c] ?? 0) + yLdu;
    topLdu[c] = (local.topLdu[c] ?? 0) + yLdu;
    partsAt[c] = local.partsAt[c] ?? 0;
  }
  return {
    count: local.count,
    cellX,
    cellZ,
    bottomLdu,
    topLdu,
    partsAt,
    parts: local.parts,
    turn: (local.turn + rot) % NAMING_TURNS,
    sixteenthsUp: local.sixteenthsUp + yLdu * SIXTEENTHS_PER_LDU,
  };
}

function singleOwnerIndex(owner: number, piece: Piece, pose: LatticePose): VolumeIndex {
  const posed = posedCells(piece.volumes, pose);
  const xs = Array.from(posed.cellX);
  const zs = Array.from(posed.cellZ);
  const x0 = Math.min(...xs);
  const z0 = Math.min(...zs);
  const yLdu = pose.yPlates * PLATE_LDU;
  const width = Math.max(...xs) - x0 + 1;
  const depth = Math.max(...zs) - z0 + 1;
  const index = new VolumeIndex();
  index.add(owner, FootprintGrid.of(posed, x0, z0, width, depth, yLdu), x0, z0, yLdu);
  return index;
}

function emptyHit(): OverlapHit {
  return placementChoice().overlap;
}

const NEVER_IGNORED = (): boolean => false;

class NamingHistory {
  private readonly ids = new Map<string, number>();
  private readonly names = new Map<number, string>();
  readonly linked: string[] = [];

  constructor(
    readonly parts: NamingParts,
    readonly entries: ReadonlyArray<NamedEntry>,
    private next: number,
  ) {}

  entry(name: string): NamedEntry {
    const entry = this.entries.find((candidate) => candidate.name === name);
    if (!entry) throw new Error(`no entry ${name}`);
    return entry;
  }

  insert(name: string): void {
    const { piece, pose } = this.entry(name);
    const id = this.next++;
    const { boxes, technic } = piece.parts;
    this.parts.search.add(id, piece.connectors, piece.volumes, boxes, technic, pose, piece.item);
    this.ids.set(name, id);
    this.names.set(id, name);
    this.linked.push(name);
  }

  reinsert(name: string): void {
    const id = this.idOf(name);
    this.parts.search.remove(id);
    this.names.delete(id);
    this.linked.splice(this.linked.indexOf(name), 1);
    this.insert(name);
  }

  idOf(name: string): number {
    const id = this.ids.get(name);
    if (id === undefined) throw new Error(`${name} isn't placed`);
    return id;
  }

  nameOf(id: number): string {
    return this.names.get(id) ?? `unknown ${id}`;
  }

  carry(held: NamedEntry, moving: string): void {
    const { piece, pose } = held;
    this.parts.search.search(
      piece.connectors,
      piece.volumes,
      piece.parts.boxes,
      piece.parts.technic,
      window(pose.x, pose.z, 2, pose.yPlates),
      TABLE_Y_PLATES,
      this.idOf(moving),
      placementChoice(),
    );
  }

  landsOn(held: NamedEntry): ReadonlyArray<string> {
    return this.parts.search
      .restingOn(held.piece.volumes, held.pose, null)
      .map((id) => this.nameOf(id));
  }

  overlap(held: NamedEntry): string {
    const { piece, pose } = held;
    const choice = placementChoice();
    this.parts.search.check(
      piece.connectors,
      piece.volumes,
      piece.parts.boxes,
      piece.parts.technic,
      pose,
      TABLE_Y_PLATES,
      choice,
    );
    if (choice.accepted || choice.overlap.owner < 0) return NOT_BLOCKED;
    return this.describe(choice.overlap);
  }

  partner(name: string): string {
    const partner = this.parts.search.overlapOf(this.idOf(name));
    return partner < 0 ? NOT_BLOCKED : this.nameOf(partner);
  }

  stranded(name: string): string {
    const stranding = this.parts.search.strandedByRemoval(
      new Set([this.idOf(name)]),
      (id) => this.entry(this.nameOf(id)).pose.yPlates <= TABLE_Y_PLATES,
    );
    return stranding.kind === "stranded" ? this.nameOf(stranding.placement) : stranding.kind;
  }

  describe(hit: OverlapHit): string {
    const owner = this.nameOf(hit.owner);
    const overlap: Overlap = {
      owner,
      cell: [hit.cellX, hit.cellZ],
      part: this.entry(owner).piece.partOf(hit.instance),
      heights: [hit.bottomLdu, hit.topLdu, hit.candidateBottomLdu, hit.candidateTopLdu],
    };
    return JSON.stringify(overlap);
  }

  recency(name: string): number {
    return this.linked.indexOf(name);
  }
}

class NamingOracle {
  private readonly indexes = new Map<string, VolumeIndex>();

  constructor(private readonly history: NamingHistory) {}

  private index(name: string): VolumeIndex {
    let index = this.indexes.get(name);
    if (!index) {
      const { piece, pose } = this.history.entry(name);
      index = singleOwnerIndex(this.history.idOf(name), piece, pose);
      this.indexes.set(name, index);
    }
    return index;
  }

  private lower(a: string, b: string): boolean {
    const left = this.history.entry(a);
    const right = this.history.entry(b);
    return lowerFirst(left.pose, left.piece.item, right.pose, right.piece.item);
  }

  private least(names: ReadonlyArray<string>): string {
    return names.reduce((best, name) => (this.lower(name, best) ? name : best));
  }

  contactsByCell(held: NamedEntry): ReadonlyArray<ReadonlyArray<string>> {
    const cells = posedCells(held.piece.volumes, held.pose);
    const contact = emptyHit();
    return Array.from({ length: cells.count }, (_, c) => {
      if ((cells.topLdu[c] ?? 0) <= (cells.bottomLdu[c] ?? 0)) return [];
      const x = cells.cellX[c] ?? 0;
      const z = cells.cellZ[c] ?? 0;
      return this.history.linked.filter((name) =>
        this.index(name).firstContactBelow(x, z, cells, c, NEVER_IGNORED, contact),
      );
    });
  }

  landsOn(held: NamedEntry): ReadonlyArray<string> {
    const touching = [...new Set(this.contactsByCell(held).flat())];
    return touching.toSorted((a, b) => (this.lower(a, b) ? -1 : this.lower(b, a) ? 1 : 0));
  }

  blockers(held: NamedEntry, moving: string | null): Blockers | null {
    const { piece, pose } = held;
    const { solver } = this.history.parts;
    const cells = posedCells(piece.volumes, pose);
    const zones = new MateZones();
    if (solver.votes(piece.connectors, pose) > 0) {
      const report = new MateReport();
      solver.partneredMates(piece.connectors, pose, report);
      const placed = new Map<number, PlacedParts>(
        this.history.linked.map((name) => {
          const entry = this.history.entry(name);
          const { boxes, technic } = entry.piece.parts;
          return [this.history.idOf(name), { boxes, technic, pose: entry.pose }] as const;
        }),
      );
      zones.collect(report, piece.parts.boxes, piece.parts.technic, pose, placed);
    }
    const tiers: Array<Array<Blockers>> = [[], []];
    for (let c = 0; c < cells.count; c++) {
      if ((cells.topLdu[c] ?? 0) <= (cells.bottomLdu[c] ?? 0)) continue;
      const x = cells.cellX[c] ?? 0;
      const z = cells.cellZ[c] ?? 0;
      const found: Blockers[] = [
        { names: [], hits: new Map() },
        { names: [], hits: new Map() },
      ];
      for (const name of this.history.linked) {
        if (name === moving) continue;
        const owner = this.history.idOf(name);
        const raw = emptyHit();
        if (!this.index(name).firstOverlap(x, z, cells, c, NEVER_IGNORED, raw)) continue;
        if (!zones.covers(owner, x, z)) {
          found[0]?.names.push(name);
          found[0]?.hits.set(name, { ...raw, owner, cellX: x, cellZ: z });
          continue;
        }
        const unexcused = emptyHit();
        if (!this.index(name).firstUnexcusedOverlap(x, z, cells, c, owner, zones, unexcused))
          continue;
        found[1]?.names.push(name);
        found[1]?.hits.set(name, { ...unexcused, owner, cellX: x, cellZ: z });
      }
      found.forEach((tier, t) => {
        if (tier.names.length > 0) tiers[t]?.push(tier);
      });
    }
    return tiers[0]?.[0] ?? tiers[1]?.[0] ?? null;
  }

  overlap(held: NamedEntry, moving: string | null = null): string {
    const blocking = this.blockers(held, moving);
    if (!blocking) return NOT_BLOCKED;
    const hit = blocking.hits.get(this.least(blocking.names));
    return hit ? this.history.describe(hit) : NOT_BLOCKED;
  }

  partner(name: string): string {
    const entry = this.history.entry(name);
    const blocking = this.blockers(entry, name);
    return blocking ? this.least(blocking.names) : NOT_BLOCKED;
  }

  strandedSet(base: string): ReadonlyArray<string> {
    const { search } = this.history.parts;
    const report = new MateReport();
    const others = this.history.linked.filter((name) => name !== base);
    const mated = others.filter((name) => {
      const entry = this.history.entry(name);
      search.evaluate(entry.piece.connectors, entry.pose, report);
      return report.count > 0;
    });
    return search.withdrawn(new Set([this.history.idOf(base)]), () =>
      mated.filter((name) => {
        const entry = this.history.entry(name);
        search.evaluate(entry.piece.connectors, entry.pose, report);
        return report.count === 0 && entry.pose.yPlates > TABLE_Y_PLATES;
      }),
    );
  }

  stranded(base: string): string {
    const strandedNames = this.strandedSet(base);
    return strandedNames.length === 0 ? "none" : this.least(strandedNames);
  }
}

class MainMirror {
  constructor(
    private readonly history: NamingHistory,
    private readonly oracle: NamingOracle,
  ) {}

  private newest(names: ReadonlyArray<string>): string {
    return names.reduce((best, name) =>
      this.history.recency(name) > this.history.recency(best) ? name : best,
    );
  }

  landsOn(held: NamedEntry): ReadonlyArray<string> {
    const listed: string[] = [];
    for (const atCell of this.oracle.contactsByCell(held)) {
      const newestFirst = atCell.toSorted(
        (a, b) => this.history.recency(b) - this.history.recency(a),
      );
      for (const name of newestFirst) if (!listed.includes(name)) listed.push(name);
    }
    return listed;
  }

  overlap(held: NamedEntry, moving: string | null = null): string {
    const blocking = this.oracle.blockers(held, moving);
    return blocking ? this.newest(blocking.names) : NOT_BLOCKED;
  }

  stranded(base: string): string {
    const strandedNames = this.oracle.strandedSet(base);
    return strandedNames.length === 0
      ? "none"
      : strandedNames.reduce((oldest, name) =>
          this.history.recency(name) < this.history.recency(oldest) ? name : oldest,
        );
  }
}

async function namedPieceLoader(container: Container) {
  const catalog = container.get(PLACEABLE_CATALOG);
  const tables = container.get(CONNECTOR_TABLES);
  const search = container.get(PLACEMENT_SEARCH);
  return async (item: string, as: string = item): Promise<NamedPiece> => {
    const placeable = await catalog.load(catalog.itemRefId(item) ?? -1);
    const { tables: parts } = await tables.load(placeable);
    const boxes = partBoxes(placeable.partBoxes);
    const { partTransforms } = placeable;
    return {
      item: as,
      connectors: search.model(parts, partTransforms, []),
      volumes: FrozenVolumes.ofPlaceable(placeable),
      parts: {
        boxes,
        technic: FrozenTechnic.ofParts(
          catalog.parts().map((part) => part.technic),
          partTransforms,
          boxes.boxes,
        ),
      },
      partOf: (instance) => {
        const part = catalog.parts()[partTransforms.partIndex[instance] ?? -1];
        return part ? `${part.id} ${part.title}` : `no part ${instance}`;
      },
    };
  };
}

async function officialNamingParts(reinterned: boolean): Promise<NamingParts> {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(fixtureBundleFetcher());
  const catalog = container.get(PLACEABLE_CATALOG);
  await catalog.start(await container.get(PART_BUNDLE_LOADER).loadIndex("standard"));
  const shapes = container.get(SNAP_SHAPES);
  if (reinterned) shapes.intern(CAP_FAR, true, [SECTION_AXLE], [9], [9]);
  const load = await namedPieceLoader(container);
  const order: ReadonlyArray<readonly [string, string, string]> = [
    ["brick", OFFICIAL_BRICK, OFFICIAL_BRICK],
    ["jumper", OFFICIAL_JUMPER, OFFICIAL_JUMPER],
    ["custom brick", OFFICIAL_BRICK, "custom:brick-2x4"],
  ];
  const loaded = reinterned ? order.toReversed() : order;
  const pieces: Record<string, NamedPiece> = {};
  for (const [key, item, as] of loaded) pieces[key] = await load(item, as);
  return {
    search: container.get(PLACEMENT_SEARCH),
    solver: container.get(CONNECTION_SOLVER),
    shapes,
    pieces,
  };
}

function importedFile(name: string, lines: ReadonlyArray<string>) {
  const text = [`0 ${name}`, `0 Name: ${name}`, "0 Author: Brick Railroad tests", ...lines, ""];
  const bytes = new TextEncoder().encode(text.join("\n"));
  return { name, bytes, sha256: createHash(IMPORT_HASH).update(bytes).digest("hex") };
}

const TECHNIC_BRICK = ["1 0 0 -24 0 0 0 1 0 1 0 -1 0 0 3700.dat"];
const PIN_OVER_PLATE = [
  "1 0 0 -24 0 0 0 1 0 1 0 -1 0 0 3700.dat",
  "1 0 10 -14 0 1 0 0 0 1 0 0 0 1 2780.dat",
  "1 1 20 -8 10 1 0 0 0 1 0 0 0 1 3024.dat",
];
const LONE_PLATE = ["1 1 0 -8 0 1 0 0 0 1 0 0 0 1 3024.dat"];

async function technicNamingParts(): Promise<NamingParts> {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  container.rebind(ASSET_FETCHER).toConstantValue(realBundleFetcher());
  const loader = container.get(PART_BUNDLE_LOADER);
  const records = { read: (partId: string) => loader.readPartConnectors("standard", partId) };
  container.rebind(MODEL_IMPORTER).toConstantValue(new InThreadModelImporter(loader, records));
  const catalog = container.get(PLACEABLE_CATALOG);
  await catalog.start(await loader.loadIndex("standard"));
  const load = await namedPieceLoader(container);
  const imported = async (name: string, lines: ReadonlyArray<string>): Promise<NamedPiece> => {
    const file = importedFile(name, lines);
    const outcome = await catalog.addImported(file);
    if (outcome.kind === "checking") await outcome.checked;
    if (outcome.kind !== "checking" && outcome.kind !== "placeable") {
      throw new Error(`${name} was not imported: ${outcome.kind}`);
    }
    return load(outcome.item.id);
  };
  return {
    search: container.get(PLACEMENT_SEARCH),
    solver: container.get(CONNECTION_SOLVER),
    shapes: container.get(SNAP_SHAPES),
    pieces: {
      "technic brick": await imported("my-technic-brick.ldr", TECHNIC_BRICK),
      "pin over plate": await imported("my-pin-over-plate.ldr", PIN_OVER_PLATE),
      "pin over plate twin": await imported("my-pin-over-plate-twin.ldr", PIN_OVER_PLATE),
      "lone plate": await imported("my-lone-plate.ldr", LONE_PLATE),
    },
  };
}

function namedPiece(parts: NamingParts, key: string): NamedPiece {
  const found = parts.pieces[key];
  if (!found) throw new Error(`no piece ${key}`);
  return found;
}

function poseAt(x: number, z: number, yPlates = 0, rot = 0): LatticePose {
  return { x, z, yPlates, rot };
}

function officialNamingWorld(parts: NamingParts) {
  const brick = namedPiece(parts, "brick");
  const jumper = namedPiece(parts, "jumper");
  const custom = namedPiece(parts, "custom brick");
  const entries: NamedEntry[] = [
    { name: "jumper at turn 0", piece: jumper, pose: poseAt(200, 0) },
    { name: "jumper at turn 1", piece: jumper, pose: poseAt(200, 0, 0, 1) },
    { name: "official brick", piece: brick, pose: poseAt(400, 0) },
    { name: "custom brick", piece: custom, pose: poseAt(400, 0) },
    { name: "lower stacked brick", piece: brick, pose: poseAt(600, 0) },
    { name: "upper stacked brick", piece: brick, pose: poseAt(600, 0, 3) },
    { name: "jumper at the first cell", piece: jumper, pose: poseAt(780, 0, 1) },
    { name: "jumper at a later cell", piece: jumper, pose: poseAt(820, 20) },
    { name: "base brick", piece: brick, pose: poseAt(1000, 0) },
    { name: "rider west north", piece: jumper, pose: poseAt(980, 0, 3) },
    { name: "rider east north", piece: jumper, pose: poseAt(1020, 0, 3) },
    { name: "rider west south", piece: jumper, pose: poseAt(980, 20, 3) },
    { name: "rider east south", piece: jumper, pose: poseAt(1020, 20, 3) },
    { name: "lower partner brick", piece: brick, pose: poseAt(1200, 0) },
    { name: "upper partner brick", piece: brick, pose: poseAt(1200, 0, 3) },
    { name: "partner probe brick", piece: brick, pose: poseAt(1200, 0, 1) },
    {
      name: "second of three items",
      piece: { ...custom, item: "custom:b" },
      pose: poseAt(1400, 0),
    },
    { name: "first of three items", piece: { ...custom, item: "custom:a" }, pose: poseAt(1400, 0) },
    { name: "last of three items", piece: { ...custom, item: "custom:x" }, pose: poseAt(1400, 0) },
  ];
  const held = {
    turns: { name: "brick over two turns", piece: brick, pose: poseAt(200, 0, 1) },
    items: { name: "brick over two items", piece: brick, pose: poseAt(400, 0, 3) },
    stacked: { name: "brick into a stack", piece: brick, pose: poseAt(600, 0, 1) },
    multiCell: { name: "brick over two cells", piece: brick, pose: poseAt(800, 0) },
    threeItems: { name: "brick into three items", piece: brick, pose: poseAt(1400, 0, 1) },
  };
  const firstOfGroups = [
    "jumper at turn 0",
    "official brick",
    "lower stacked brick",
    "rider west north",
    "lower partner brick",
    "second of three items",
  ];
  return { entries, held, firstOfGroups };
}

function technicNamingWorld(parts: NamingParts) {
  const technic = namedPiece(parts, "technic brick");
  const pinPlate = namedPiece(parts, "pin over plate");
  const twin = namedPiece(parts, "pin over plate twin");
  const plate = namedPiece(parts, "lone plate");
  const entries: NamedEntry[] = [
    { name: "pin over a plate", piece: pinPlate, pose: poseAt(0, 0) },
    { name: "pin over a plate beside a lone plate", piece: pinPlate, pose: poseAt(200, 0) },
    { name: "lone plate", piece: plate, pose: poseAt(220, 20) },
    { name: "first of two pins over plates", piece: pinPlate, pose: poseAt(400, 0) },
    { name: "second of two pins over plates", piece: twin, pose: poseAt(400, 0) },
  ];
  const held = {
    tierTwo: { name: "technic brick onto the pin", piece: technic, pose: poseAt(20, 0) },
    laterTierOne: {
      name: "technic brick onto the pin and the plate",
      piece: technic,
      pose: poseAt(220, 0),
    },
    covered: { name: "technic brick onto two pins", piece: technic, pose: poseAt(420, 0) },
  };
  return { entries, held, firstOfGroups: ["first of two pins over plates"] };
}

function brickShape(parts: NamingParts | undefined): number {
  return parts === undefined ? -1 : (namedPiece(parts, "brick").connectors.shape[0] ?? -1);
}

function insertAll(history: NamingHistory, names: ReadonlyArray<string>): NamingHistory {
  for (const name of names) history.insert(name);
  return history;
}

function overlapAnswer(
  owner: string,
  cell: readonly [number, number],
  part: string,
  heights: readonly [number, number, number, number],
): string {
  const overlap: Overlap = { owner, cell, part, heights };
  return JSON.stringify(overlap);
}

const OFFICIAL_3001 = "ldraw:3001 Brick 2 x 4";
const OFFICIAL_3794B = "ldraw:3794b Plate 1 x 2 with Groove with 1 Centre Stud";
const OFFICIAL_3024 = "ldraw:3024 Plate 1 x 1";
const WITNESSED_OFFICIAL = [
  "turns",
  "items",
  "stacked",
  "threeItems",
  "partner",
  "stranded",
] as const;

describe("PlacementSearch names models in one fixed order for a given world", () => {
  it("names the same lands-on, overlap, partner and stranded model on official 3001s and 3794b jumpers for the same world however it was reached, as the specification names it: inserted in another order under new ids, re-added under new ids after carries and earlier queries, or rebuilt with shapes interned and models first turned in another order", async () => {
    const built = await Promise.all([
      officialNamingParts(false),
      officialNamingParts(false),
      officialNamingParts(false),
      officialNamingParts(true),
    ]);
    const worlds = built.map((parts) => officialNamingWorld(parts));
    const names = (worlds[0]?.entries ?? []).map((entry) => entry.name);
    const orders = [names, names.toReversed(), names, names.toReversed()];
    const histories = built.map((parts, k) =>
      insertAll(new NamingHistory(parts, worlds[k]?.entries ?? [], 1 + 100 * k), orders[k] ?? []),
    );
    const answersOf = (k: number) => {
      const history = histories[k];
      const scene = worlds[k];
      if (!history || !scene) throw new Error(`no history ${k}`);
      return {
        turns: history.landsOn(scene.held.turns),
        items: history.landsOn(scene.held.items),
        stacked: history.overlap(scene.held.stacked),
        threeItems: history.overlap(scene.held.threeItems),
        multiCell: history.overlap(scene.held.multiCell),
        partner: history.partner("partner probe brick"),
        stranded: history.stranded("base brick"),
      };
    };
    const edited = histories[2];
    const editedWorld = worlds[2];
    if (!edited || !editedWorld) throw new Error("no edited history");
    answersOf(2);
    edited.carry(editedWorld.held.stacked, "base brick");
    for (const name of editedWorld.firstOfGroups) edited.reinsert(name);
    const answers = histories.map((_, k) => answersOf(k));
    const specified = histories.map((history, k) => {
      const oracle = new NamingOracle(history);
      const held = worlds[k]?.held;
      if (!held) throw new Error(`no world ${k}`);
      return {
        turns: oracle.landsOn(held.turns),
        items: oracle.landsOn(held.items),
        stacked: oracle.overlap(held.stacked),
        threeItems: oracle.overlap(held.threeItems),
        multiCell: oracle.overlap(held.multiCell),
        partner: oracle.partner("partner probe brick"),
        stranded: oracle.stranded("base brick"),
      };
    });
    const mirrors = histories.map((history, k) => {
      const mirror = new MainMirror(history, new NamingOracle(history));
      const held = worlds[k]?.held;
      if (!held) throw new Error(`no world ${k}`);
      return {
        turns: JSON.stringify(mirror.landsOn(held.turns)),
        items: JSON.stringify(mirror.landsOn(held.items)),
        stacked: mirror.overlap(held.stacked),
        threeItems: mirror.overlap(held.threeItems),
        partner: mirror.overlap(history.entry("partner probe brick"), "partner probe brick"),
        stranded: mirror.stranded("base brick"),
      };
    });
    const [inOrder, reversed, reAdded] = mirrors;
    const witnessed = WITNESSED_OFFICIAL.filter(
      (probe) => inOrder?.[probe] !== reversed?.[probe] && inOrder?.[probe] !== reAdded?.[probe],
    );
    const expected = {
      turns: ["jumper at turn 0", "jumper at turn 1"],
      items: ["custom brick", "official brick"],
      stacked: overlapAnswer("lower stacked brick", [28, -1], OFFICIAL_3001, [0, 24, 8, 32]),
      threeItems: overlapAnswer("first of three items", [68, -1], OFFICIAL_3001, [0, 24, 8, 32]),
      multiCell: overlapAnswer(
        "jumper at the first cell",
        [38, -1],
        OFFICIAL_3794B,
        [8, 16, 0, 24],
      ),
      partner: "lower partner brick",
      stranded: "rider west north",
    };
    expect({
      answers,
      specified,
      witnessed,
      shapeIdsDiffer: brickShape(built[0]) !== brickShape(built[3]),
    }).toEqual({
      answers: [expected, expected, expected, expected],
      specified: [expected, expected, expected, expected],
      witnessed: [...WITNESSED_OFFICIAL],
      shapeIdsDiffer: true,
    });
  }, 120_000);

  it("names the covered and uncovered owner of real Technic pins and holes, imported from the pinned LDraw library, for the same world however it was reached, as the specification names it: a pin's owner when only its mate zone's cell blocks, an uncovered model at a later cell before it, and the lower of two pins' owners at one cell", async () => {
    const built = await Promise.all([
      technicNamingParts(),
      technicNamingParts(),
      technicNamingParts(),
    ]);
    const worlds = built.map((parts) => technicNamingWorld(parts));
    const names = (worlds[0]?.entries ?? []).map((entry) => entry.name);
    const histories = built.map((parts, k) =>
      insertAll(
        new NamingHistory(parts, worlds[k]?.entries ?? [], 1 + 100 * k),
        k === 1 ? names.toReversed() : names,
      ),
    );
    const answersOf = (k: number) => {
      const history = histories[k];
      const scene = worlds[k];
      if (!history || !scene) throw new Error(`no history ${k}`);
      return {
        tierTwo: history.overlap(scene.held.tierTwo),
        laterTierOne: history.overlap(scene.held.laterTierOne),
        covered: history.overlap(scene.held.covered),
      };
    };
    const edited = histories[2];
    const editedWorld = worlds[2];
    if (!edited || !editedWorld) throw new Error("no edited history");
    answersOf(2);
    edited.carry(editedWorld.held.covered, "pin over a plate");
    for (const name of editedWorld.firstOfGroups) edited.reinsert(name);
    const answers = histories.map((_, k) => answersOf(k));
    const specified = histories.map((history, k) => {
      const oracle = new NamingOracle(history);
      const held = worlds[k]?.held;
      if (!held) throw new Error(`no world ${k}`);
      return {
        tierTwo: oracle.overlap(held.tierTwo),
        laterTierOne: oracle.overlap(held.laterTierOne),
        covered: oracle.overlap(held.covered),
      };
    });
    const mirrors = histories.map((history, k) => {
      const held = worlds[k]?.held;
      if (!held) throw new Error(`no world ${k}`);
      return new MainMirror(history, new NamingOracle(history)).overlap(held.covered);
    });
    const first = namedPiece(built[0] ?? (await technicNamingParts()), "pin over plate");
    const second = namedPiece(built[0] ?? (await technicNamingParts()), "pin over plate twin");
    const coveredOwner =
      first.item < second.item ? "first of two pins over plates" : "second of two pins over plates";
    const expected = {
      tierTwo: overlapAnswer("pin over a plate", [0, -1], OFFICIAL_3024, [0, 8, 0, 24]),
      laterTierOne: overlapAnswer("lone plate", [10, 0], OFFICIAL_3024, [0, 8, 0, 24]),
      covered: overlapAnswer(coveredOwner, [20, -1], OFFICIAL_3024, [0, 8, 0, 24]),
    };
    expect({
      answers,
      specified,
      coveredWitness: mirrors[0] !== mirrors[1] && mirrors[0] !== mirrors[2],
    }).toEqual({
      answers: [expected, expected, expected],
      specified: [expected, expected, expected],
      coveredWitness: true,
    });
  }, 120_000);
});

const REINSERTED_FROM = 500_000;
const ASSIST_CELLS = 2;
const LEFT_OUT_EVERY = 7;
const REMOVED_FIRST_EVERY = 5;
const PIN_PROBE = "pin into two bored items at one pose";

function recipeQueries(recipe: CanonicalRecipe): ReadonlyArray<Probe> {
  return [...recipe.probes, ...recipe.walks.flat()];
}

function namedQuery(recipe: CanonicalRecipe, name: string): Probe {
  const query = recipeQueries(recipe).find((candidate) => candidate.name === name);
  if (!query) throw new Error(`the recipe has no query named ${name}`);
  return query;
}

function reinsertedId(position: number): number {
  return REINSERTED_FROM + position;
}

function keptOnReAdd(k: number): boolean {
  return k % LEFT_OUT_EVERY !== 0;
}

function holdsTrackEnd(piece: Piece, pose: LatticePose): boolean {
  return piece.connectors.trackEndCount > 0 && pose.x % STUD_LDU === 0 && pose.z % STUD_LDU === 0;
}

function placedAnswer(history: CanonicalHistory, owner: number): unknown {
  const view = history.view(owner);
  return view ? [view.item, view.pose] : null;
}

function removeSomeFirst(history: CanonicalHistory): number {
  let heldTrackEndsFreed = 0;
  for (const [owner, listed] of history.live.listed) {
    const track = holdsTrackEnd(listed.piece, listed.pose);
    const removed = track ? heldTrackEndsFreed === 0 : owner % REMOVED_FIRST_EVERY === 0;
    if (!removed) continue;
    if (track) heldTrackEndsFreed++;
    history.live.search.remove(owner);
    history.live.listed.delete(owner);
  }
  return heldTrackEndsFreed;
}

function answersAfterReAdd(history: CanonicalHistory, kept: ReadonlyArray<number>): unknown[] {
  const search = history.live.search;
  const answers: unknown[] = recipeQueries(history.recipe).map((query) => {
    const checked = placementChoice();
    search.check(
      query.piece.connectors,
      query.piece.volumes,
      query.piece.parts.boxes,
      query.piece.parts.technic,
      query.pose,
      TABLE_Y_PLATES,
      checked,
    );
    return [
      query.name,
      history.raw(history.evaluate(query)),
      fullVerdict(checked),
      search
        .restingOn(query.piece.volumes, query.pose, null)
        .map((owner) => placedAnswer(history, owner)),
    ];
  });
  kept.forEach((k, position) => {
    const id = reinsertedId(position);
    const stranding = search.strandedByRemoval(new Set([id]), history.live.restsOnTable);
    answers.push([
      k,
      placedAnswer(history, search.overlapOf(id)),
      stranding.kind === "stranded" ? placedAnswer(history, stranding.placement) : stranding,
    ]);
  });
  return answers;
}

function emptiedThenReAdded(empty: (history: CanonicalHistory) => void) {
  const history = insertedInOrder(fixture());
  const heldTrackEndsFreed = removeSomeFirst(history);
  const held = namedQuery(history.recipe, PIN_PROBE);
  const assist = window(held.pose.x, held.pose.z, ASSIST_CELLS, held.pose.yPlates);
  const matedBefore = choose(history.recipe.f, held.piece, assist).votes > 0;
  const revision = history.live.search.revision();
  const carried = new Set([...history.live.listed.keys()].slice(0, CANONICAL_CARRY_SIZE));
  history.live.search.withdrawn(carried, () => history.evaluate(held));
  empty(history);
  const revisionAdvanced = history.live.search.revision() !== revision;
  history.live.listed.clear();
  const queriesWithRows = recipeQueries(history.recipe)
    .filter((query) => history.evaluate(query).count > 0)
    .map((query) => query.name);
  const atCursor = fullVerdict(choose(history.recipe.f, held.piece, assist));
  const kept = history.recipe.placed
    .map((_, k) => k)
    .filter(keptOnReAdd)
    .toReversed();
  history.insert(kept, reinsertedId);
  const heldTrackEndsReAdded = kept.filter((k) => {
    const entry = history.recipe.placed[k];
    return entry !== undefined && holdsTrackEnd(entry.piece, entry.pose);
  }).length;
  return {
    afterEmpty: {
      carrySize: carried.size,
      matedBefore,
      revisionAdvanced,
      queriesWithRows,
      atCursor,
    },
    partialReAdd: {
      differsFromFirst: kept.length < history.recipe.placed.length,
      heldTrackEnds: { freedBeforeEmpty: heldTrackEndsFreed, reAdded: heldTrackEndsReAdded },
    },
    answers: answersAfterReAdd(history, kept),
  };
}

function emptySearchAt(cursor: LatticePose) {
  return {
    carrySize: CANONICAL_CARRY_SIZE,
    matedBefore: true,
    revisionAdvanced: true,
    queriesWithRows: [],
    atCursor: {
      pose: [cursor.x, cursor.z, cursor.yPlates, 0],
      votes: 0,
      accepted: true,
      hit: null,
    },
  };
}

describe("PlacementSearch.clear", () => {
  it("answers as removing every placement one at a time does: empty despite a warm gather or an owed carry, and the same after a partial re-add", () => {
    const f = fixture();
    const pins = pinRow(f);
    const intoTheBore: LatticePose = { ...ORIGIN, x: HALF, z: STUD_LDU };
    const report = new MateReport();
    place(f, 1, boredBlock(f));
    f.search.evaluate(pins.connectors, intoTheBore, report);
    const matedThroughTheGather = report.count;
    f.search.clear();
    f.search.evaluate(pins.connectors, intoTheBore, report);
    expect({ matedThroughTheGather, afterClear: report.count }).toEqual({
      matedThroughTheGather: 1,
      afterClear: 0,
    });

    const cleared = emptiedThenReAdded((history) => history.live.search.clear());
    const removed = emptiedThenReAdded((history) => {
      for (const owner of history.live.listed.keys()) history.live.search.remove(owner);
    });
    const cursor = namedQuery(canonicalRecipe(fixture(), CANONICAL_SEED), PIN_PROBE).pose;
    const partialReAdd = {
      differsFromFirst: true,
      heldTrackEnds: { freedBeforeEmpty: 1, reAdded: 2 },
    };
    expect({
      cleared: [cleared.afterEmpty, cleared.partialReAdd],
      removed: [removed.afterEmpty, removed.partialReAdd],
    }).toEqual({
      cleared: [emptySearchAt(cursor), partialReAdd],
      removed: [emptySearchAt(cursor), partialReAdd],
    });
    expect(cleared.answers).toEqual(removed.answers);
  }, 120_000);
});

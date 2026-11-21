import {
  AXIS_NEG_Y,
  AXIS_NEG_Z,
  AXIS_POS_Y,
  AXIS_POS_Z,
  CAP_FAR,
  CAP_ROOT,
  ConnectorTable,
  GENDER_FEMALE,
  GENDER_MALE,
  MateReport,
  ModelConnectors,
  SECTION_ROUND,
  type SnapShapes,
  SOURCE_SHADOW,
  STATUS_VERIFIED,
  type LatticePose,
  type TrackEnd,
  WORLD_TRACK_FRAME,
} from "@brr/domain";
import { EMPTY_COLUMN } from "@brr/catalog";
import {
  PLATE_LDU,
  pose16,
  SIXTEENTHS_PER_LDU,
  STUD_LDU,
  zeta16,
  ZETA16_COEFFICIENT_COUNT,
} from "@brr/math";
import type { PartTechnic } from "@brr/schema/bundle";
import { Container } from "inversify";
import { describe, expect, it } from "vitest";
import { mainThreadModules } from "../client.module.ts";
import { distinctJoints } from "../edit/placement-hover.ts";
import { mateCounts } from "../edit/placement-hover-view.ts";
import type { PlaceablePartCells } from "../edit/placeable.ts";
import { PLACEMENT_SEARCH, SNAP_MATING, SNAP_SHAPES } from "../tokens.ts";
import { partBoxes, type PartBoxes } from "./part-boxes.ts";
import { FrozenTechnic } from "./frozen-technic.ts";
import { typedArraysConstructedDuring } from "./typed-arrays.test-support.ts";
import { FrozenVolumes } from "./placeable-volumes.ts";
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
const TABLE_Y_PLATES = 0;

type Box = ReadonlyArray<number>;
type Spec = readonly [shape: number, gender: number, x: number, y: number, z: number, axis: number];

interface Fixture {
  readonly search: IPlacementSearch;
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

function fixture(): Fixture {
  const container = new Container();
  container.load(...mainThreadModules({ bundleBaseUrl: "unused", disclaimer: "unused" }));
  const shapes = container.get(SNAP_SHAPES);
  const mating = container.get(SNAP_MATING);
  return {
    search: container.get(PLACEMENT_SEARCH),
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

function place(f: Fixture, owner: number, piece: Piece, pose: LatticePose = ORIGIN): void {
  f.search.add(
    owner,
    piece.connectors,
    piece.volumes,
    piece.parts.boxes,
    piece.parts.technic,
    pose,
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

function chooseInSlices(f: Fixture, piece: Piece, at: PlacementWindow): SlicedChoice {
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
    while (f.search.advance(ticket, EVERY_SLICE_OVERDUE) === "running") slices++;
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
    const mates = mateCounts(report, f.shapes, () => null);
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

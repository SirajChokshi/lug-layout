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
  ModelConnectors,
  SECTION_ROUND,
  SOURCE_SHADOW,
  modelTechnic,
  STATUS_VERIFIED,
  type LatticePose,
  type SnapWindow,
  type TechnicSet,
  type TrackEnd,
  WORLD_TRACK_FRAME,
} from "@brr/domain";
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
import { PLACEMENT_SEARCH, SNAP_MATING, SNAP_SHAPES } from "../tokens.ts";
import { partBoxes, type PartBoxes } from "./part-boxes.ts";
import { FrozenVolumes } from "./placeable-volumes.ts";
import {
  placementChoice,
  type IPlacementSearch,
  type PlacementChoice,
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

type Box = ReadonlyArray<number>;
type Spec = readonly [shape: number, gender: number, x: number, y: number, z: number, axis: number];

interface Fixture {
  readonly search: IPlacementSearch;
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
  readonly technic: TechnicSet;
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
    technic: modelTechnic(
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
  at: SnapWindow,
  moving: number | null = null,
): PlacementChoice {
  const choice = placementChoice();
  f.search.search(
    piece.connectors,
    piece.volumes,
    piece.parts.boxes,
    piece.parts.technic,
    at,
    moving,
    choice,
  );
  return choice;
}

function window(x: number, z: number, cells: number, yPlates = 0, plates = 1): SnapWindow {
  return { x, z, yPlates, rot: 0, cells, plates, turns: 1 };
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
    volumes: columns(2, 2, 0, BRICK_LDU, 0, -1),
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
  it("walks past a ranked pose that collides and takes the best pose that fits", () => {
    const f = fixture();
    const choice = choose(f, world(f), window(0, 0, 1));
    expect([
      choice.accepted,
      choice.x,
      choice.z,
      choice.yPlates,
      choice.votes,
      choice.walked,
    ]).toEqual([true, STUD_LDU, 0, 0, 4, 2]);
  });

  it("refuses with the top pose's overlap when every candidate collides, unless that volume is moving", () => {
    const f = fixture();
    const plate = world(f);
    const refused = choose(f, plate, window(0, 0, 0));
    expect([refused.accepted, refused.x, refused.z, refused.votes]).toEqual([false, 0, 0, 4]);
    expect(refused.overlap).toEqual({
      owner: BRICK,
      bottomLdu: 0,
      topLdu: BRICK_LDU,
      cellX: 0,
      cellZ: 0,
      candidateBottomLdu: 0,
      candidateTopLdu: PLATE_LDU,
    });
    expect(choose(f, plate, window(0, 0, 0), BRICK).accepted).toBe(true);
    f.search.remove(BRICK);
    const freed = choose(f, plate, window(0, 0, 0));
    expect([freed.accepted, freed.votes]).toEqual([true, 4]);
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

  it("finds the placement that a removal would leave with no mate and not resting on the table", () => {
    const f = fixture();
    const plate = world(f);
    place(f, PLATE, plate, { x: 2 * STUD_LDU, z: 2 * STUD_LDU, yPlates: 0, rot: 0 });
    const onTable = (placement: number): boolean => placement === BASEPLATE;
    expect(f.search.strandedByRemoval(BASEPLATE, onTable)).toBe(BRICK);
    expect(f.search.strandedByRemoval(BASEPLATE, () => true)).toBeNull();
    f.search.remove(BRICK);
    expect(f.search.strandedByRemoval(BASEPLATE, onTable)).toBe(PLATE);
    expect(f.search.strandedByRemoval(PLATE, onTable)).toBeNull();
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

  it("excuses two track pieces' overlap only where their mated ends join them", () => {
    const f = fixture();
    const length = 16;
    const tab = 4;
    const width = 8;
    place(f, LAID, {
      connectors: f.connectors([null], [straightEnd(length, 0)]),
      volumes: columns(length + 1, width, 0, PLATE_LDU),
      parts: partsOf([[0, 0, 0, length * STUD_LDU + tab, PLATE_LDU, width * STUD_LDU]]),
    });
    const next: Piece = {
      connectors: f.connectors([null], [straightEnd(0, 8)]),
      volumes: columns(length + 1, width, 0, PLATE_LDU, -1),
      parts: partsOf([[-tab, 0, 0, length * STUD_LDU, PLATE_LDU, width * STUD_LDU]]),
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

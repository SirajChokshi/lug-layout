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
  STATUS_VERIFIED,
  type LatticePose,
  type OverlapHit,
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
import { partAtHit } from "../edit/placement-hover-view.ts";
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

  it("names a refusal at the first overlapping cell whose placed part lies in the held band, past a single-interval column whose only part there sits above it", () => {
    const f = fixture();
    const baseplate = [0, -SLAB_LDU, 0, 2 * STUD_LDU, 0, STUD_LDU] as const;
    const overhangingPlate = [0, 5 * PLATE_LDU, 0, STUD_LDU, 6 * PLATE_LDU, STUD_LDU] as const;
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
        },
        slabBoxes: Float32Array.from(baseplate),
      }),
      parts: partsOf([[...baseplate], [...overhangingPlate]]),
    };
    place(f, OTHER, solid);
    const held = (cells: number, pinTop: number, slab: ReadonlyArray<number>): Piece => ({
      connectors: f.connectors(Array.from({ length: cells }, () => null)),
      volumes: FrozenVolumes.ofPlaceable({
        cells: {
          cellX0: 0,
          cellZ0: 0,
          width: cells,
          depth: 1,
          columnBottom: new Int16Array(cells),
          columnTop: Int16Array.from({ length: cells }, (_, c) => (c === 0 ? pinTop : 0)),
        },
        slabBoxes: Float32Array.from(slab),
      }),
      parts: partsOf([[0, 0, 0, STUD_LDU, pinTop * PLATE_LDU, STUD_LDU]]),
    });
    const pinAndBaseplate = held(2, 3, [STUD_LDU, -SLAB_LDU, 0, 2 * STUD_LDU, 0, STUD_LDU]);
    const pinOnly = held(1, 3, []);
    const namer = {
      names: (hit: OverlapHit) =>
        partAtHit(
          solid.parts.boxes.boxes,
          solid.parts.boxes.boxes.length,
          hit.cellX,
          hit.cellZ,
          Math.max(hit.bottomLdu, hit.candidateBottomLdu),
          Math.min(hit.topLdu, hit.candidateTopLdu),
          (instance) => ({ part: `part ${instance}`, partLabel: "" }),
        ) !== null,
    };
    const nameOn = (piece: Piece) => {
      const named = placementChoice().overlap;
      const found = f.search.nameOverlap(
        piece.connectors,
        piece.volumes,
        piece.parts.boxes,
        piece.parts.technic,
        ORIGIN,
        null,
        namer,
        named,
      );
      return found ? [named.cellX, named.cellZ] : null;
    };
    const refused = choose(f, pinAndBaseplate, window(0, 0, 0, 0, 0));

    expect({
      refused: refused.accepted ? null : [refused.overlap.cellX, refused.overlap.cellZ],
      named: nameOn(pinAndBaseplate),
      onlyByColumn: nameOn(pinOnly),
    }).toEqual({ refused: [0, 0], named: [1, 0], onlyByColumn: null });
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
    const ell: Piece = {
      connectors: f.connectors([null]),
      volumes: FrozenVolumes.ofPlaceable({
        cells: {
          cellX0: 0,
          cellZ0: 0,
          width: 2,
          depth: 2,
          columnBottom: new Int16Array(4),
          columnTop: Int16Array.of(3, 3, 3, EMPTY_COLUMN),
        },
        slabBoxes: new Float32Array(0),
      }),
      parts: partsOf([[0, 0, 0, 2 * STUD_LDU, BRICK_LDU, 2 * STUD_LDU]]),
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
    const held = {
      connectors: f.connectors([
        table([
          [f.freePin, GENDER_MALE, LINE_X, LINE_Y, -HALF, AXIS_POS_Z],
          [f.freePin, GENDER_MALE, LINE_X, LINE_Y, STUD_LDU + HALF, AXIS_NEG_Z],
        ]),
      ]),
      volumes: columns(2, 3, 0, BRICK_LDU, 0, -1),
      parts: partsOf([[LINE_X - 6, LINE_Y - 6, -HALF, LINE_X + 6, LINE_Y + 6, STUD_LDU + HALF]]),
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

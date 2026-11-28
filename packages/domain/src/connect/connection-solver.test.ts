import { describe, expect, it } from "vitest";
import {
  PLATE_LDU,
  SIXTEENTHS_PER_LDU,
  STUD_LDU,
  ZETA16_ZERO,
  composePose16,
  pose16,
  posesJoin16,
  rot90Cos,
  rot90Sin,
  rotateZeta16,
  subtractZeta16,
  zeta16,
} from "@brr/math";
import { WORLD_TRACK_FRAME, type TrackEnd } from "../track/end-gaps.ts";
import { CandidatePoses, type LatticePose, type SnapWindow } from "./candidate-poses.ts";
import { ConnectionSolver } from "./connection-solver.ts";
import {
  AXIS_NEG_X,
  AXIS_NEG_Y,
  AXIS_NEG_Z,
  AXIS_POS_X,
  AXIS_POS_Y,
  AXIS_POS_Z,
  AXIS_FREE,
  ConnectorTable,
  connectorOriginLdu,
  GENDER_FEMALE,
  GENDER_MALE,
  SOURCE_INFERRED,
  SOURCE_PATCH,
  SOURCE_SHADOW,
  STATUS_UNVERIFIED,
  STATUS_VERIFIED,
  VECTOR_FLOATS,
  axisDimension,
  axisSign,
  oppositeAxis,
} from "./connector-table.ts";
import { isLatticeStud } from "./lattice-frame.ts";
import { LatticeStudFinder } from "./lattice-stud-finder.ts";
import { MATE_PASS_MODEL, MATE_PASS_PART, MATE_PASS_SUBMODEL, MatePairs } from "./mate-pairs.ts";
import {
  ENGAGED_U,
  ENGAGEMENT_FLOATS,
  MateReport,
  NO_PARTNER,
  NOT_ENGAGED,
} from "./mate-report.ts";
import { SnapMating } from "./mating.ts";
import { ModelConnectors, NO_INSTANCE } from "./model-connectors.ts";
import { ProposalProgress } from "./proposal-progress.ts";
import { IDENTIFICATION_RESIDUAL_LDU, MODEL_ROOT } from "./submodel-frames.ts";
import { SparseConnectorFinder } from "./sparse-connector-finder.ts";
import { TrackEndFinder } from "./track-end-finder.ts";
import {
  CAP_FAR,
  CAP_ROOT,
  FINGER_RADIUS_UNSTATED,
  SECTION_AXLE,
  SECTION_ROUND,
  SECTION_SQUARE,
  SECTION_FLARE_JOINS_NEXT,
  SECTION_FLARE_JOINS_PREVIOUS,
  SECTION_FEMALE_FINGER,
  SECTION_MALE_FINGER,
  NO_GROUP,
  SnapShapes,
} from "./snap-shapes.ts";

type QuarterTurn = 0 | 1 | 2 | 3;
type Section = readonly [code: number, size: number, length: number];

interface Spec {
  readonly shape: number;
  readonly gender: number;
  readonly source?: number;
  readonly status?: number;
  readonly origin: readonly [number, number, number];
  readonly axis: number;
  readonly piece?: number;
}

const shapes = new SnapShapes();
const mating = new SnapMating(shapes);

function shape(caps: number, slide: boolean, sections: ReadonlyArray<Section>): number {
  return shapes.intern(
    caps,
    slide,
    sections.map(([code]) => code),
    sections.map(([, size]) => size),
    sections.map(([, , length]) => length),
  );
}

const STUD = shape(CAP_ROOT, false, [[SECTION_ROUND, 6, 4]]);
const PLATE_RECEPTOR = shape(CAP_FAR, false, [[SECTION_ROUND, 6, 4]]);
const BRICK_RECEPTOR = shape(CAP_FAR, false, [[SECTION_ROUND, 6, 20]]);
const BRICK_LDU = 3 * PLATE_LDU;
const UNMODELLED_SECTION = 7;
const HALF = STUD_LDU / 2;
const PROPERTY_TIMEOUT_MS = 30_000;

function table(specs: ReadonlyArray<Spec>): ConnectorTable {
  return new ConnectorTable(
    Uint16Array.from(specs, (s) => s.shape),
    Uint8Array.from(specs, (s) => s.gender),
    Uint8Array.from(specs, (s) => s.source ?? SOURCE_SHADOW),
    Uint8Array.from(specs, (s) => s.status ?? STATUS_VERIFIED),
    Int32Array.from(
      specs.flatMap((s) => (s.axis === AXIS_FREE ? [0, 0, 0] : s.origin.map(toSixteenths))),
    ),
    Int8Array.from(specs, (s) => s.axis),
    new Float64Array(specs.length * 3),
    Uint16Array.from(specs, (s) => s.piece ?? 0),
    Float64Array.from(specs.flatMap((s) => (s.axis === AXIS_FREE ? s.origin : [0, 0, 0]))),
    [],
  );
}

function grid(width: number, depth: number, spec: (x: number, z: number) => Spec): Spec[] {
  const specs: Spec[] = [];
  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < width; i++) specs.push(spec(i * STUD_LDU + HALF, j * STUD_LDU + HALF));
  }
  return specs;
}

function block(width: number, depth: number, heightLdu: number, receptor: number): ConnectorTable {
  return table([
    ...grid(width, depth, (x, z) => ({
      shape: STUD,
      gender: GENDER_MALE,
      origin: [x, heightLdu, z],
      axis: AXIS_POS_Y,
    })),
    ...grid(width, depth, (x, z) => ({
      shape: receptor,
      gender: GENDER_FEMALE,
      origin: [x, 0, z],
      axis: AXIS_NEG_Y,
    })),
  ]);
}

function baseplate(width: number, depth: number, source = SOURCE_SHADOW): ConnectorTable {
  return table(
    grid(width, depth, (x, z) => ({
      shape: STUD,
      gender: GENDER_MALE,
      source,
      origin: [x, 0, z],
      axis: AXIS_POS_Y,
    })),
  );
}

function withProvenance(part: ConnectorTable, source: number, status: number): ConnectorTable {
  return new ConnectorTable(
    part.shape,
    part.gender,
    new Uint8Array(part.count).fill(source),
    new Uint8Array(part.count).fill(status),
    part.origin,
    part.axis,
    part.axisFree,
    part.piece,
    part.originFree,
    part.unreadable,
  );
}

function toSixteenths(ldu: number): number {
  return ldu * SIXTEENTHS_PER_LDU;
}

function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
}

function model(
  parts: ReadonlyArray<ConnectorTable | null>,
  placements: ReadonlyArray<readonly [number, ReadonlyArray<number>]>,
): ModelConnectors {
  return ModelConnectors.fromParts(
    parts,
    {
      count: placements.length,
      partIndex: placements.map(([part]) => part),
      matrices: Float64Array.from(placements.flatMap(([, matrix]) => matrix)),
    },
    mating,
  );
}

function single(part: ConnectorTable): ModelConnectors {
  return model([part], [[0, translation(0, 0, 0)]]);
}

function pose(x: number, z: number, yPlates: number, rot: QuarterTurn = 0): LatticePose {
  return { x, z, yPlates, rot };
}

function latticeOnly(): ConnectionSolver {
  return new ConnectionSolver([new LatticeStudFinder(mating)]);
}

function allFamilies(): ConnectionSolver {
  return new ConnectionSolver([new LatticeStudFinder(mating), new SparseConnectorFinder(mating)]);
}

function evaluated(engine: ConnectionSolver, piece: ModelConnectors, at: LatticePose): MateReport {
  const report = new MateReport();
  engine.evaluate(piece, at, report);
  return report;
}

function matesAt(engine: ConnectionSolver, piece: ModelConnectors, at: LatticePose): number {
  return evaluated(engine, piece, at).count;
}

function window(at: LatticePose, cells: number, plates: number, turns = 1): SnapWindow {
  return { ...at, cells, plates, turns };
}

describe("ConnectionSolver with lattice studs", () => {
  it("mates every receptor that lands on a baseplate stud, at every turn and offset", () => {
    const engine = latticeOnly();
    const width = 6;
    engine.insert(single(baseplate(width, width)), pose(0, 0, 0), 10);
    const plate = single(block(2, 3, PLATE_LDU, PLATE_RECEPTOR));
    const candidates = new CandidatePoses();
    for (const rot of [0, 1, 2, 3] as const) {
      for (let cx = -4; cx <= width + 4; cx++) {
        for (let cz = -4; cz <= width + 4; cz++) {
          const at = pose(cx * STUD_LDU, cz * STUD_LDU, 0, rot);
          let expected = 0;
          for (let j = 0; j < 3; j++) {
            for (let i = 0; i < 2; i++) {
              const lx = i * STUD_LDU + HALF;
              const lz = j * STUD_LDU + HALF;
              const wx = rot90Cos(rot) * lx + rot90Sin(rot) * lz + at.x;
              const wz = -rot90Sin(rot) * lx + rot90Cos(rot) * lz + at.z;
              if (wx > 0 && wz > 0 && wx < width * STUD_LDU && wz < width * STUD_LDU) expected++;
            }
          }
          expect(matesAt(engine, plate, at)).toBe(expected);
          engine.rank(plate, window(at, 0, 0), candidates);
          expect(candidates.votes[0]).toBe(expected);
          expect(matesAt(engine, plate, pose(at.x, at.z, 1, rot))).toBe(0);
        }
      }
    }
  });

  it("ranks the pose with the most mates first, and the nearest one among equals", () => {
    const engine = latticeOnly();
    engine.insert(single(baseplate(4, 4)), pose(0, 0, 0), 11);
    const plate = single(block(2, 2, PLATE_LDU, PLATE_RECEPTOR));
    const candidates = new CandidatePoses();
    engine.rank(plate, window(pose(-STUD_LDU, STUD_LDU, 0), 1, 1), candidates);
    expect([candidates.x[0], candidates.z[0], candidates.yPlates[0], candidates.votes[0]]).toEqual([
      0,
      STUD_LDU,
      0,
      4,
    ]);
    expect([candidates.x[1], candidates.z[1], candidates.votes[1]]).toEqual([0, 0, 4]);
    for (let i = 1; i < candidates.count; i++) {
      expect(candidates.votes[i]).toBeLessThanOrEqual(candidates.votes[i - 1] ?? 0);
    }
  });

  it("finds the height where the model seats on the stack under the cursor", () => {
    const engine = latticeOnly();
    engine.insert(single(baseplate(8, 8)), pose(0, 0, 0), 12);
    const brick = single(block(2, 2, BRICK_LDU, BRICK_RECEPTOR));
    engine.insert(brick, pose(2 * STUD_LDU, 2 * STUD_LDU, 0), 13);
    const plate = single(block(2, 2, PLATE_LDU, PLATE_RECEPTOR));
    const candidates = new CandidatePoses();
    engine.rank(plate, window(pose(2 * STUD_LDU, 2 * STUD_LDU, 2), 0, 1), candidates);
    expect([candidates.yPlates[0], candidates.votes[0]]).toEqual([BRICK_LDU / PLATE_LDU, 4]);
  });

  it("keeps a connector placed twice until both placements are removed", () => {
    const engine = latticeOnly();
    const base = single(baseplate(2, 2));
    const plate = single(block(2, 2, PLATE_LDU, PLATE_RECEPTOR));
    engine.insert(base, pose(0, 0, 0), 1);
    engine.insert(base, pose(0, 0, 0), 2);
    engine.remove(base, pose(0, 0, 0), 1);
    expect(matesAt(engine, plate, pose(0, 0, 0))).toBe(4);
    engine.remove(base, pose(0, 0, 0), 2);
    expect(matesAt(engine, plate, pose(0, 0, 0))).toBe(0);
    expect(() => engine.remove(base, pose(0, 0, 0), 2)).toThrow(RangeError);
  });

  it("mates a half-stud offset connector only at the offset that puts it on the lattice", () => {
    const engine = latticeOnly();
    engine.insert(single(baseplate(4, 4)), pose(0, 0, 0), 14);
    const jumper = single(
      table([
        { shape: PLATE_RECEPTOR, gender: GENDER_FEMALE, origin: [0, 0, HALF], axis: AXIS_NEG_Y },
      ]),
    );
    expect(matesAt(engine, jumper, pose(HALF + STUD_LDU, 0, 0))).toBe(1);
    expect(matesAt(engine, jumper, pose(STUD_LDU, 0, 0))).toBe(0);
  });

  it.each<[string, ReadonlyArray<Section>, ReadonlyArray<Section>, number]>([
    ["round in round of its size", [[SECTION_ROUND, 6, 8]], [[SECTION_ROUND, 6, 8]], 1],
    ["axle in round of its half-width", [[SECTION_AXLE, 6, 8]], [[SECTION_ROUND, 6, 8]], 1],
    ["axle in axle", [[SECTION_AXLE, 4, 8]], [[SECTION_AXLE, 4, 8]], 1],
    ["round in square of its half-width", [[SECTION_ROUND, 6, 8]], [[SECTION_SQUARE, 6, 8]], 1],
    ["round never in axle", [[SECTION_ROUND, 4, 8]], [[SECTION_AXLE, 4, 8]], 0],
    ["square corners outside a round", [[SECTION_SQUARE, 6, 8]], [[SECTION_ROUND, 6, 8]], 0],
    [
      "an unmodelled section shape never mates",
      [[UNMODELLED_SECTION, 6, 8]],
      [[SECTION_ROUND, 6, 8]],
      0,
    ],
    ["round loose in a larger round", [[SECTION_ROUND, 4, 8]], [[SECTION_ROUND, 6, 8]], 0],
    ["round too large for the round", [[SECTION_ROUND, 6, 8]], [[SECTION_ROUND, 4, 8]], 0],
    [
      "stud gripped past a counterbore",
      [[SECTION_ROUND, 6, 4]],
      [
        [SECTION_ROUND, 8, 2],
        [SECTION_ROUND, 6, 16],
      ],
      1,
    ],
    [
      "counterbore-sized round blocked by the bore",
      [[SECTION_ROUND, 8, 4]],
      [
        [SECTION_ROUND, 8, 2],
        [SECTION_ROUND, 6, 16],
      ],
      0,
    ],
  ])("section containment: %s", (_, maleSections, femaleSections, mates) => {
    const engine = latticeOnly();
    const female = shape(CAP_FAR, false, femaleSections);
    const receptors = grid(2, 2, (x, z) => ({
      shape: female,
      gender: GENDER_FEMALE,
      origin: [x, 0, z],
      axis: AXIS_POS_Y,
    }));
    engine.insert(single(table(receptors)), pose(-STUD_LDU, -STUD_LDU, 0), 15);
    const male = shape(CAP_ROOT, false, maleSections);
    const piece = single(
      table([{ shape: male, gender: GENDER_MALE, origin: [HALF, 0, HALF], axis: AXIS_NEG_Y }]),
    );
    for (const rot of [0, 1, 2, 3] as const) {
      expect(matesAt(engine, piece, pose(0, 0, 0, rot))).toBe(mates);
    }
  });

  interface Engagement {
    readonly male: readonly [caps: number, slide: boolean, sections: ReadonlyArray<Section>];
    readonly female: readonly [caps: number, slide: boolean, sections: ReadonlyArray<Section>];
    readonly engaged: ReadonlyArray<number>;
    readonly refused: ReadonlyArray<number>;
  }

  it.each<[string, Engagement]>([
    [
      "a bar slides through a shorter open clip",
      {
        male: [CAP_ROOT, true, [[SECTION_ROUND, 4, 20]]],
        female: [0, false, [[SECTION_ROUND, 4, 4]]],
        engaged: [0, 1, 2],
        refused: [-1, 3],
      },
    ],
    [
      "a bar attached at its root enters a longer sliding tube only up to its root",
      {
        male: [CAP_ROOT, true, [[SECTION_ROUND, 4, 4]]],
        female: [0, true, [[SECTION_ROUND, 4, 20]]],
        engaged: [0],
        refused: [-1, -2],
      },
    ],
    [
      "a stud inserts fully into a deeper blind cavity",
      {
        male: [CAP_ROOT, false, [[SECTION_ROUND, 6, 4]]],
        female: [CAP_FAR, false, [[SECTION_ROUND, 6, 20]]],
        engaged: [0],
        refused: [-1, 1],
      },
    ],
    [
      "a stud longer than a blind cavity never seats",
      {
        male: [CAP_ROOT, false, [[SECTION_ROUND, 6, 8]]],
        female: [CAP_FAR, false, [[SECTION_ROUND, 6, 4]]],
        engaged: [],
        refused: [0, 1],
      },
    ],
    [
      "a tube longer than a bar held at both ends can't slide over it",
      {
        male: [CAP_ROOT | CAP_FAR, true, [[SECTION_ROUND, 4, 8]]],
        female: [0, true, [[SECTION_ROUND, 4, 20]]],
        engaged: [],
        refused: [0, -1],
      },
    ],
    [
      "a pin longer than a through hole passes through it",
      {
        male: [CAP_ROOT, false, [[SECTION_ROUND, 6, 8]]],
        female: [0, false, [[SECTION_ROUND, 6, 4]]],
        engaged: [0],
        refused: [1],
      },
    ],
  ])("axial engagement: %s", (_, { male, female, engaged, refused }) => {
    const engine = latticeOnly();
    const maleShape = shape(...male);
    engine.insert(
      single(
        table([
          { shape: maleShape, gender: GENDER_MALE, origin: [HALF, 0, HALF], axis: AXIS_POS_Y },
        ]),
      ),
      pose(0, 0, 0),
      16,
    );
    const femaleShape = shape(...female);
    const receptor = single(
      table([
        { shape: femaleShape, gender: GENDER_FEMALE, origin: [HALF, 0, HALF], axis: AXIS_NEG_Y },
      ]),
    );
    for (const y of engaged) expect(matesAt(engine, receptor, pose(0, 0, y))).toBe(1);
    for (const y of refused) expect(matesAt(engine, receptor, pose(0, 0, y))).toBe(0);
  });

  it("never mates connectors whose axes point the same way", () => {
    const engine = latticeOnly();
    engine.insert(single(baseplate(1, 1)), pose(0, 0, 0), 17);
    const upward = single(
      table([
        { shape: PLATE_RECEPTOR, gender: GENDER_FEMALE, origin: [HALF, 0, HALF], axis: AXIS_POS_Y },
      ]),
    );
    expect(matesAt(engine, upward, pose(0, 0, 0))).toBe(0);
  });

  const VERIFIED = STATUS_VERIFIED;
  const UNVERIFIED = STATUS_UNVERIFIED;
  it.each([
    [
      "both curated",
      [SOURCE_SHADOW, VERIFIED],
      [SOURCE_SHADOW, VERIFIED],
      [SOURCE_SHADOW, VERIFIED],
    ],
    [
      "the placed side inferred",
      [SOURCE_INFERRED, VERIFIED],
      [SOURCE_SHADOW, VERIFIED],
      [SOURCE_INFERRED | SOURCE_SHADOW, VERIFIED],
    ],
    [
      "the held side inferred",
      [SOURCE_SHADOW, VERIFIED],
      [SOURCE_INFERRED, VERIFIED],
      [SOURCE_SHADOW | SOURCE_INFERRED, VERIFIED],
    ],
    [
      "the placed side an unverified patch",
      [SOURCE_PATCH, UNVERIFIED],
      [SOURCE_SHADOW, VERIFIED],
      [SOURCE_PATCH | SOURCE_SHADOW, UNVERIFIED],
    ],
    [
      "the held side unverified",
      [SOURCE_SHADOW, VERIFIED],
      [SOURCE_SHADOW, UNVERIFIED],
      [SOURCE_SHADOW, UNVERIFIED],
    ],
  ] as const)(
    "reports each mate's sources as a bitmask of both tiers, and unverified if either side is: %s",
    (_, placed, held, expected) => {
      const engine = allFamilies();
      engine.insert(
        single(withProvenance(baseplate(2, 2), placed[0], placed[1])),
        pose(0, 0, 0),
        100,
      );
      engine.insert(single(withProvenance(edgeHoles(), placed[0], placed[1])), pose(0, 0, 0), 101);
      const plate = single(
        withProvenance(block(2, 2, PLATE_LDU, PLATE_RECEPTOR), held[0], held[1]),
      );
      const pins = single(withProvenance(edgePins(), held[0], held[1]));
      for (const [piece, at] of [
        [plate, pose(0, 0, 0)],
        [pins, pose(-NEIGHBOUR_WIDTH_LDU, 0, 0)],
      ] as const) {
        const report = evaluated(engine, piece, at);
        expect(report.count).toBe(4);
        expect(Array.from(report.sourceMask.subarray(0, report.count))).toEqual(
          Array(4).fill(expected[0]),
        );
        expect(Array.from(report.status.subarray(0, report.count))).toEqual(
          Array(4).fill(expected[1]),
        );
      }
    },
  );
});

const FAR_LDU = 20_000;
const ONE_SIXTEENTH_LDU = 1 / SIXTEENTHS_PER_LDU;
const DUST_BEYOND_RESIDUAL_LDU = 1.8 * IDENTIFICATION_RESIDUAL_LDU;

function facesFromBothEnds(
  shapeId: number,
  gender: number,
  from: number,
  to: number,
  axis: number,
): ConnectorTable {
  return table([
    { shape: shapeId, gender, origin: [0, 0, from], axis },
    {
      shape: shapeId,
      gender,
      origin: [0, 0, to],
      axis: axis === AXIS_POS_Z ? AXIS_NEG_Z : AXIS_POS_Z,
    },
  ]);
}

function oneFace(shapeId: number, gender: number, axis: number): ConnectorTable {
  return table([{ shape: shapeId, gender, origin: [0, 0, 0], axis }]);
}

function outwardAlongZ(besideShape: number, alongLdu = 0, status = STATUS_VERIFIED): Spec {
  return {
    shape: besideShape,
    gender: GENDER_MALE,
    source: status === STATUS_VERIFIED ? SOURCE_SHADOW : SOURCE_INFERRED,
    status,
    origin: [0, 0, alongLdu],
    axis: AXIS_POS_Z,
  };
}

function onTheZAxis(zLdu: number): number[] {
  return [0, 0, zLdu].map(toSixteenths);
}

function exposedStretches(connectors: ModelConnectors) {
  return Array.from({ length: connectors.count }, (_, n) => {
    const exposedShape = connectors.shape[n] ?? 0;
    const first = shapes.firstSection(exposedShape);
    return {
      origin: Array.from(connectors.origin.subarray(n * 3, n * 3 + 3)),
      axis: connectors.axis[n],
      caps: shapes.caps(exposedShape),
      slides: shapes.slides(exposedShape),
      sections: Array.from({ length: shapes.sectionCount(exposedShape) }, (_section, s) => [
        shapes.internedCode(first + s),
        shapes.internedSize(first + s),
        shapes.span(first + s),
      ]),
    };
  });
}

describe("ModelConnectors", () => {
  it("exposes a connector mated inside its model only over the free stretch that reaches an open end, closed at the cut and rooted on an exact sixteenth", () => {
    const pin = shape(0, true, [
      [SECTION_FLARE_JOINS_NEXT, 6.25, 2],
      [SECTION_ROUND, 6, 16],
      [SECTION_ROUND, 8, 4],
      [SECTION_ROUND, 6, 16],
      [SECTION_FLARE_JOINS_PREVIOUS, 6.25, 2],
    ]);
    const bore = shape(0, true, [
      [SECTION_ROUND, 8, 2],
      [SECTION_ROUND, 6, 16],
      [SECTION_ROUND, 8, 2],
    ]);
    const closedTip = shape(CAP_ROOT | CAP_FAR, false, [[SECTION_ROUND, 6, 8]]);
    const shortSleeve = shape(0, false, [[SECTION_ROUND, 6, 4]]);
    const rod = shape(0, true, [[SECTION_ROUND, 6, STUD_LDU]]);
    const sleeveOffTheSixteenthGrid = shape(0, false, [[SECTION_ROUND, 6, 4.1]]);
    const bar = shape(0, true, [[SECTION_ROUND, 4, STUD_LDU]]);
    const tube = shape(0, false, [[SECTION_ROUND, 4, BRICK_LDU]]);
    const x = 3 * STUD_LDU;
    const y = 2 * PLATE_LDU;
    const z = 5 * STUD_LDU + ONE_SIXTEENTH_LDU;
    const sixteenths = (zLdu: number) => [x, y, zLdu].map(toSixteenths);
    const placed = (male: ConnectorTable, female: ConnectorTable) => {
      const connectors = model(
        [male, female],
        [
          [0, translation(x, y, z)],
          [1, translation(x, y, z)],
        ],
      );
      return { exposed: exposedStretches(connectors), offLattice: connectors.offLattice };
    };
    expect({
      pinHalfInItsBore: placed(
        facesFromBothEnds(pin, GENDER_MALE, -STUD_LDU, STUD_LDU, AXIS_POS_Z),
        facesFromBothEnds(bore, GENDER_FEMALE, -STUD_LDU, 0, AXIS_NEG_Z),
      ),
      closedTipThroughASleeve: placed(
        oneFace(closedTip, GENDER_MALE, AXIS_POS_Z),
        oneFace(shortSleeve, GENDER_FEMALE, AXIS_NEG_Z),
      ),
      rodCutOffTheSixteenthGrid: placed(
        oneFace(rod, GENDER_MALE, AXIS_POS_Z),
        oneFace(sleeveOffTheSixteenthGrid, GENDER_FEMALE, AXIS_NEG_Z),
      ),
      barRootedInsideATube: placed(
        facesFromBothEnds(bar, GENDER_MALE, 10, -10, AXIS_NEG_Z),
        facesFromBothEnds(tube, GENDER_FEMALE, 0, BRICK_LDU, AXIS_NEG_Z),
      ),
    }).toEqual({
      pinHalfInItsBore: {
        exposed: [
          {
            origin: sixteenths(z),
            axis: AXIS_POS_Z,
            caps: CAP_ROOT,
            slides: true,
            sections: [
              [SECTION_ROUND, 8, 2],
              [SECTION_ROUND, 6, 16],
              [SECTION_FLARE_JOINS_PREVIOUS, 6.25, 2],
            ],
          },
        ],
        offLattice: 0,
      },
      closedTipThroughASleeve: { exposed: [], offLattice: 0 },
      rodCutOffTheSixteenthGrid: { exposed: [], offLattice: 1 },
      barRootedInsideATube: {
        exposed: [
          {
            origin: sixteenths(z),
            axis: AXIS_NEG_Z,
            caps: CAP_ROOT,
            slides: true,
            sections: [[SECTION_ROUND, 4, 10]],
          },
          {
            origin: sixteenths(z + BRICK_LDU),
            axis: AXIS_POS_Z,
            caps: CAP_FAR,
            slides: false,
            sections: [[SECTION_ROUND, 4, 14]],
          },
        ],
        offLattice: 0,
      },
    });
  });

  it("exposes a free stretch unless an exposed face of the same part instance, gender and axis line covers its whole interval exactly, and a face covering only part of it removes nothing", () => {
    const slidingPin = shape(0, true, [
      [SECTION_FLARE_JOINS_NEXT, 6.25, 2],
      [SECTION_ROUND, 6, 16],
      [SECTION_ROUND, 8, 4],
      [SECTION_ROUND, 6, 16],
      [SECTION_FLARE_JOINS_PREVIOUS, 6.25, 2],
    ]);
    const bore = shape(0, true, [
      [SECTION_ROUND, 8, 2],
      [SECTION_ROUND, 6, 16],
      [SECTION_ROUND, 8, 2],
    ]);
    const halfPin = shape(CAP_ROOT, false, [
      [SECTION_ROUND, 8, 2],
      [SECTION_ROUND, 6, 16],
      [SECTION_FLARE_JOINS_PREVIOUS, 6.25, 2],
    ]);
    const inferredShaft = shape(CAP_ROOT, false, [[SECTION_ROUND, 6, 9.5]]);
    const innerBar = shape(CAP_ROOT, false, [[SECTION_ROUND, 4, STUD_LDU]]);
    const z = 5 * STUD_LDU;
    const collarLdu = 2;
    const placed = (beside: Spec) => {
      const connectors = model(
        [
          table([
            { shape: slidingPin, gender: GENDER_MALE, origin: [0, 0, -STUD_LDU], axis: AXIS_POS_Z },
            { shape: slidingPin, gender: GENDER_MALE, origin: [0, 0, STUD_LDU], axis: AXIS_NEG_Z },
            beside,
          ]),
          facesFromBothEnds(bore, GENDER_FEMALE, -STUD_LDU, 0, AXIS_NEG_Z),
        ],
        [
          [0, translation(0, 0, z)],
          [1, translation(0, 0, z)],
        ],
      );
      return { exposed: exposedStretches(connectors), offLattice: connectors.offLattice };
    };
    const asExposed = (exposedShape: number, alongLdu = 0) => ({
      origin: onTheZAxis(z + alongLdu),
      axis: AXIS_POS_Z,
      caps: shapes.caps(exposedShape),
      slides: shapes.slides(exposedShape),
      sections: Array.from({ length: shapes.sectionCount(exposedShape) }, (_, s) => [
        shapes.internedCode(shapes.firstSection(exposedShape) + s),
        shapes.internedSize(shapes.firstSection(exposedShape) + s),
        shapes.span(shapes.firstSection(exposedShape) + s),
      ]),
    });
    const wholeFreeTip = {
      origin: onTheZAxis(z),
      axis: AXIS_POS_Z,
      caps: CAP_ROOT,
      slides: true,
      sections: [
        [SECTION_ROUND, 8, 2],
        [SECTION_ROUND, 6, 16],
        [SECTION_FLARE_JOINS_PREVIOUS, 6.25, 2],
      ],
    };
    expect({
      halfPinCoversTheWholeTip: placed(outwardAlongZ(halfPin)),
      inferredShaftCoversPartOfTheTip: placed(
        outwardAlongZ(inferredShaft, collarLdu, STATUS_UNVERIFIED),
      ),
      nestedBarDoesNotCover: placed(outwardAlongZ(innerBar)),
    }).toEqual({
      halfPinCoversTheWholeTip: { exposed: [asExposed(halfPin)], offLattice: 0 },
      inferredShaftCoversPartOfTheTip: {
        exposed: [wholeFreeTip, asExposed(inferredShaft, collarLdu)],
        offLattice: 0,
      },
      nestedBarDoesNotCover: { exposed: [wholeFreeTip, asExposed(innerBar)], offLattice: 0 },
    });
  });

  it("identifies far from the model origin in double precision, refusing dust that single precision would erase", () => {
    const far = FAR_LDU + ONE_SIXTEENTH_LDU;
    const exact = model([baseplate(1, 1)], [[0, translation(far, 0, far)]]);
    expect([exact.count, exact.offLattice]).toEqual([1, 0]);
    expect(exact.origin[0]).toBe((far + HALF) * SIXTEENTHS_PER_LDU);
    const dusty = far + DUST_BEYOND_RESIDUAL_LDU;
    expect(Math.fround(dusty)).toBe(far);
    const refused = model([baseplate(1, 1)], [[0, translation(dusty, 0, far)]]);
    expect([refused.count, refused.offLattice]).toEqual([0, 1]);
  });

  it("consumes internal mates, so studs covered inside a model never vote outside it", () => {
    const plate = block(2, 2, PLATE_LDU, PLATE_RECEPTOR);
    const stack = model(
      [plate],
      [
        [0, translation(0, 0, 0)],
        [0, translation(0, PLATE_LDU, 0)],
      ],
    );
    expect([stack.internalMates, stack.count]).toEqual([4, 8]);
    const engine = latticeOnly();
    engine.insert(stack, pose(0, 0, 0), 20);
    const piece = single(plate);
    expect(matesAt(engine, piece, pose(0, 0, 1))).toBe(0);
    expect(matesAt(engine, piece, pose(0, 0, 2))).toBe(4);
  });

  it("occupies every hole an axle passes through and both copies of a stud declared twice, in whichever frame they engage", () => {
    const length = 3 * PLATE_LDU;
    const shaft = shape(0, true, [[SECTION_AXLE, 6, length]]);
    const axle = table([
      { shape: shaft, gender: GENDER_MALE, origin: [0, 0, 0], axis: AXIS_POS_Y },
      { shape: shaft, gender: GENDER_MALE, origin: [0, length, 0], axis: AXIS_NEG_Y },
    ]);
    const hole = shape(0, false, [[SECTION_AXLE, 6, PLATE_LDU]]);
    const beam = table([
      { shape: hole, gender: GENDER_FEMALE, origin: [0, 0, 0], axis: AXIS_NEG_Y },
      { shape: hole, gender: GENDER_FEMALE, origin: [0, PLATE_LDU, 0], axis: AXIS_POS_Y },
    ]);
    const stack = model(
      [axle, beam],
      [
        [0, translation(0, 0, 0)],
        [1, translation(0, 0, 0)],
        [1, translation(0, PLATE_LDU, 0)],
        [1, translation(0, 2 * PLATE_LDU, 0)],
      ],
    );
    expect([stack.internalMates, stack.count]).toEqual([6, 0]);
    const lean = IDENTIFICATION_RESIDUAL_LDU / (1.25 * PLATE_LDU);
    const leaningSoOnlyTheLowerFacesIdentifyInTheModelFrame = assembled(
      [axle, beam],
      [{ parent: MODEL_ROOT, local: [1, -lean, 0, 0, lean, 1, 0, 0, 0, 0, 1, 0] }],
      [
        { part: 1, submodel: 0, local: IDENTITY },
        { part: 0, submodel: 0, local: IDENTITY },
        { part: 1, submodel: 0, local: translation(0, PLATE_LDU, 0) },
        { part: 1, submodel: 0, local: translation(0, 2 * PLATE_LDU, 0) },
      ],
      true,
    );
    expect(tally(leaningSoOnlyTheLowerFacesIdentifyInTheModelFrame)).toEqual([0, 6, 0]);
    const doubledStud = table([
      { shape: STUD, gender: GENDER_MALE, origin: [HALF, PLATE_LDU, HALF], axis: AXIS_POS_Y },
      { shape: STUD, gender: GENDER_MALE, origin: [HALF, PLATE_LDU, HALF], axis: AXIS_POS_Y },
    ]);
    const covered = model(
      [doubledStud, block(1, 1, PLATE_LDU, PLATE_RECEPTOR)],
      [
        [0, translation(0, 0, 0)],
        [1, translation(0, PLATE_LDU, 0)],
      ],
    );
    expect([covered.internalMates, covered.count]).toEqual([2, 1]);
  });

  it("identifies connector frames within 0.0005 LDU of the sixteenth-LDU grid and reports the rest", () => {
    const stud = table([
      { shape: STUD, gender: GENDER_MALE, origin: [HALF, 0, HALF], axis: AXIS_POS_Y },
    ]);
    const dust = 0.9999999;
    const residue = 1e-7;
    const tilt = 0.0006;
    const diagonal = Math.SQRT1_2;
    const placements: ReadonlyArray<readonly [number, ReadonlyArray<number>]> = [
      [0, translation(0.0003, 0, -0.0002)],
      [0, [dust, -residue, 0, 0, residue, dust, 0, 0, 0, 0, 1, 0]],
      [0, translation(0.0006, 0, 0)],
      [0, translation(0, 0.03, 0)],
      [0, [1, -tilt, 0, 0, tilt, 1, 0, -tilt * HALF, 0, 0, 1, 0]],
      [0, [diagonal, -diagonal, 0, 0, diagonal, diagonal, 0, 0, 0, 0, 1, 0]],
      [0, translation(Number.NaN, 0, 0)],
      [1, translation(0, 0, 0)],
    ];
    const connectors = model([stud, null], placements);
    expect([
      connectors.count,
      connectors.offLattice,
      connectors.instancesWithoutConnectors,
    ]).toEqual([2, 5, 1]);
    expect(Array.from(connectors.origin)).toEqual(
      [HALF, 0, HALF, HALF, 0, HALF].map((ldu) => ldu * SIXTEENTHS_PER_LDU),
    );
  });
});

const PIN = shape(CAP_ROOT, false, [[SECTION_ROUND, 6, 8]]);
const PIN_HOLE = shape(0, false, [[SECTION_ROUND, 6, 20]]);
const NEIGHBOUR_WIDTH_LDU = 32 * STUD_LDU;
const HOLE_HEIGHT = 14;
const EDGE_ROWS = [50, 130, 510, 590] as const;

function edgeHoles(): ConnectorTable {
  return table(
    EDGE_ROWS.map((z) => ({
      shape: PIN_HOLE,
      gender: GENDER_FEMALE,
      origin: [0, HOLE_HEIGHT, z],
      axis: AXIS_NEG_X,
    })),
  );
}

function edgePins(): ConnectorTable {
  return table(
    EDGE_ROWS.map((z) => ({
      shape: PIN,
      gender: GENDER_MALE,
      origin: [NEIGHBOUR_WIDTH_LDU, HOLE_HEIGHT, z],
      axis: AXIS_POS_X,
    })),
  );
}

function sparseOnly(): ConnectionSolver {
  return new ConnectionSolver([new SparseConnectorFinder(mating)]);
}

function proposedOnLattice(
  solver: ConnectionSolver,
  piece: ModelConnectors,
  snapWindow: SnapWindow,
): number[][] {
  const out = new CandidatePoses();
  solver.proposeMates(piece, snapWindow, out);
  return poseRows(out);
}

function poseRows(candidates: CandidatePoses): number[][] {
  const rows: number[][] = [];
  for (let k = 0; k < candidates.count; k++) {
    rows.push([
      candidates.x[k] ?? 0,
      candidates.z[k] ?? 0,
      candidates.yPlates[k] ?? 0,
      candidates.rot[k] ?? 0,
    ]);
  }
  return rows;
}

function upStuds(origins: ReadonlyArray<readonly [number, number, number]>): ModelConnectors {
  return single(
    table(
      origins.map((origin) => ({ shape: STUD, gender: GENDER_MALE, origin, axis: AXIS_POS_Y })),
    ),
  );
}

function downReceptors(origins: ReadonlyArray<readonly [number, number, number]>): ModelConnectors {
  return single(
    table(
      origins.map((origin) => ({
        shape: PLATE_RECEPTOR,
        gender: GENDER_FEMALE,
        origin,
        axis: AXIS_NEG_Y,
      })),
    ),
  );
}

function sideReceptor(): ModelConnectors {
  return single(
    table([
      { shape: PLATE_RECEPTOR, gender: GENDER_FEMALE, origin: [0, 0, HALF], axis: AXIS_NEG_X },
    ]),
  );
}

function holeFacingNegX(shapeId: number, y: number, z: number): Spec {
  return { shape: shapeId, gender: GENDER_FEMALE, origin: [0, y, z], axis: AXIS_NEG_X };
}

const QUARTER_STUD = STUD_LDU / 4;
const OFF_CENTRE_AND_QUARTER: ReadonlyArray<readonly [number, number, number]> = [
  [STUD_LDU, PLATE_LDU, HALF],
  [STUD_LDU + QUARTER_STUD, PLATE_LDU, HALF],
];

function twoPhaseReceptors(): ModelConnectors {
  return downReceptors([
    [HALF, 0, HALF],
    [STUD_LDU, 0, HALF],
  ]);
}

describe("ConnectionSolver with sparse connectors", () => {
  it("snaps a model to the pose where its edge pins enter a neighbour's holes, not a stud away", () => {
    const solver = allFamilies();
    solver.insert(single(edgeHoles()), pose(0, 0, 0), 21);
    const neighbour = single(edgePins());
    const candidates = new CandidatePoses();
    for (const gap of [-STUD_LDU, 0, STUD_LDU]) {
      solver.rank(
        neighbour,
        window(pose(-NEIGHBOUR_WIDTH_LDU + gap, STUD_LDU, 0), 1, 1),
        candidates,
      );
      expect([
        candidates.x[0],
        candidates.z[0],
        candidates.yPlates[0],
        candidates.votes[0],
      ]).toEqual([-NEIGHBOUR_WIDTH_LDU, 0, 0, EDGE_ROWS.length]);
    }
    expect(matesAt(solver, neighbour, pose(-NEIGHBOUR_WIDTH_LDU + STUD_LDU, 0, 0))).toBe(0);
    solver.rank(
      neighbour,
      window(pose(-NEIGHBOUR_WIDTH_LDU - 2 * STUD_LDU, 0, 0), 1, 1),
      candidates,
    );
    expect(candidates.votes[0]).toBe(0);
  });

  it("never mates or proposes sparse connectors that point the same way or sit off whole plates", () => {
    const solver = allFamilies();
    solver.insert(single(edgeHoles()), pose(0, 0, 0), 22);
    const sameWay = single(
      table(
        EDGE_ROWS.map((z) => ({
          shape: PIN,
          gender: GENDER_MALE,
          origin: [0, HOLE_HEIGHT, z],
          axis: AXIS_NEG_X,
        })),
      ),
    );
    expect(matesAt(solver, sameWay, pose(0, 0, 0))).toBe(0);
    const halfPlateLow = single(
      table(
        EDGE_ROWS.map((z) => ({
          shape: PIN,
          gender: GENDER_MALE,
          origin: [NEIGHBOUR_WIDTH_LDU, HOLE_HEIGHT - PLATE_LDU / 2, z],
          axis: AXIS_POS_X,
        })),
      ),
    );
    const candidates = new CandidatePoses();
    solver.rank(halfPlateLow, window(pose(-NEIGHBOUR_WIDTH_LDU, 0, 0), 1, 1), candidates);
    expect(candidates.votes[0]).toBe(0);
  });

  it("finds the turn that faces the pins into the holes", () => {
    const solver = allFamilies();
    solver.insert(single(edgeHoles()), pose(0, 0, 0), 23);
    const turnedAway = single(
      table(
        EDGE_ROWS.map((z) => ({
          shape: PIN,
          gender: GENDER_MALE,
          origin: [0, HOLE_HEIGHT, -z],
          axis: AXIS_NEG_X,
        })),
      ),
    );
    const candidates = new CandidatePoses();
    solver.rank(turnedAway, window(pose(0, 0, 0, 0), 1, 0, 4), candidates);
    expect([candidates.x[0], candidates.z[0], candidates.rot[0], candidates.votes[0]]).toEqual([
      0,
      0,
      2,
      EDGE_ROWS.length,
    ]);
  });

  it("mates a stud off the stud centres, such as a jumper's, and proposes the half-stud pose", () => {
    const solver = allFamilies();
    solver.insert(single(baseplate(4, 4)), pose(0, 0, 0), 24);
    const jumper = single(
      table([
        { shape: PLATE_RECEPTOR, gender: GENDER_FEMALE, origin: [HALF, 0, HALF], axis: AXIS_NEG_Y },
        {
          shape: PLATE_RECEPTOR,
          gender: GENDER_FEMALE,
          origin: [HALF + STUD_LDU, 0, HALF],
          axis: AXIS_NEG_Y,
        },
        { shape: STUD, gender: GENDER_MALE, origin: [STUD_LDU, PLATE_LDU, HALF], axis: AXIS_POS_Y },
      ]),
    );
    solver.insert(jumper, pose(STUD_LDU, STUD_LDU, 0), 25);
    const tile = single(
      table([
        { shape: PLATE_RECEPTOR, gender: GENDER_FEMALE, origin: [HALF, 0, HALF], axis: AXIS_NEG_Y },
      ]),
    );
    const candidates = new CandidatePoses();
    solver.rank(tile, window(pose(STUD_LDU, STUD_LDU, 1), 1, 0), candidates);
    expect([candidates.x[0], candidates.z[0], candidates.yPlates[0], candidates.votes[0]]).toEqual([
      STUD_LDU + HALF,
      STUD_LDU,
      1,
      1,
    ]);
    const report = evaluated(solver, tile, pose(STUD_LDU + HALF, STUD_LDU, 1));
    expect([report.count, report.family[0]]).toEqual([1, 1]);
  });

  it("counts every connector in exactly one family", () => {
    const solver = allFamilies();
    solver.insert(single(baseplate(4, 4)), pose(0, 0, 0), 26);
    solver.insert(single(edgeHoles()), pose(0, 0, 0), 27);
    const plate = single(block(2, 2, PLATE_LDU, PLATE_RECEPTOR));
    const report = evaluated(solver, plate, pose(0, 0, 0));
    expect([report.count, ...report.family.subarray(0, report.count)]).toEqual([4, 0, 0, 0, 0]);
    const pins = single(edgePins());
    const joined = evaluated(solver, pins, pose(-NEIGHBOUR_WIDTH_LDU, 0, 0));
    expect([joined.count, ...joined.family.subarray(0, joined.count)]).toEqual([4, 1, 1, 1, 1]);
  });

  it("keeps a sparse connector placed twice until both placements are removed", () => {
    const solver = allFamilies();
    const holes = single(edgeHoles());
    const pins = single(edgePins());
    solver.insert(holes, pose(0, 0, 0), 1);
    solver.insert(holes, pose(0, 0, 0), 2);
    solver.remove(holes, pose(0, 0, 0), 1);
    expect(matesAt(solver, pins, pose(-NEIGHBOUR_WIDTH_LDU, 0, 0))).toBe(EDGE_ROWS.length);
    expect(() => solver.remove(holes, pose(0, 0, 0), 1)).toThrow(RangeError);
    solver.remove(holes, pose(0, 0, 0), 2);
    expect(matesAt(solver, pins, pose(-NEIGHBOUR_WIDTH_LDU, 0, 0))).toBe(0);
  });

  it("proposes the half-stud pose of a stud off the stud centres, as on a jumper, only at windows that line a receptor up with it, on any turn", () => {
    const offCentre = sparseOnly();
    offCentre.insert(upStuds([[STUD_LDU, PLATE_LDU, HALF]]), pose(0, 0, 0), 1);
    const receptor = downReceptors([[HALF, 0, 0]]);
    expect([
      proposedOnLattice(offCentre, receptor, window(pose(0, 0, 1), 1, 0, 2)),
      proposedOnLattice(offCentre, receptor, window(pose(HALF, HALF, 1), 1, 0, 2)),
      proposedOnLattice(offCentre, receptor, window(pose(HALF, 0, 1), 1, 0, 2)),
      proposedOnLattice(offCentre, receptor, window(pose(0, 0, 1), 1, 0, 4)),
    ]).toEqual([
      [[STUD_LDU, STUD_LDU, 1, 1]],
      [[HALF, HALF, 1, 0]],
      [],
      [
        [STUD_LDU, STUD_LDU, 1, 1],
        [STUD_LDU, 0, 1, 3],
      ],
    ]);
  });

  it("proposes a pin into a hole one plate above it, and not into a hole half a plate above it", () => {
    const holes = sparseOnly();
    holes.insert(
      single(
        table([
          holeFacingNegX(PIN_HOLE, HOLE_HEIGHT + PLATE_LDU, HALF),
          holeFacingNegX(PIN_HOLE, HOLE_HEIGHT + PLATE_LDU / 2, HALF + STUD_LDU),
        ]),
      ),
      pose(0, 0, 0),
      2,
    );
    const pinAndHole = single(
      table([
        onAxis(AXIS_POS_X, 0, HALF, PIN, GENDER_MALE),
        onAxis(AXIS_NEG_X, 0, HALF + STUD_LDU, PIN_HOLE, GENDER_FEMALE),
      ]),
    );
    expect([
      proposedOnLattice(holes, pinAndHole, window(pose(0, 0, 0), 1, 1)),
      proposedOnLattice(holes, pinAndHole, window(pose(0, 0, 3), 1, 2)),
    ]).toEqual([[[0, 0, 1, 0]], [[0, 0, 1, 0]]]);
  });

  it("proposes a bar slid partway through a short open hole, at a window half a stud along the bar", () => {
    const sleeve = sparseOnly();
    sleeve.insert(
      single(
        table([
          holeFacingNegX(
            shape(0, false, [[SECTION_ROUND, 6, PLATE_LDU]]),
            HOLE_HEIGHT + PLATE_LDU,
            HALF,
          ),
        ]),
      ),
      pose(0, 0, 0),
      5,
    );
    const bar = single(
      table([
        onAxis(
          AXIS_POS_X,
          0,
          HALF,
          shape(CAP_ROOT, true, [[SECTION_ROUND, 6, STUD_LDU]]),
          GENDER_MALE,
        ),
      ]),
    );
    expect(proposedOnLattice(sleeve, bar, window(pose(HALF, 0, 0), 1, 1))).toEqual([
      [-HALF, 0, 1, 0],
    ]);
  });

  it("proposes each of a pair of receptors on two stud phases at the window that lines it up, at negative coordinates too", () => {
    const receptors = twoPhaseReceptors();
    const twoPhases = sparseOnly();
    twoPhases.insert(upStuds(OFF_CENTRE_AND_QUARTER), pose(0, 0, 0), 3);
    const farSide = sparseOnly();
    farSide.insert(upStuds(OFF_CENTRE_AND_QUARTER), pose(-4 * STUD_LDU, -4 * STUD_LDU, 0), 4);
    expect([
      proposedOnLattice(twoPhases, receptors, window(pose(HALF, 0, 1), 1, 0)),
      proposedOnLattice(twoPhases, receptors, window(pose(0, 0, 1), 1, 0)),
      proposedOnLattice(
        farSide,
        receptors,
        window(pose(-2 * STUD_LDU - HALF, -3 * STUD_LDU, 1), 1, 0),
      ),
    ]).toEqual([[[HALF, 0, 1, 0]], [[0, 0, 1, 0]], [[-3 * STUD_LDU - HALF, -4 * STUD_LDU, 1, 0]]]);
  });

  it("rejects a candidate whose off-axis shift fails the window bound, and accepts one exactly on it", () => {
    const tops = sparseOnly();
    tops.insert(
      upStuds([
        [HALF + STUD_LDU, PLATE_LDU, 0],
        [HALF + 2 * STUD_LDU, PLATE_LDU, 0],
      ]),
      pose(0, 0, 0),
      1,
    );
    const sides = sparseOnly();
    sides.insert(
      single(
        table([
          { shape: STUD, gender: GENDER_MALE, origin: [0, 2 * PLATE_LDU, HALF], axis: AXIS_POS_X },
          {
            shape: STUD,
            gender: GENDER_MALE,
            origin: [0, 3 * PLATE_LDU, HALF + STUD_LDU],
            axis: AXIS_POS_X,
          },
        ]),
      ),
      pose(0, 0, 0),
      2,
    );
    const fronts = sparseOnly();
    fronts.insert(
      upStuds([
        [HALF, PLATE_LDU, STUD_LDU],
        [HALF, PLATE_LDU, 2 * STUD_LDU],
      ]),
      pose(0, 0, 0),
      3,
    );
    expect([
      proposedOnLattice(tops, downReceptors([[HALF, 0, 0]]), window(pose(0, 0, 1), 1, 0)),
      proposedOnLattice(fronts, downReceptors([[HALF, 0, 0]]), window(pose(0, 0, 1), 1, 0)),
      proposedOnLattice(sides, sideReceptor(), window(pose(0, 0, 0), 1, 2)),
    ]).toEqual([[[STUD_LDU, 0, 1, 0]], [[0, STUD_LDU, 1, 0]], [[0, 0, 2, 0]]]);
  });

  it("pauses after every slot it visits when given one slot at a time, whether or not the slot shares a held off-axis phase, and proposes the pose that lines a receptor up with a stud", () => {
    const solver = sparseOnly();
    solver.insert(upStuds(OFF_CENTRE_AND_QUARTER), pose(0, 0, 0), 1);
    const receptors = twoPhaseReceptors();
    const turns = 2;
    const snapWindow = window(pose(HALF, 0, 1), 1, 0, turns);
    const out = new CandidatePoses();
    const progress = new ProposalProgress();
    let paused = 0;
    while (!solver.proposeMatesFrom(receptors, snapWindow, out, progress, 1)) paused++;
    expect({ paused, poses: poseRows(out) }).toEqual({
      paused: OFF_CENTRE_AND_QUARTER.length * turns - 1,
      poses: [
        [HALF, 0, 1, 0],
        [HALF, STUD_LDU, 1, 1],
      ],
    });
  });

  it("rejects an x shift that is plate-aligned but not stud-aligned", () => {
    const tops = sparseOnly();
    tops.insert(upStuds([[HALF + PLATE_LDU, PLATE_LDU, 0]]), pose(0, 0, 0), 1);
    expect(
      proposedOnLattice(tops, downReceptors([[HALF, 0, 0]]), window(pose(0, 0, 1), 1, 0)),
    ).toEqual([]);
  });
});

type Matrix = ReadonlyArray<number>;

interface Submodel {
  readonly parent: number;
  readonly local: Matrix;
}

interface Placed {
  readonly part: number;
  readonly submodel: number;
  readonly local: Matrix;
}

const IDENTITY = translation(0, 0, 0);
const DUST = 0.02;
const COS_45_TO_3_DECIMALS = Math.round(Math.SQRT1_2 * 1000) / 1000;

function then(outer: Matrix, inner: Matrix): number[] {
  const out: number[] = [];
  for (let r = 0; r < 3; r++) {
    for (let k = 0; k < 4; k++) {
      let sum = k === 3 ? (outer[r * 4 + 3] ?? 0) : 0;
      for (let j = 0; j < 3; j++) sum += (outer[r * 4 + j] ?? 0) * (inner[j * 4 + k] ?? 0);
      out.push(sum);
    }
  }
  return out;
}

function quarterTurn(rot: QuarterTurn, x: number, y: number, z: number): number[] {
  const c = rot90Cos(rot);
  const s = rot90Sin(rot);
  return [c, 0, s, x, 0, 1, 0, y, -s, 0, c, z];
}

function inverseRigid(m: Matrix): number[] {
  const rotation = [0, 1, 2].map((r) => [0, 1, 2].map((k) => m[k * 4 + r] ?? 0));
  const out: number[] = [];
  for (const row of rotation) {
    const shift = -row.reduce((sum, value, k) => sum + value * (m[k * 4 + 3] ?? 0), 0);
    out.push(...row, shift);
  }
  return out;
}

function tiltAboutX(radians: number): number[] {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0];
}

function assembled(
  parts: ReadonlyArray<ConnectorTable>,
  submodels: ReadonlyArray<Submodel>,
  placed: ReadonlyArray<Placed>,
  withTree: boolean,
): ModelConnectors {
  const world: number[][] = [];
  for (const s of submodels) world.push(then(world[s.parent] ?? IDENTITY, s.local));
  const instances = {
    count: placed.length,
    partIndex: placed.map((p) => p.part),
    matrices: Float64Array.from(
      placed.flatMap((p) => then(world[p.submodel] ?? IDENTITY, p.local)),
    ),
  };
  if (!withTree) return ModelConnectors.fromParts(parts, instances, mating);
  return ModelConnectors.fromParts(
    parts,
    {
      ...instances,
      submodels: {
        count: submodels.length,
        parent: Int32Array.from(submodels, (s) => s.parent),
        matrices: Float64Array.from(world.flat()),
        ofPart: Int32Array.from(placed, (p) => p.submodel),
      },
    },
    mating,
  );
}

function tally(connectors: ModelConnectors): number[] {
  return [connectors.count, connectors.internalMates, connectors.offLattice];
}

function oneSubmodel(local: Matrix): Submodel[] {
  return [{ parent: MODEL_ROOT, local }];
}

function twoSiblings(dust: number): Submodel[] {
  return [
    { parent: MODEL_ROOT, local: translation(dust, 0, 0) },
    { parent: MODEL_ROOT, local: translation(dust - STUD_LDU, 0, 0) },
  ];
}

function pinAndHoleShifted(dust: number): Placed[] {
  return [
    { part: 0, submodel: 1, local: translation(dust, 0, 0) },
    { part: 1, submodel: 1, local: translation(dust, 0, 0) },
  ];
}

describe("ModelConnectors in a sub-model tree", () => {
  const pin = table([
    { shape: PIN, gender: GENDER_MALE, origin: [0, HOLE_HEIGHT, 0], axis: AXIS_POS_X },
  ]);
  const hole = table([
    { shape: PIN_HOLE, gender: GENDER_FEMALE, origin: [0, HOLE_HEIGHT, 0], axis: AXIS_NEG_X },
  ]);

  it("mates a sub-model's own pin and hole in its frame, in double precision, when it's placed with dust, far away or turned with 3-decimal entries, and keeps its exposed hole absolute and off-lattice", () => {
    const holes = table([
      { shape: PIN_HOLE, gender: GENDER_FEMALE, origin: [0, HOLE_HEIGHT, 0], axis: AXIS_NEG_X },
      {
        shape: PIN_HOLE,
        gender: GENDER_FEMALE,
        origin: [0, HOLE_HEIGHT, STUD_LDU],
        axis: AXIS_NEG_X,
      },
    ]);
    const inside = translation(2 * STUD_LDU, 0, STUD_LDU);
    const contents: Placed[] = [
      { part: 0, submodel: 0, local: inside },
      { part: 1, submodel: 0, local: inside },
    ];
    const [x, y, z] = [5 * STUD_LDU, PLATE_LDU, 2 * STUD_LDU];
    const c = COS_45_TO_3_DECIMALS;
    const farDusty = FAR_LDU + DUST + IDENTIFICATION_RESIDUAL_LDU;
    expect(Math.abs(Math.fround(farDusty) - farDusty)).toBeGreaterThan(IDENTIFICATION_RESIDUAL_LDU);
    for (const placement of [
      translation(x + DUST, y, z),
      [c, 0, c, x, 0, 1, 0, y, -c, 0, c, z],
      translation(farDusty, y, z),
    ]) {
      expect(tally(assembled([pin, holes], oneSubmodel(placement), contents, false))).toEqual([
        0, 0, 3,
      ]);
      expect(tally(assembled([pin, holes], oneSubmodel(placement), contents, true))).toEqual([
        0, 1, 1,
      ]);
    }
    const exact = assembled([pin, holes], oneSubmodel(translation(x, y, z)), contents, true);
    expect(tally(exact)).toEqual([1, 1, 0]);
    expect(Array.from(exact.origin)).toEqual(
      [x + 2 * STUD_LDU, y + HOLE_HEIGHT, z + 2 * STUD_LDU].map((ldu) => ldu * SIXTEENTHS_PER_LDU),
    );
  });

  it("refuses dust between faces far inside a sub-model, which single precision would round away", () => {
    const deep = (holeDust: number): Placed[] => [
      { part: 0, submodel: 0, local: translation(FAR_LDU, 0, 0) },
      { part: 1, submodel: 0, local: translation(FAR_LDU + holeDust, 0, 0) },
    ];
    expect(Math.fround(FAR_LDU + DUST_BEYOND_RESIDUAL_LDU)).toBe(FAR_LDU);
    const dusty = oneSubmodel(translation(DUST, 0, 0));
    expect(tally(assembled([pin, hole], dusty, deep(0), true))).toEqual([0, 1, 0]);
    expect(tally(assembled([pin, hole], dusty, deep(DUST_BEYOND_RESIDUAL_LDU), true))).toEqual([
      0, 0, 2,
    ]);
  });

  it("judges a pair only absolutely or in its lowest common sub-model instance, never in a sibling's or an ancestor's frame", () => {
    const pinAndHole = table([
      { shape: PIN, gender: GENDER_MALE, origin: [0, HOLE_HEIGHT, 0], axis: AXIS_POS_X },
      {
        shape: PIN_HOLE,
        gender: GENDER_FEMALE,
        origin: [STUD_LDU, HOLE_HEIGHT, 0],
        axis: AXIS_NEG_X,
      },
    ]);
    const twoInstances: Placed[] = [
      { part: 0, submodel: 0, local: IDENTITY },
      { part: 0, submodel: 1, local: IDENTITY },
    ];
    expect(tally(assembled([pinAndHole], twoSiblings(0), twoInstances, true))).toEqual([2, 1, 0]);
    expect(tally(assembled([pinAndHole], twoSiblings(DUST), twoInstances, true))).toEqual([
      0, 0, 4,
    ]);
    const compensated: Submodel[] = [
      { parent: MODEL_ROOT, local: translation(1.5 * DUST, 0, 0) },
      { parent: 0, local: translation(-DUST, 0, 0) },
    ];
    expect(tally(assembled([pin, hole], compensated, pinAndHoleShifted(0), true))).toEqual([
      0, 1, 0,
    ]);
    expect(tally(assembled([pin, hole], compensated, pinAndHoleShifted(DUST), true))).toEqual([
      0, 0, 2,
    ]);
  });

  it("changes nothing for an exactly placed tree, and keeps every internal mate when the whole tree is tilted and placed with dust", () => {
    const plate = block(1, 1, PLATE_LDU, PLATE_RECEPTOR);
    const side = 4;
    const submodelCount = 5;
    const plates = 24;
    const outerMove = then(translation(0.013, -0.007, DUST), tiltAboutX(0.3));
    let seed = 20261118;
    const next = (span: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % span;
    };
    let mates = 0;
    for (let trial = 0; trial < 12; trial++) {
      const exactTree: Submodel[] = [{ parent: MODEL_ROOT, local: IDENTITY }];
      for (let s = 1; s < submodelCount; s++) {
        exactTree.push({
          parent: next(s),
          local: quarterTurn(
            next(4) as QuarterTurn,
            (next(5) - 2) * STUD_LDU,
            (next(3) - 1) * PLATE_LDU,
            (next(5) - 2) * STUD_LDU,
          ),
        });
      }
      const world: number[][] = [];
      for (const s of exactTree) world.push(then(world[s.parent] ?? IDENTITY, s.local));
      const cells = Array.from({ length: side ** 3 }, (_, k) => k);
      for (let k = cells.length - 1; k > 0; k--) {
        const j = next(k + 1);
        [cells[k], cells[j]] = [cells[j] ?? 0, cells[k] ?? 0];
      }
      const placed: Placed[] = cells.slice(0, plates).map((cell) => {
        const submodel = next(submodelCount);
        const at = translation(
          (cell % side) * STUD_LDU,
          (Math.floor(cell / side) % side) * PLATE_LDU,
          Math.floor(cell / side ** 2) * STUD_LDU,
        );
        return { part: 0, submodel, local: then(inverseRigid(world[submodel] ?? IDENTITY), at) };
      });
      const flat = assembled([plate], exactTree, placed, false);
      const nested = assembled([plate], exactTree, placed, true);
      expect(tally(nested)).toEqual(tally(flat));
      expect([
        Array.from(nested.origin),
        Array.from(nested.axis),
        Array.from(nested.instance),
      ]).toEqual([Array.from(flat.origin), Array.from(flat.axis), Array.from(flat.instance)]);
      const moved = exactTree.map((s, k) => (k === 0 ? { ...s, local: outerMove } : s));
      expect(tally(assembled([plate], moved, placed, false))).toEqual([0, 0, 2 * plates]);
      expect(tally(assembled([plate], moved, placed, true))).toEqual([
        0,
        flat.internalMates,
        flat.count,
      ]);
      mates += flat.internalMates;
    }
    expect(mates).toBeGreaterThan(0);
  });

  it("refuses a tree whose parents aren't earlier instances or whose parts name no instance", () => {
    const plate = block(1, 1, PLATE_LDU, PLATE_RECEPTOR);
    const one = { count: 1, partIndex: [0], matrices: Float64Array.from(IDENTITY) };
    const tree = (parent: ReadonlyArray<number>, ofPart: ReadonlyArray<number>) => ({
      ...one,
      submodels: {
        count: parent.length,
        parent,
        matrices: Float64Array.from(parent.flatMap(() => IDENTITY)),
        ofPart,
      },
    });
    expect(() => ModelConnectors.fromParts([plate], tree([MODEL_ROOT, 1], [1]), mating)).toThrow(
      RangeError,
    );
    expect(() => ModelConnectors.fromParts([plate], tree([MODEL_ROOT], [1]), mating)).toThrow(
      RangeError,
    );
    expect(tally(ModelConnectors.fromParts([plate], tree([MODEL_ROOT, 0], [1]), mating))).toEqual([
      2, 0, 0,
    ]);
  });
});

function hipsAndLegs(hip: number, legs: number): ConnectorTable {
  return table([
    {
      shape: PIN,
      gender: GENDER_MALE,
      origin: [0, HOLE_HEIGHT, 0],
      axis: AXIS_POS_X,
      piece: hip,
    },
    {
      shape: PIN_HOLE,
      gender: GENDER_FEMALE,
      origin: [0, HOLE_HEIGHT, 0],
      axis: AXIS_NEG_X,
      piece: legs,
    },
    {
      shape: PIN_HOLE,
      gender: GENDER_FEMALE,
      origin: [0, HOLE_HEIGHT, STUD_LDU],
      axis: AXIS_NEG_X,
      piece: legs,
    },
    { shape: PIN, gender: GENDER_MALE, origin: [0, 0, 0], axis: AXIS_FREE, piece: hip },
  ]);
}

function alone(part: ConnectorTable, local: Matrix): ModelConnectors {
  return assembled([part], [], [{ part: 0, submodel: MODEL_ROOT, local }], false);
}

describe("ModelConnectors with composite parts", () => {
  const [x, y, z] = [5 * STUD_LDU, PLATE_LDU, 2 * STUD_LDU];
  const c = COS_45_TO_3_DECIMALS;
  const exact = translation(x, y, z);
  const dusty = translation(x + DUST, y, z);
  const turned = [c, 0, c, x, 0, 1, 0, y, -c, 0, c, z];
  const inDustySubmodel = (part: ConnectorTable): ModelConnectors =>
    assembled([part], oneSubmodel(dusty), [{ part: 0, submodel: 0, local: IDENTITY }], true);

  it("mates a composite part's pieces in part-local coordinates wherever it's placed, and counts each mate once", () => {
    const composite = hipsAndLegs(1, 2);
    expect(tally(alone(composite, exact))).toEqual([1, 1, 1]);
    expect(tally(alone(composite, dusty))).toEqual([0, 1, 2]);
    expect(tally(alone(composite, turned))).toEqual([0, 1, 2]);
    expect(tally(inDustySubmodel(composite))).toEqual([0, 1, 2]);
  });

  it("never mates two connectors of one piece, in any pass, even inside a composite", () => {
    for (const piece of [0, 3]) {
      const moulding = hipsAndLegs(piece, piece);
      expect(tally(alone(moulding, exact))).toEqual([3, 0, 1]);
      expect(tally(alone(moulding, dusty))).toEqual([0, 0, 4]);
      expect(tally(inDustySubmodel(moulding))).toEqual([0, 0, 4]);
    }
    const composite = hipsAndLegs(1, 2);
    const legPin = {
      shape: PIN,
      gender: GENDER_MALE,
      origin: [0, HOLE_HEIGHT, STUD_LDU] as const,
      axis: AXIS_POS_X,
      piece: 2,
    };
    const withLegPin = new ConnectorTable(
      Uint16Array.of(...composite.shape, legPin.shape),
      Uint8Array.of(...composite.gender, legPin.gender),
      Uint8Array.of(...composite.source, SOURCE_SHADOW),
      Uint8Array.of(...composite.status, STATUS_VERIFIED),
      Int32Array.of(...composite.origin, ...legPin.origin.map(toSixteenths)),
      Int8Array.of(...composite.axis, legPin.axis),
      new Float64Array((composite.count + 1) * 3),
      Uint16Array.of(...composite.piece, legPin.piece),
      Float64Array.of(...composite.originFree, 0, 0, 0),
      [],
    );
    expect(tally(alone(withLegPin, exact))).toEqual([2, 1, 1]);
    expect(tally(alone(withLegPin, dusty))).toEqual([0, 1, 3]);
    expect(tally(inDustySubmodel(withLegPin))).toEqual([0, 1, 3]);
  });

  it("refuses a piece column that doesn't match the connector count", () => {
    const part = hipsAndLegs(1, 2);
    const withPieces = (piece: Uint16Array) =>
      new ConnectorTable(
        part.shape,
        part.gender,
        part.source,
        part.status,
        part.origin,
        part.axis,
        part.axisFree,
        piece,
        part.originFree,
        part.unreadable,
      );
    expect(withPieces(new Uint16Array(part.count)).count).toBe(part.count);
    expect(() => withPieces(new Uint16Array(part.count - 1))).toThrow(RangeError);
    expect(() => withPieces(new Uint16Array(part.count + 1))).toThrow(RangeError);
  });
});

const QUARTER_TURN_ABOUT_X = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0];
const AXLE_LENGTH = 3 * PLATE_LDU;
const THROUGH_SHAFT = shape(0, true, [[SECTION_AXLE, 6, AXLE_LENGTH]]);
const THROUGH_HOLE = shape(0, false, [[SECTION_AXLE, 6, PLATE_LDU]]);
const SIXTEENTHS_PER_PLATE = PLATE_LDU * SIXTEENTHS_PER_LDU;

function twoEndedAxle(): ConnectorTable {
  return table([
    { shape: THROUGH_SHAFT, gender: GENDER_MALE, origin: [0, 0, 0], axis: AXIS_POS_Y },
    { shape: THROUGH_SHAFT, gender: GENDER_MALE, origin: [0, AXLE_LENGTH, 0], axis: AXIS_NEG_Y },
  ]);
}

function twoHoleBeam(): ConnectorTable {
  return table([
    { shape: THROUGH_HOLE, gender: GENDER_FEMALE, origin: [0, 0, 0], axis: AXIS_NEG_Y },
    { shape: THROUGH_HOLE, gender: GENDER_FEMALE, origin: [0, PLATE_LDU, 0], axis: AXIS_POS_Y },
  ]);
}

function axleThroughBeams(placement: Matrix, withLean: boolean): ModelConnectors {
  const lean = withLean ? IDENTIFICATION_RESIDUAL_LDU / (1.25 * PLATE_LDU) : 0;
  return assembled(
    [twoEndedAxle(), twoHoleBeam()],
    [{ parent: MODEL_ROOT, local: then(placement, [1, -lean, 0, 0, lean, 1, 0, 0, 0, 0, 1, 0]) }],
    [
      { part: 1, submodel: 0, local: IDENTITY },
      { part: 0, submodel: 0, local: IDENTITY },
      { part: 1, submodel: 0, local: translation(0, PLATE_LDU, 0) },
      { part: 1, submodel: 0, local: translation(0, 2 * PLATE_LDU, 0) },
    ],
    true,
  );
}

function records(connectors: ModelConnectors): number[][] {
  const m = connectors.mates;
  return Array.from({ length: m.count }, (_, k) => [
    m.maleInstance[k] ?? -1,
    m.maleConnector[k] ?? -1,
    m.femaleInstance[k] ?? -1,
    m.femaleConnector[k] ?? -1,
    m.pass[k] ?? -1,
    m.mateAxis[k] ?? -1,
    m.mateOffset[k] ?? -1,
  ]);
}

function expectEveryConnectorAccountedFor(
  connectors: ModelConnectors,
  perInstance: ReadonlyArray<number>,
) {
  const accounted = new Set<string>();
  const m = connectors.mates;
  for (let k = 0; k < m.count; k++) {
    accounted.add(`${m.maleInstance[k]}:${m.maleConnector[k]}`);
    accounted.add(`${m.femaleInstance[k]}:${m.femaleConnector[k]}`);
  }
  const exposed = new Set<string>();
  for (let n = 0; n < connectors.count; n++) {
    const key = `${connectors.instance[n]}:${connectors.connector[n]}`;
    exposed.add(key);
    accounted.add(key);
  }
  const total = perInstance.reduce((sum, count) => sum + count, 0);
  expect(exposed.size).toBe(connectors.count);
  expect(accounted.size + connectors.offLattice).toBe(total);
}

function axleInBeamComposite(): ConnectorTable {
  return table([
    { shape: THROUGH_SHAFT, gender: GENDER_MALE, origin: [0, 0, 0], axis: AXIS_POS_Y, piece: 1 },
    {
      shape: THROUGH_HOLE,
      gender: GENDER_FEMALE,
      origin: [0, PLATE_LDU, 0],
      axis: AXIS_NEG_Y,
      piece: 2,
    },
    {
      shape: THROUGH_HOLE,
      gender: GENDER_FEMALE,
      origin: [0, 2 * PLATE_LDU, 0],
      axis: AXIS_POS_Y,
      piece: 2,
    },
  ]);
}

function matePairColumns(count: number, pass: Uint8Array, offsets = count): MatePairs {
  return new MatePairs(
    new Uint32Array(count),
    new Uint32Array(count),
    new Uint32Array(count),
    new Uint32Array(count),
    pass,
    new Int8Array(count),
    new Int32Array(offsets),
  );
}

describe("ModelConnectors mate pairs", () => {
  const p = SIXTEENTHS_PER_PLATE;
  const inModel = MATE_PASS_MODEL;
  const inSubmodel = MATE_PASS_SUBMODEL;
  const exactRecords = [
    [1, 0, 0, 0, inModel, AXIS_POS_Y, 0],
    [1, 0, 2, 0, inModel, AXIS_POS_Y, p],
    [1, 0, 3, 0, inModel, AXIS_POS_Y, 2 * p],
    [1, 1, 0, 1, inModel, AXIS_NEG_Y, 2 * p],
    [1, 1, 2, 1, inModel, AXIS_NEG_Y, p],
    [1, 1, 3, 1, inModel, AXIS_NEG_Y, 0],
  ];

  it("records every mate once, by male then female connector, with the male's part-local axis and its engaged offset", () => {
    for (const placement of [IDENTITY, then(QUARTER_TURN_ABOUT_X, translation(STUD_LDU, 0, 0))]) {
      const stack = axleThroughBeams(placement, false);
      expect(records(stack)).toEqual(exactRecords);
      expect(stack.internalMates).toBe(exactRecords.length);
      expectEveryConnectorAccountedFor(stack, [2, 2, 2, 2]);
    }
  });

  it("records the offset with its sign, for a hole behind the male's end", () => {
    const behind = 4;
    const overhanging = model(
      [twoEndedAxle(), twoHoleBeam()],
      [
        [0, IDENTITY],
        [1, translation(0, -behind, 0)],
      ],
    );
    expect(records(overhanging)).toEqual([
      [0, 0, 1, 0, inModel, AXIS_POS_Y, -behind * SIXTEENTHS_PER_LDU],
      [0, 1, 1, 1, inModel, AXIS_NEG_Y, (AXLE_LENGTH - PLATE_LDU + behind) * SIXTEENTHS_PER_LDU],
    ]);
    expectEveryConnectorAccountedFor(overhanging, [2, 2]);
  });

  it("records a pair in the model pass when both connectors identify there, and otherwise in its lowest common sub-model frame", () => {
    const leaning = axleThroughBeams(IDENTITY, true);
    expect(records(leaning)).toEqual(
      exactRecords.map((r, k) => {
        const judgedInModelFrame = k < 2;
        return [...r.slice(0, 4), judgedInModelFrame ? inModel : inSubmodel, ...r.slice(5)];
      }),
    );
    expectEveryConnectorAccountedFor(leaning, [2, 2, 2, 2]);
  });

  it("orders records by connector, not by the pass that found them", () => {
    const pin = table([
      { shape: PIN, gender: GENDER_MALE, origin: [0, HOLE_HEIGHT, 0], axis: AXIS_POS_X },
    ]);
    const hole = table([
      { shape: PIN_HOLE, gender: GENDER_FEMALE, origin: [0, HOLE_HEIGHT, 0], axis: AXIS_NEG_X },
    ]);
    const far = translation(10 * STUD_LDU, 0, 0);
    const pairs = assembled(
      [pin, hole],
      oneSubmodel(translation(DUST, 0, 0)),
      [
        { part: 0, submodel: 0, local: IDENTITY },
        { part: 1, submodel: 0, local: IDENTITY },
        { part: 0, submodel: MODEL_ROOT, local: far },
        { part: 1, submodel: MODEL_ROOT, local: far },
      ],
      true,
    );
    expect(records(pairs)).toEqual([
      [0, 0, 1, 0, inSubmodel, AXIS_POS_X, 0],
      [2, 0, 3, 0, inModel, AXIS_POS_X, 0],
    ]);
    expectEveryConnectorAccountedFor(pairs, [1, 1, 1, 1]);
  });

  it("records a composite part's cross-piece mate in the part pass, in part-local terms, and maps exposed connectors to their part", () => {
    const composite = axleInBeamComposite();
    const turnedWithDust = then(QUARTER_TURN_ABOUT_X, translation(DUST, 0, 0));
    const dusty = alone(composite, turnedWithDust);
    expect(records(dusty)).toEqual([[0, 0, 0, 1, MATE_PASS_PART, AXIS_POS_Y, p]]);
    expectEveryConnectorAccountedFor(dusty, [3]);
    const exact = alone(composite, translation(STUD_LDU, 0, 0));
    expect(records(exact)).toEqual([[0, 0, 0, 1, inModel, AXIS_POS_Y, p]]);
    expect([exact.count, Array.from(exact.instance), Array.from(exact.connector)]).toEqual([
      2,
      [0, 0],
      [0, 2],
    ]);
    expectEveryConnectorAccountedFor(exact, [3]);
  });

  it("keeps every record of a model with more mates than its first buffer holds", () => {
    const side = 10;
    const studs = side * side;
    const stacked = model(
      [block(side, side, PLATE_LDU, PLATE_RECEPTOR)],
      [
        [0, translation(0, PLATE_LDU, 0)],
        [0, IDENTITY],
      ],
    );
    expect(records(stacked)).toEqual(
      Array.from({ length: studs }, (_, c) => [1, c, 0, studs + c, inModel, AXIS_POS_Y, 0]),
    );
    expectEveryConnectorAccountedFor(stacked, [2 * studs, 2 * studs]);
  });

  it("refuses columns that disagree on the count or name an unknown pass", () => {
    expect(matePairColumns(1, Uint8Array.of(MATE_PASS_PART)).passOf(0)).toBe(MATE_PASS_PART);
    const bothModel = Uint8Array.of(MATE_PASS_MODEL, MATE_PASS_MODEL);
    expect(matePairColumns(2, bothModel).count).toBe(2);
    expect(() => matePairColumns(2, bothModel, 1)).toThrow(RangeError);
    expect(() => matePairColumns(1, Uint8Array.of(MATE_PASS_PART + 1))).toThrow(RangeError);
    expect(() => matePairColumns(1, Uint8Array.of(MATE_PASS_MODEL)).passOf(1)).toThrow(RangeError);
  });
});

function trackModel(ends: ReadonlyArray<TrackEnd>): ModelConnectors {
  return ModelConnectors.fromParts(
    [],
    { count: 0, partIndex: [], matrices: new Float64Array(0) },
    mating,
    ends,
  );
}

function end(coefficients: ReadonlyArray<number>, heading: number, yPlates = 0): TrackEnd {
  return {
    pose: pose16(zeta16(coefficients.map((c) => BigInt(c))), heading),
    yPlates,
    frame: WORLD_TRACK_FRAME,
  };
}

function placedEnd(at: LatticePose, local: TrackEnd): TrackEnd {
  const frame = pose16(
    zeta16([at.x / STUD_LDU, 0, 0, 0, at.z / STUD_LDU, 0, 0, 0].map(BigInt)),
    -4 * at.rot,
  );
  return {
    pose: composePose16(frame, local.pose),
    yPlates: local.yPlates + at.yPlates,
    frame: WORLD_TRACK_FRAME,
  };
}

describe("ConnectionSolver with track ends", () => {
  it("refuses a run-frame end as a model connector, so it can never join another model's track", () => {
    const inRun: TrackEnd = {
      ...end([16, 0, 0, 0, 0, 0, 0, 0], 0),
      frame: { id: 1, xLdu: 0, zLdu: 0 },
    };
    expect(() => trackModel([inRun])).toThrow(RangeError);
  });

  it("joins track ends exactly where their ℤ[ζ₁₆] poses meet, including off-lattice curve ends", () => {
    const solver = new ConnectionSolver([new TrackEndFinder()]);
    const curveExit = [0, 0, 0, 40, -40, 0, 0, 0];
    solver.insert(
      trackModel([end([10, 0, 0, 0, 0, 0, 0, 0], 0), end(curveExit, 2)]),
      pose(0, 0, 0),
      28,
    );
    const straightEnd = trackModel([end(ZETA16_ZERO.map(Number), 8)]);
    expect(matesAt(solver, straightEnd, pose(10 * STUD_LDU, 0, 0))).toBe(1);
    expect(matesAt(solver, straightEnd, pose(11 * STUD_LDU, 0, 0))).toBe(0);
    expect(matesAt(solver, straightEnd, pose(10 * STUD_LDU, 0, 1))).toBe(0);
    expect(matesAt(solver, straightEnd, pose(10 * STUD_LDU + HALF, 0, 0))).toBe(0);
    const candidates = new CandidatePoses();
    solver.rank(straightEnd, window(pose(10 * STUD_LDU + HALF, 0, 0), 0, 0), candidates);
    const offGrid = Array.from(candidates.x.subarray(0, candidates.count)).indexOf(
      10 * STUD_LDU + HALF,
    );
    expect([candidates.votes[0], candidates.x[0], candidates.votes[offGrid]]).toEqual([
      1,
      10 * STUD_LDU,
      0,
    ]);
    solver.rank(straightEnd, window(pose(13 * STUD_LDU, 2 * STUD_LDU, 0), 1, 0, 4), candidates);
    expect([candidates.x[0], candidates.z[0], candidates.rot[0], candidates.votes[0]]).toEqual([
      10 * STUD_LDU,
      0,
      0,
      1,
    ]);
    const curveFacing = trackModel([end([-10, 0, 0, 40, -40, 0, 0, 0], 10)]);
    expect(matesAt(solver, curveFacing, pose(10 * STUD_LDU, 0, 0))).toBe(1);
    expect(matesAt(solver, curveFacing, pose(10 * STUD_LDU, 0, 0, 1))).toBe(0);
  });

  it("agrees with posesJoin16 for every seeded placement", () => {
    let seed = 20261118;
    const next = (span: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % span;
    };
    const randomEnd = (): TrackEnd =>
      end(
        Array.from({ length: 8 }, () => next(5) - 2),
        next(16),
        next(2),
      );
    const randomPose = (): LatticePose =>
      pose((next(7) - 3) * STUD_LDU, (next(7) - 3) * STUD_LDU, next(2), next(4) as QuarterTurn);
    const solver = new ConnectionSolver([new TrackEndFinder()]);
    const placed: TrackEnd[] = [];
    for (let m = 0; m < 40; m++) {
      const local = [randomEnd(), randomEnd()];
      const at = randomPose();
      solver.insert(trackModel(local), at, m);
      for (const e of local) placed.push(placedEnd(at, e));
    }
    const joinsOf = (own: TrackEnd): number =>
      placed.filter((w) => w.yPlates === own.yPlates && posesJoin16(own.pose, w.pose)).length;
    let joins = 0;
    for (let probe = 0; probe < 400; probe++) {
      const target = placed[next(placed.length)];
      if (!target) continue;
      const at = randomPose();
      const frame = placedEnd(at, end(ZETA16_ZERO.map(Number), 0, 0)).pose;
      const facing = target.pose.heading + 8 - frame.heading;
      const aimed: TrackEnd = {
        pose: pose16(
          rotateZeta16(subtractZeta16(target.pose.position, frame.position), -frame.heading),
          facing,
        ),
        yPlates: target.yPlates - at.yPlates,
        frame: WORLD_TRACK_FRAME,
      };
      const noise = randomEnd();
      const counted = matesAt(solver, trackModel([aimed, noise]), at);
      expect(counted).toBe(joinsOf(placedEnd(at, aimed)) + joinsOf(placedEnd(at, noise)));
      joins += counted;
    }
    expect(joins).toBeGreaterThanOrEqual(400);
  });
});

const through = (code: number, size: number): number => shape(0, false, [[code, size, 8]]);
const peg = (code: number, size: number): number => shape(CAP_ROOT, false, [[code, size, 8]]);
const offsetsInLdu = (...ldu: number[]): Int32Array =>
  Int32Array.from(ldu, (offset) => offset * SIXTEENTHS_PER_LDU);
const rangesInLdu = (...ldu: ReadonlyArray<readonly [number, number]>): Int32Array =>
  Int32Array.from(
    ldu.flatMap(([from, to]) => [from * SIXTEENTHS_PER_LDU, to * SIXTEENTHS_PER_LDU]),
  );
const grouped = (caps: number, group: string): number =>
  shapes.intern(caps, false, [SECTION_ROUND], [6], [4], group);

describe("SnapMating", () => {
  it("reads rotation freedom from the section rule: round and cross in round spin, cross in cross and square in square lock", () => {
    expect(mating.freedom(STUD, PLATE_RECEPTOR, 0, AXIS_NEG_Y)).toEqual({
      spins: true,
      axis: AXIS_POS_Y,
      freeAboutVertical: false,
    });
    expect(mating.freedom(peg(SECTION_AXLE, 6), through(SECTION_ROUND, 6), 0, AXIS_NEG_X)).toEqual({
      spins: true,
      axis: AXIS_POS_X,
      freeAboutVertical: false,
    });
    expect(
      mating.freedom(peg(SECTION_AXLE, 6), through(SECTION_AXLE, 6), 0, AXIS_POS_X).spins,
    ).toBe(false);
    expect(
      mating.freedom(peg(SECTION_SQUARE, 4), through(SECTION_SQUARE, 4), 0, AXIS_POS_Y).spins,
    ).toBe(false);
    expect(() => mating.freedom(STUD, PLATE_RECEPTOR, 3, AXIS_POS_Y)).toThrow(RangeError);
  });

  it("mates connectors carrying a group only with the same opaque group token", () => {
    expect(mating.engages(grouped(CAP_ROOT, "token-a"), grouped(CAP_FAR, "token-a"), 0)).toBe(true);
    expect(mating.engages(grouped(CAP_ROOT, "token-a"), grouped(CAP_FAR, "token-b"), 0)).toBe(
      false,
    );
    expect(mating.engages(grouped(CAP_ROOT, "token-a"), PLATE_RECEPTOR, 0)).toBe(false);
    expect(mating.engages(STUD, grouped(CAP_FAR, "token-a"), 0)).toBe(false);
  });

  it("seats a male rooted in a blind female only where the next move meets a section that doesn't fit or a stop", () => {
    const shallowReceptor = shape(CAP_FAR, false, [[SECTION_ROUND, 6, 2]]);
    expect(mating.offsets(STUD, shallowReceptor)).toEqual(offsetsInLdu(2));
    const collaredShaft = shape(CAP_ROOT, false, [
      [SECTION_ROUND, 6, 4],
      [SECTION_ROUND, 8, 2],
      [SECTION_ROUND, 6, 16],
    ]);
    const deepSocket = shape(CAP_FAR, false, [[SECTION_ROUND, 6, 30]]);
    expect(mating.offsets(collaredShaft, deepSocket)).toEqual(offsetsInLdu(6));
  });

  it("lets a pair with one connector open at both ends rest wherever the shorter lies fully on the longer, besides its seats", () => {
    const collaredPin = shape(0, false, [
      [SECTION_ROUND, 6, 4],
      [SECTION_ROUND, 8, 2],
      [SECTION_ROUND, 6, 16],
    ]);
    expect(mating.ranges(collaredPin, through(SECTION_ROUND, 6))).toEqual(
      rangesInLdu([-4, -4], [6, 14]),
    );
    const boreInTwoHalves = shape(0, false, [
      [SECTION_ROUND, 6, 4],
      [SECTION_ROUND, 6, 4],
    ]);
    expect(mating.ranges(collaredPin, boreInTwoHalves)).toEqual(rangesInLdu([-4, -4], [6, 14]));
    const barHeldAtBothEnds = shape(CAP_ROOT | CAP_FAR, false, [[SECTION_ROUND, 4, 12]]);
    const sleeve = shape(0, false, [[SECTION_ROUND, 4, 4]]);
    expect(mating.ranges(barHeldAtBothEnds, sleeve)).toEqual(rangesInLdu([0, 8]));
  });

  it("lets such a pair also rest partway on when either slides, while a rooted shaft in a blind socket rests only home", () => {
    const slidingBar = shape(CAP_ROOT, true, [[SECTION_ROUND, 4, 18]]);
    const sleeve = shape(0, false, [[SECTION_ROUND, 4, 12]]);
    expect(mating.ranges(slidingBar, sleeve)).toEqual(
      Int32Array.from([0, 18 * SIXTEENTHS_PER_LDU - 1]),
    );
    const freeShaft = shape(0, true, [[SECTION_ROUND, 4, 18]]);
    const blindSocket = shape(CAP_FAR, false, [[SECTION_ROUND, 4, 20]]);
    expect(mating.ranges(freeShaft, blindSocket)).toEqual(
      Int32Array.from([-2 * SIXTEENTHS_PER_LDU, 18 * SIXTEENTHS_PER_LDU - 1]),
    );
    const steppedSleeve = shape(0, false, [
      [SECTION_ROUND, 4, 6.7],
      [SECTION_ROUND, 6, 5.3],
    ]);
    expect(mating.ranges(freeShaft, steppedSleeve)).toEqual(
      Int32Array.from([Math.ceil(-6.7 * SIXTEENTHS_PER_LDU), 18 * SIXTEENTHS_PER_LDU - 1]),
    );
    const slidingNeck = shape(CAP_ROOT, true, [[SECTION_ROUND, 6, 12]]);
    const blindCap = shape(CAP_FAR, false, [[SECTION_ROUND, 6, 20]]);
    expect(mating.ranges(slidingNeck, blindCap)).toEqual(rangesInLdu([0, 0]));
  });

  it("keeps a rooted male shorter than a through female from sinking past its root", () => {
    const deepThroughHole = shape(0, false, [[SECTION_ROUND, 6, 20]]);
    expect(mating.ranges(STUD, deepThroughHole)).toEqual(rangesInLdu([0, 0]));
  });
});

function partners(report: MateReport): number[][] {
  return Array.from({ length: report.count }, (_, k) => [
    report.family[k] ?? 0,
    report.connector[k] ?? 0,
    report.partner[k] ?? 0,
    report.instance[k] ?? 0,
    report.partnerInstance[k] ?? 0,
    ...report.engagement.subarray(k * ENGAGEMENT_FLOATS, (k + 1) * ENGAGEMENT_FLOATS),
  ]).toSorted((a, b) => (a[0] ?? 0) - (b[0] ?? 0) || (a[1] ?? 0) - (b[1] ?? 0));
}

function pinEngaged(z: number): number[] {
  return [axisDimension(AXIS_POS_X), HOLE_HEIGHT, z, 0, 8, 6].map((v, k) =>
    k === 0 ? v : v * SIXTEENTHS_PER_LDU,
  );
}

describe("ConnectionSolver mate partners", () => {
  it("names the placement and part each sparse and track mate joins, with the sparse mate's engaged span, and no partner for an anonymous stud mate", () => {
    const solver = new ConnectionSolver([
      new LatticeStudFinder(mating),
      new SparseConnectorFinder(mating),
      new TrackEndFinder(),
    ]);
    const holes = single(edgeHoles());
    const elsewhere = 40 * STUD_LDU;
    solver.insert(holes, pose(0, 0, 0), 7);
    solver.insert(holes, pose(0, elsewhere, 0), 8);
    solver.insert(single(baseplate(1, 1)), pose(-2 * STUD_LDU, 0, 0), 9);
    solver.insert(
      trackModel([end([3, 0, 0, 0, 0, 0, 0, 0], 8), end([-30, 0, 0, 0, 0, 0, 0, 0], 0)]),
      pose(-NEIGHBOUR_WIDTH_LDU, 0, 0),
      11,
    );
    const pinned = ModelConnectors.fromParts(
      [edgePins(), block(1, 1, PLATE_LDU, PLATE_RECEPTOR)],
      {
        count: 2,
        partIndex: [0, 1],
        matrices: Float64Array.from([
          ...translation(0, 0, 0),
          ...translation(NEIGHBOUR_WIDTH_LDU - 2 * STUD_LDU, 0, 0),
        ]),
      },
      mating,
      [{ ...end([-30, 0, 0, 0, 0, 0, 0, 0], 8), instance: 1 }],
    );
    const unengaged = [NOT_ENGAGED, 0, 0, 0, 0, 0];
    expect(partners(evaluated(solver, pinned, pose(-NEIGHBOUR_WIDTH_LDU, 0, 0)))).toEqual([
      [0, 5, NO_PARTNER, 1, NO_INSTANCE, ...unengaged],
      ...EDGE_ROWS.map((z, k) => [1, k, 7, 0, 0, ...pinEngaged(z)]),
      [2, 0, 11, 1, NO_INSTANCE, ...unengaged],
    ]);
    solver.remove(holes, pose(0, 0, 0), 7);
    expect(
      partners(evaluated(solver, pinned, pose(-NEIGHBOUR_WIDTH_LDU, elsewhere, 0))).map(
        ([family, connector, partner]) => [family, connector, partner],
      ),
    ).toEqual(EDGE_ROWS.map((_, k) => [1, k, 8]));
  });
});

const FACE_TOKEN = "token-face";
const face = (group: string): number => shapes.intern(0, false, [SECTION_ROUND], [0], [0], group);
const FACE_X = 40;
const FACE_Y = 12;

function facePair(axis: number, x = FACE_X): ConnectorTable {
  const at = [x, FACE_Y, HALF] as const;
  return table([
    { shape: face(FACE_TOKEN), gender: GENDER_MALE, origin: at, axis },
    { shape: face(FACE_TOKEN), gender: GENDER_FEMALE, origin: at, axis },
  ]);
}

describe("zero-length grouped faces", () => {
  it("leave a face-contact mate free about its own axis and the vertical through the face, unlike an inserted one", () => {
    expect(mating.freedom(face(FACE_TOKEN), face(FACE_TOKEN), 0, AXIS_NEG_X)).toEqual({
      spins: true,
      axis: AXIS_POS_X,
      freeAboutVertical: true,
    });
  });

  it("engage only at offset 0 and only with the same group token", () => {
    expect(mating.offsets(face(FACE_TOKEN), face(FACE_TOKEN))).toEqual(Int32Array.from([0]));
    expect(mating.engages(face(FACE_TOKEN), face("token-other"), 0)).toBe(false);
    expect(mating.engages(face(FACE_TOKEN), PLATE_RECEPTOR, 0)).toBe(false);
    expect(mating.engages(face(NO_GROUP), PLATE_RECEPTOR, 0)).toBe(false);
  });

  it("keep a face's own male and female exposed, and mate two faces that meet with opposed axes", () => {
    const carEnd = single(facePair(AXIS_POS_X));
    expect([carEnd.count, carEnd.internalMates]).toEqual([2, 0]);
    const engine = allFamilies();
    engine.insert(carEnd, pose(0, 0, 0), 102);
    const facing = single(facePair(AXIS_NEG_X));
    expect(matesAt(engine, facing, pose(0, 0, 0))).toBe(2);
    expect(matesAt(engine, facing, pose(STUD_LDU, 0, 0))).toBe(0);
    expect(matesAt(engine, single(facePair(AXIS_POS_X)), pose(0, 0, 0))).toBe(0);
  });

  it("mate a face measured off whole LDU, at 136/16 LDU, with its opposite at the coincident pose only, never with one a sixteenth away", () => {
    const measured = 136 / SIXTEENTHS_PER_LDU;
    const engine = allFamilies();
    engine.insert(single(facePair(AXIS_POS_X, measured)), pose(0, 0, 0), 103);
    engine.insert(single(facePair(AXIS_POS_X, 137 / SIXTEENTHS_PER_LDU)), pose(0, 0, 0), 104);
    const facing = single(facePair(AXIS_NEG_X, measured));
    for (const rot of [0, 1, 2, 3] as const) {
      for (let x = -STUD_LDU; x <= STUD_LDU; x++) {
        for (const y of [-1, 0, 1]) {
          const coincident = x === 0 && y === 0 && rot === 0;
          expect(matesAt(engine, facing, pose(x, 0, y, rot))).toBe(coincident ? 2 : 0);
        }
      }
    }
    const candidates = new CandidatePoses();
    engine.rank(facing, window(pose(STUD_LDU, 0, 0), 1, 1, 4), candidates);
    expect([candidates.x[0], candidates.z[0], candidates.rot[0], candidates.votes[0]]).toEqual([
      0, 0, 0, 1,
    ]);
    expect(Array.from(candidates.votes.subarray(1, candidates.count))).toEqual(
      Array(candidates.count - 1).fill(0),
    );
  });
});

const FLARE = 6.25;
const GROOVE = 6.5;

describe("flared sections", () => {
  it("seat a male flare as round at its round partner's radius, from either end", () => {
    const blind = shape(CAP_FAR, false, [[SECTION_ROUND, 6, 18]]);
    const tipFlare = shape(CAP_ROOT, false, [
      [SECTION_ROUND, 6, 16],
      [SECTION_FLARE_JOINS_PREVIOUS, FLARE, 2],
    ]);
    const rootFlare = shape(CAP_ROOT, false, [
      [SECTION_FLARE_JOINS_NEXT, FLARE, 2],
      [SECTION_ROUND, 6, 16],
    ]);
    expect(mating.engages(tipFlare, blind, 0)).toBe(true);
    expect(mating.engages(rootFlare, blind, 0)).toBe(true);
    expect(mating.freedom(tipFlare, blind, 0, AXIS_POS_X).spins).toBe(true);
  });

  it("hold a male flare where it has sprung open and the next move would squeeze it, not where it's squeezed already", () => {
    const lipped = (caps: number): number =>
      shape(caps, false, [
        [SECTION_ROUND, 6, 10],
        [SECTION_FLARE_JOINS_PREVIOUS, FLARE, 2],
      ]);
    const grooved = shape(0, false, [
      [SECTION_ROUND, 6, 6],
      [SECTION_ROUND, 8, 3],
      [SECTION_ROUND, 6, 6],
    ]);
    expect(mating.offsets(lipped(CAP_ROOT), grooved)).toEqual(offsetsInLdu(0, 3, 4));
    const roundThenSquare = shape(0, false, [
      [SECTION_ROUND, 6, 12],
      [SECTION_SQUARE, 6, 8],
    ]);
    expect(mating.ranges(lipped(0), roundThenSquare)).toEqual(rangesInLdu([-10, -10], [-8, 0]));
    const squareThenRoundSocket = shape(CAP_FAR, false, [
      [SECTION_SQUARE, 6, 8],
      [SECTION_ROUND, 6, 12],
    ]);
    expect(mating.offsets(lipped(CAP_ROOT), squareThenRoundSocket)).toEqual(offsetsInLdu(0));
  });

  it("read a female flare as round at its own radius, whatever sits beside it", () => {
    const grooved = shape(0, false, [
      [SECTION_SQUARE, 6, 4],
      [SECTION_FLARE_JOINS_PREVIOUS, GROOVE, 2],
      [SECTION_ROUND, 6, 12],
    ]);
    const roundPeg = shape(CAP_ROOT, false, [[SECTION_ROUND, 6, 14]]);
    expect(mating.offsets(roundPeg, grooved)).toEqual(Int32Array.from([0]));
  });

  it("never mate a male flare whose partner isn't round, or that has no partner", () => {
    const axleBore = shape(0, false, [[SECTION_ROUND, 4, 12]]);
    const axleFlare = shape(CAP_ROOT, false, [
      [SECTION_AXLE, 4, 11],
      [SECTION_FLARE_JOINS_PREVIOUS, 4.25, 1],
    ]);
    expect(mating.offsets(axleFlare, axleBore)).toEqual(new Int32Array(0));
    const fresh = new SnapShapes();
    const bore = fresh.intern(0, false, [SECTION_ROUND], [6], [12]);
    const orphan = fresh.intern(
      CAP_ROOT,
      false,
      [SECTION_FLARE_JOINS_PREVIOUS, SECTION_ROUND],
      [FLARE, 6],
      [2, 10],
    );
    expect(new SnapMating(fresh).offsets(orphan, bore)).toEqual(new Int32Array(0));
  });
});

const FREE_PIN = shape(0, false, [[SECTION_ROUND, 6, 2 * STUD_LDU]]);
const THROUGH_BORE = shape(0, true, [[SECTION_ROUND, 6, STUD_LDU]]);
const BORE_LINES_X = [HALF, 3 * HALF] as const;

function throughBores(): ConnectorTable {
  return table(
    BORE_LINES_X.flatMap((x) => [
      { shape: THROUGH_BORE, gender: GENDER_FEMALE, origin: [x, HOLE_HEIGHT, 0], axis: AXIS_NEG_Z },
      {
        shape: THROUGH_BORE,
        gender: GENDER_FEMALE,
        origin: [x, HOLE_HEIGHT, STUD_LDU],
        axis: AXIS_POS_Z,
      },
    ]),
  );
}

function freePins(): ConnectorTable {
  return table(
    BORE_LINES_X.flatMap((x) => [
      { shape: FREE_PIN, gender: GENDER_MALE, origin: [x, HOLE_HEIGHT, -HALF], axis: AXIS_POS_Z },
      {
        shape: FREE_PIN,
        gender: GENDER_MALE,
        origin: [x, HOLE_HEIGHT, STUD_LDU + HALF],
        axis: AXIS_NEG_Z,
      },
    ]),
  );
}

describe("ConnectionSolver mate joints", () => {
  it("joins a pinned module once per pin, whether each pin's free end is its own unverified half-pin over an included sliding male or the sliding male's free tip alone", () => {
    const halfPin = shape(CAP_ROOT, false, [
      [SECTION_ROUND, 8, 2],
      [SECTION_ROUND, 6, 16],
      [SECTION_FLARE_JOINS_PREVIOUS, FLARE, 2],
    ]);
    const slidingPin = shape(0, true, [
      [SECTION_FLARE_JOINS_NEXT, FLARE, 2],
      [SECTION_ROUND, 6, 16],
      [SECTION_ROUND, 8, 4],
      [SECTION_ROUND, 6, 16],
      [SECTION_FLARE_JOINS_PREVIOUS, FLARE, 2],
    ]);
    const barHole = shape(0, false, [[SECTION_ROUND, 4, 2 * STUD_LDU]]);
    const bore = shape(0, true, [
      [SECTION_ROUND, 8, 2],
      [SECTION_ROUND, 6, 16],
      [SECTION_ROUND, 8, 2],
    ]);
    const slidingFaces: Spec[] = [
      { shape: slidingPin, gender: GENDER_MALE, origin: [0, 0, -STUD_LDU], axis: AXIS_POS_Z },
      { shape: slidingPin, gender: GENDER_MALE, origin: [0, 0, STUD_LDU], axis: AXIS_NEG_Z },
      { shape: barHole, gender: GENDER_FEMALE, origin: [0, 0, -STUD_LDU], axis: AXIS_NEG_Z },
      { shape: barHole, gender: GENDER_FEMALE, origin: [0, 0, STUD_LDU], axis: AXIS_POS_Z },
    ];
    const halvesOverAnIncludedSlidingPin = table([
      {
        shape: halfPin,
        gender: GENDER_MALE,
        status: STATUS_UNVERIFIED,
        origin: [0, 0, 0],
        axis: AXIS_NEG_Z,
      },
      {
        shape: halfPin,
        gender: GENDER_MALE,
        status: STATUS_UNVERIFIED,
        origin: [0, 0, 0],
        axis: AXIS_POS_Z,
      },
      ...slidingFaces,
    ]);
    const boredBrick = (fromZ: number) =>
      table(
        BORE_LINES_X.flatMap((x): Spec[] => [
          { shape: bore, gender: GENDER_FEMALE, origin: [x, HOLE_HEIGHT, fromZ], axis: AXIS_NEG_Z },
          {
            shape: bore,
            gender: GENDER_FEMALE,
            origin: [x, HOLE_HEIGHT, fromZ + STUD_LDU],
            axis: AXIS_POS_Z,
          },
        ]),
      );
    const joined = (pin: ConnectorTable) => {
      const solver = allFamilies();
      solver.insert(single(boredBrick(0)), pose(0, 0, 0), 5);
      const pinned = model(
        [boredBrick(-STUD_LDU), pin],
        [
          [0, translation(0, 0, 0)],
          ...BORE_LINES_X.map((x) => [1, translation(x, HOLE_HEIGHT, 0)] as const),
        ],
      );
      const report = evaluated(solver, pinned, pose(0, 0, 0));
      const matedBy = Array.from({ length: report.count }, (_, k) => [
        report.status[k],
        shapes.slides(report.shape[k] ?? 0),
      ]);
      return { mates: report.count, joints: report.jointCount, matedBy };
    };
    expect({
      halvesOverAnIncludedSlidingPin: joined(halvesOverAnIncludedSlidingPin),
      slidingPinAlone: joined(table(slidingFaces)),
    }).toEqual({
      halvesOverAnIncludedSlidingPin: {
        mates: 2,
        joints: 2,
        matedBy: [
          [STATUS_UNVERIFIED, false],
          [STATUS_UNVERIFIED, false],
        ],
      },
      slidingPinAlone: {
        mates: 2,
        joints: 2,
        matedBy: [
          [STATUS_VERIFIED, true],
          [STATUS_VERIFIED, true],
        ],
      },
    });
  });

  it("counts a free male through a through bore as one joint, though each end's face pairs with the opening it faces, and keeps another line between the same parts its own joint", () => {
    const solver = allFamilies();
    solver.insert(single(throughBores()), pose(0, 0, 0), 5);
    const report = evaluated(solver, single(freePins()), pose(0, 0, 0));
    const jointOfLine = (x: number): number[] =>
      Array.from({ length: report.count }, (_, k) => k)
        .filter(
          (k) => report.engagement[k * ENGAGEMENT_FLOATS + ENGAGED_U] === x * SIXTEENTHS_PER_LDU,
        )
        .map((k) => report.joint[k] ?? -1);
    const first = jointOfLine(BORE_LINES_X[0]);
    const second = jointOfLine(BORE_LINES_X[1]);
    expect({
      faces: report.count,
      joints: report.jointCount,
      firstLine: [first.length, new Set(first).size],
      secondLine: [second.length, new Set(second).size],
      distinct: first[0] !== second[0],
    }).toEqual({
      faces: 4,
      joints: 2,
      firstLine: [2, 1],
      secondLine: [2, 1],
      distinct: true,
    });
  });
});

interface WorldConnector {
  readonly owner: number;
  readonly instance: number;
  readonly shape: number;
  readonly gender: number;
  readonly at: readonly [number, number, number];
  readonly axis: number;
}

const HELD = -1;

function worldConnectors(
  piece: ModelConnectors,
  at: LatticePose,
  owner: number = HELD,
): WorldConnector[] {
  const rot = at.rot as QuarterTurn;
  return Array.from({ length: piece.count }, (_, c) => {
    const x = piece.origin[c * 3] ?? 0;
    const z = piece.origin[c * 3 + 2] ?? 0;
    return {
      owner,
      instance: piece.instance[c] ?? 0,
      shape: piece.shape[c] ?? 0,
      gender: piece.gender[c] ?? 0,
      at: [
        rot90Cos(rot) * x + rot90Sin(rot) * z + at.x * SIXTEENTHS_PER_LDU,
        (piece.origin[c * 3 + 1] ?? 0) + at.yPlates * PLATE_LDU * SIXTEENTHS_PER_LDU,
        -rot90Sin(rot) * x + rot90Cos(rot) * z + at.z * SIXTEENTHS_PER_LDU,
      ],
      axis: turnedAxis(piece.axis[c] ?? 0, rot),
    };
  });
}

const connectorKey = (p: WorldConnector): string =>
  `${p.at.join(",")}/${p.axis}/${p.shape}/${p.gender}`;

function coaxialLine(axis: number, at: readonly [number, number, number]): string {
  const dimension = axis >> 1;
  return `${axis}/${at[(dimension + 1) % 3]}/${at[(dimension + 2) % 3]}`;
}

const worldLines = new WeakMap<
  ReadonlyArray<WorldConnector>,
  { size: number; lines: Map<string, WorldConnector[]> }
>();

function linesOf(world: ReadonlyArray<WorldConnector>): Map<string, WorldConnector[]> {
  const known = worldLines.get(world);
  if (known && known.size === world.length) return known.lines;
  const lines = new Map<string, WorldConnector[]>();
  for (const other of world) {
    const key = coaxialLine(other.axis, other.at);
    const line = lines.get(key);
    if (line) line.push(other);
    else lines.set(key, [other]);
  }
  worldLines.set(world, { size: world.length, lines });
  return lines;
}

function engagedPartners(
  held: ModelConnectors,
  at: LatticePose,
  world: ReadonlyArray<WorldConnector>,
): Array<readonly [WorldConnector, WorldConnector[]]> {
  const lines = linesOf(world);
  return worldConnectors(held, at).map((own) => [
    own,
    (lines.get(coaxialLine(own.axis ^ 1, own.at)) ?? []).filter((other) => {
      if (own.gender === other.gender) return false;
      const dimension = own.axis >> 1;
      const [male, female] = own.gender === GENDER_MALE ? [own, other] : [other, own];
      const toward = (male.axis & 1) === 0 ? 1 : -1;
      const offset = ((female.at[dimension] ?? 0) - (male.at[dimension] ?? 0)) * toward;
      return mating.engages(male.shape, female.shape, offset);
    }),
  ]);
}

function engagedPairs(
  held: ModelConnectors,
  at: LatticePose,
  world: ReadonlyArray<WorldConnector>,
): number[] {
  return engagedPartners(held, at, world).map(([, engaged]) => engaged.length);
}

function engagedJoints(
  held: ModelConnectors,
  at: LatticePose,
  world: ReadonlyArray<WorldConnector>,
): number {
  const joints = new Set<string>();
  for (const [own, engaged] of engagedPartners(held, at, world)) {
    const anonymous = isLatticeStud(own.axis, own.at[0], own.at[2]);
    const line = coaxialLine(own.axis & ~1, own.at);
    for (const other of engaged) {
      joints.add(
        anonymous
          ? `${connectorKey(own)}~${connectorKey(other)}`
          : `${other.owner}/${own.instance}/${other.instance}/${line}`,
      );
    }
  }
  return joints.size;
}

function turnedAxis(axis: number, rot: QuarterTurn): number {
  const dimension = axis >> 1;
  if (dimension === 1) return axis;
  const sign = (axis & 1) === 0 ? 1 : -1;
  const x = dimension === 0 ? sign : 0;
  const z = dimension === 2 ? sign : 0;
  const tx = rot90Cos(rot) * x + rot90Sin(rot) * z;
  const tz = -rot90Sin(rot) * x + rot90Cos(rot) * z;
  if (tx !== 0) return tx > 0 ? AXIS_POS_X : AXIS_NEG_X;
  return tz > 0 ? AXIS_POS_Z : AXIS_NEG_Z;
}

function specKey(s: Spec): string {
  return `${s.origin.join(",")}/${s.axis}/${s.shape}/${s.gender}`;
}

describe("ConnectionSolver against every coaxial pair", () => {
  const BAR = shape(CAP_ROOT, true, [[SECTION_ROUND, 4, 20]]);
  const CLIP = shape(0, false, [[SECTION_ROUND, 4, 4]]);
  const AXLE = shape(CAP_ROOT, true, [[SECTION_AXLE, 4, 16]]);
  const AXLE_HOLE = shape(0, true, [[SECTION_AXLE, 4, 10]]);
  const SLEEVE = shape(0, true, [
    [SECTION_ROUND, 4, 6],
    [SECTION_ROUND, 6, 2],
  ]);
  const PALETTE = [
    [STUD, GENDER_MALE],
    [PLATE_RECEPTOR, GENDER_FEMALE],
    [BRICK_RECEPTOR, GENDER_FEMALE],
    [PIN, GENDER_MALE],
    [PIN_HOLE, GENDER_FEMALE],
    [BAR, GENDER_MALE],
    [CLIP, GENDER_FEMALE],
    [AXLE, GENDER_MALE],
    [AXLE_HOLE, GENDER_FEMALE],
    [SLEEVE, GENDER_FEMALE],
  ] as const;
  const AXES = [AXIS_POS_X, AXIS_NEG_X, AXIS_POS_Y, AXIS_NEG_Y, AXIS_POS_Z, AXIS_NEG_Z] as const;
  const ALONG_STEP_LDU = 2.5;
  const ALONG_STEPS = 5;
  const ACROSS_STEP_LDU = 10;
  const ACROSS_STEPS = 3;

  function partnerAtOffsetZero(own: Spec): (typeof PALETTE)[number] | undefined {
    return PALETTE.find(([s, gender]) =>
      gender === GENDER_MALE
        ? own.gender === GENDER_FEMALE && mating.engages(s, own.shape, 0)
        : own.gender === GENDER_MALE && mating.engages(own.shape, s, 0),
    );
  }

  it(
    "mates exactly the coaxial pairs that SnapMating engages and votes once per joint, on seeded worlds and after stamping the held model",
    () => {
      let seed = 0x6a7e;
      const next = (span: number): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed % span;
      };
      const randomSpecs = (count: number): Map<string, Spec> => {
        const specs = new Map<string, Spec>();
        while (specs.size < count) {
          const [s, gender] = PALETTE[next(PALETTE.length)] ?? PALETTE[0];
          const axis = AXES[next(AXES.length)] ?? AXIS_POS_Y;
          const coordinate = (k: number): number =>
            k === axis >> 1
              ? next(ALONG_STEPS) * ALONG_STEP_LDU
              : next(ACROSS_STEPS) * ACROSS_STEP_LDU;
          const spec: Spec = {
            shape: s,
            gender,
            origin: [coordinate(0), coordinate(1), coordinate(2)],
            axis,
          };
          specs.set(specKey(spec), spec);
        }
        return specs;
      };
      const randomPiece = (count: number): ModelConnectors =>
        single(table([...randomSpecs(count).values()]));
      const withPartnersAStudAlong = (count: number): ModelConnectors => {
        const specs = randomSpecs(count);
        for (const own of Array.from(specs.values())) {
          const partner = partnerAtOffsetZero(own);
          if (!partner) continue;
          const [x, y, z] = own.origin;
          const spec: Spec = {
            shape: partner[0],
            gender: partner[1],
            origin: [x + STUD_LDU, y, z],
            axis: own.axis ^ 1,
          };
          if (!specs.has(specKey(spec))) specs.set(specKey(spec), spec);
        }
        return single(table([...specs.values()]));
      };
      const randomPose = (): LatticePose =>
        pose((next(3) - 1) * HALF, (next(3) - 1) * HALF, next(3) - 1, next(4) as QuarterTurn);
      let mates = 0;
      let votes = 0;
      for (let trial = 0; trial < 32; trial++) {
        const solver = allFamilies();
        const world: WorldConnector[] = [];
        const seen = new Set<string>();
        let placed = 0;
        const placeAt = (piece: ModelConnectors, at: LatticePose): boolean => {
          const owner = placed++;
          const connectors = worldConnectors(piece, at, owner);
          if (connectors.some((c) => seen.has(connectorKey(c)))) return false;
          for (const c of connectors) seen.add(connectorKey(c));
          world.push(...connectors);
          solver.insert(piece, at, owner);
          return true;
        };
        const heldIsLarge = trial % 2 === 0;
        for (let m = 0; m < 8; m++) {
          const piece = randomPiece(heldIsLarge ? 4 : 40);
          while (!placeAt(piece, randomPose()));
        }
        const held = withPartnersAStudAlong(heldIsLarge ? 30 : 2);
        const candidates = new CandidatePoses();
        let at = randomPose();
        for (let probe = 0; probe < 10; probe++) {
          if (probe === 5) {
            const rot = at.rot as QuarterTurn;
            placeAt(
              held,
              pose(
                at.x - rot90Cos(rot) * STUD_LDU,
                at.z + rot90Sin(rot) * STUD_LDU,
                at.yPlates,
                rot,
              ),
            );
          } else {
            at = randomPose();
          }
          const report = evaluated(solver, held, at);
          const reported = Array<number>(held.count).fill(0);
          for (let k = 0; k < report.count; k++) {
            const c = report.connector[k] ?? 0;
            reported[c] = (reported[c] ?? 0) + 1;
          }
          expect(reported).toEqual(engagedPairs(held, at, world));
          mates += report.count;
          solver.rank(held, window(at, 1, 1, 4), candidates);
          for (let i = 0; i < candidates.count; i++) {
            const candidate = pose(
              candidates.x[i] ?? 0,
              candidates.z[i] ?? 0,
              candidates.yPlates[i] ?? 0,
              (candidates.rot[i] ?? 0) as QuarterTurn,
            );
            expect(candidates.votes[i]).toBe(engagedJoints(held, candidate, world));
            votes += engagedPairs(held, candidate, world).reduce((a, b) => a + b, 0);
          }
          solver.rank(held, window(at, 0, 0, 1), candidates);
          expect([candidates.count, candidates.votes[0]]).toEqual([1, report.jointCount]);
        }
      }
      expect(mates).toBeGreaterThanOrEqual(50);
      expect(votes).toBeGreaterThanOrEqual(5_000);
    },
    PROPERTY_TIMEOUT_MS,
  );
});

const FINGER_X = 40;
const FINGER_Y = 12;
const FINGER_TOKEN = "token-finger";
const SIXTEENTH = 1 / SIXTEENTHS_PER_LDU;

function fingerCodes(firstMale: boolean, widths: ReadonlyArray<number>): number[] {
  return widths.map((_, k) =>
    (k % 2 === 0) === firstMale ? SECTION_MALE_FINGER : SECTION_FEMALE_FINGER,
  );
}

function fingers(
  codes: ReadonlyArray<number>,
  widths: ReadonlyArray<number>,
  radius = FINGER_RADIUS_UNSTATED,
  group = NO_GROUP,
): number {
  return shapes.intern(
    0,
    false,
    codes,
    widths.map(() => radius),
    widths,
    group,
  );
}

function lone(code: number, width: number): number {
  return fingers([code], [width]);
}

function radiiEngage(maleRadius: number, femaleRadius: number, group = NO_GROUP): boolean {
  const finger = fingers([SECTION_MALE_FINGER], [8], maleRadius, group);
  return mating.engages(finger, fingers([SECTION_FEMALE_FINGER], [8], femaleRadius, group), 0);
}

function fingerHalf(
  firstMale: boolean,
  widths: ReadonlyArray<number>,
  axis: number,
): ConnectorTable {
  const codes = fingerCodes(firstMale, widths);
  const reach = (axisSign(axis) * widths.reduce((sum, width) => sum + width, 0)) / 2;
  const start = [FINGER_X - reach, FINGER_Y, HALF] as const;
  const far = [FINGER_X + reach, FINGER_Y, HALF] as const;
  const inOrder = fingers(codes, widths);
  const backwards = fingers(codes.toReversed(), widths.toReversed());
  return table([
    { shape: inOrder, gender: GENDER_MALE, origin: start, axis },
    { shape: inOrder, gender: GENDER_FEMALE, origin: start, axis: oppositeAxis(axis) },
    { shape: backwards, gender: GENDER_MALE, origin: far, axis: oppositeAxis(axis) },
    { shape: backwards, gender: GENDER_FEMALE, origin: far, axis },
  ]);
}

function freeFaces(part: ConnectorTable, shiftLdu: number): ConnectorTable {
  const originFree = Float64Array.from({ length: part.count * VECTOR_FLOATS }, (_, k) => {
    const coordinate = k % VECTOR_FLOATS;
    const ldu = connectorOriginLdu(part, (k - coordinate) / VECTOR_FLOATS, coordinate);
    return coordinate === 0 ? ldu + shiftLdu : ldu;
  });
  const axisFree = new Float64Array(part.count * VECTOR_FLOATS);
  for (let c = 0; c < part.count; c++) {
    const code = part.axis[c] ?? AXIS_FREE;
    axisFree[c * VECTOR_FLOATS + axisDimension(code)] = axisSign(code);
  }
  return new ConnectorTable(
    part.shape,
    part.gender,
    part.source,
    part.status,
    new Int32Array(part.count * VECTOR_FLOATS),
    new Int8Array(part.count).fill(AXIS_FREE),
    axisFree,
    part.piece,
    originFree,
    part.unreadable,
  );
}

function exposure(connectors: ModelConnectors): number[] {
  return [connectors.count, connectors.internalMates, connectors.offLattice];
}

describe("finger sequences", () => {
  const uneven = [3.5, 5, 1.5];

  it("mate two halves whose fingers interleave exactly, whichever way their sequences run, and never a swapped finger order or a copy", () => {
    const engine = allFamilies();
    engine.insert(single(fingerHalf(true, uneven, AXIS_POS_X)), pose(0, 0, 0), 1);
    const partner = single(fingerHalf(false, uneven, AXIS_POS_X));
    expect(matesAt(engine, partner, pose(0, 0, 0))).toBe(4);
    expect(matesAt(engine, partner, pose(1, 0, 0))).toBe(0);
    const runningBack = single(fingerHalf(false, uneven.toReversed(), AXIS_NEG_X));
    expect(matesAt(engine, runningBack, pose(0, 0, 0))).toBe(4);
    const swapped = single(fingerHalf(false, uneven.toReversed(), AXIS_POS_X));
    expect(matesAt(engine, swapped, pose(0, 0, 0))).toBe(0);
    expect(matesAt(engine, single(fingerHalf(true, uneven, AXIS_POS_X)), pose(0, 0, 0))).toBe(0);
    const candidates = new CandidatePoses();
    engine.rank(partner, window(pose(1, 0, 0), 1, 1, 4), candidates);
    expect([candidates.x[0], candidates.z[0], candidates.rot[0], candidates.votes[0]]).toEqual([
      0, 0, 0, 1,
    ]);
  });

  it("consume both halves of a joint inside one model, identifying free faces like any other, while a lone or unidentified half stays exposed", () => {
    const half = fingerHalf(false, uneven, AXIS_POS_X);
    const offGrid = freeFaces(half, SIXTEENTH / 2);
    const joint = (other: ConnectorTable, shiftLdu: number): ModelConnectors =>
      model(
        [fingerHalf(true, uneven, AXIS_POS_X), other],
        [
          [0, translation(0, 0, 0)],
          [1, translation(shiftLdu, 0, 0)],
        ],
      );
    expect(exposure(joint(half, 0))).toEqual([0, 4, 0]);
    expect(exposure(joint(offGrid, -SIXTEENTH / 2))).toEqual([0, 4, 0]);
    expect(exposure(joint(offGrid, 0))).toEqual([4, 0, 4]);
    expect(exposure(single(fingerHalf(true, uneven, AXIS_POS_X)))).toEqual([4, 0, 0]);
  });

  it("seat a finger only in a gap of exactly its width, to the sixteenth, at every such gap of a longer sequence", () => {
    const finger = lone(SECTION_MALE_FINGER, 8);
    expect(mating.ranges(finger, lone(SECTION_FEMALE_FINGER, 8))).toEqual(rangesInLdu([0, 0]));
    const none = new Int32Array(0);
    expect(mating.ranges(finger, lone(SECTION_FEMALE_FINGER, 8 + SIXTEENTH))).toEqual(none);
    expect(mating.ranges(finger, lone(SECTION_FEMALE_FINGER, 8 - SIXTEENTH))).toEqual(none);
    const knuckles = [8, 8, 8, 8, 8];
    expect(mating.ranges(finger, fingers(fingerCodes(true, knuckles), knuckles))).toEqual(
      rangesInLdu([-24, -24], [-8, -8]),
    );
  });

  it("need equal radii between ungrouped fingers only where both state one", () => {
    expect(radiiEngage(1.5, 1.5)).toBe(true);
    expect(radiiEngage(9.5, 9)).toBe(false);
    expect(radiiEngage(9.5, FINGER_RADIUS_UNSTATED)).toBe(true);
    expect(radiiEngage(FINGER_RADIUS_UNSTATED, 1.5)).toBe(true);
  });

  it("mate grouped fingers on their token and widths, whatever radii they state", () => {
    expect(radiiEngage(2, 4, FINGER_TOKEN)).toBe(true);
  });

  it("leave a finger mate free about its own axis only, unlike a face contact", () => {
    const finger = lone(SECTION_MALE_FINGER, 8);
    expect(mating.freedom(finger, lone(SECTION_FEMALE_FINGER, 8), 0, AXIS_POS_Z)).toEqual({
      spins: true,
      axis: AXIS_POS_Z,
      freeAboutVertical: false,
    });
  });
});

const CARRY_SIDE_Y = 12;
const CARRY_GRID_STEPS = 24;
const CARRY_STEP_LDU = HALF;
const CARRY_REGISTRY_LDU = 40_000;
const CARRY_WORLD = 170;
const CARRY_SHARES = 4;
const CARRY_FIELD_LDU = 4000;
const CARRY_FIELD_ROWS = 8;
const CARRY_FIELD_PINS = 4;
const CARRY_FIELD_STEPS = 12;
const CARRY_FIELD_MOVE_LDU = STUD_LDU;
const CARRY_MOVES = 20;
const CARRY_TURN_AT = 10;
const CARRY_STEPS_LDU = [10, 20, 20, 40, 10, -20, 160, 20, -10, 20, 300, -20];
const CARRY_OTHER_OPS = 6;
const CARRY_SINGLE_WITHDRAWALS = 3;
const CARRY_FIRST_OWNER = 100;
const CARRY_DEEP_EVERY = 10;
const CARRY_TIMEOUT_MS = 120_000;
const TRACK_RUN = 2;
const LATTICE_FAMILY = 0;
const SPARSE_FAMILY = 1;
const TRACK_FAMILY = 2;
const DROPPED = "dropped mid-carry";

type CarryEnding = "cancel" | "drop" | "drop, undo and redo" | "throw";
type QueryKind = "votes" | "dense" | "proposal" | "evaluate" | "partnered" | "propose" | "rank";

interface CarryKind {
  readonly name: string;
  readonly model: ModelConnectors;
  readonly partner: number;
}

interface Placement {
  readonly kind: number;
  readonly pose: LatticePose;
}

interface Op {
  readonly insert: boolean;
  readonly owner: number;
  readonly model: ModelConnectors;
  readonly pose: LatticePose;
}

interface Query {
  readonly type: QueryKind;
  readonly kind: number;
  readonly pose: LatticePose;
}

type CarriedEntry = readonly [
  number,
  { readonly model: ModelConnectors; readonly pose: LatticePose },
];

interface CarriedMoves {
  readonly entries: ReadonlyArray<CarriedEntry>;
  readonly moves: ReadonlyArray<ReadonlyArray<Query>>;
}

function droppedBy(run: () => unknown): void {
  try {
    run();
  } catch (error) {
    if (error instanceof Error && error.message === DROPPED) return;
    throw error;
  }
  throw new Error(`the carry wasn't ${DROPPED}`);
}

function seededPick(seed: number): (below: number) => number {
  let state = seed >>> 0;
  return (below) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * below);
  };
}

function solverOfThreeFamilies(): ConnectionSolver {
  return new ConnectionSolver([
    new LatticeStudFinder(mating),
    new SparseConnectorFinder(mating),
    new TrackEndFinder(),
  ]);
}

function onAxis(axis: number, x: number, z: number, shapeId: number, gender: number): Spec {
  return { shape: shapeId, gender, origin: [x, HOLE_HEIGHT, z], axis };
}

function straightRun(from: number, heading: number): TrackEnd[] {
  return [
    end([from, 0, 0, 0, 0, 0, 0, 0], (heading + 8) % 16),
    end([from + (heading === 0 ? TRACK_RUN : -TRACK_RUN), 0, 0, 0, 0, 0, 0, 0], heading),
  ];
}

function carryKinds(): ReadonlyArray<CarryKind> {
  const brick = block(2, 4, BRICK_LDU, BRICK_RECEPTOR);
  const pegRow = table(
    Array.from({ length: 4 }, (_, k) =>
      onAxis(AXIS_POS_X, 0, HALF + k * STUD_LDU, PIN, GENDER_MALE),
    ),
  );
  const socketRow = table(
    Array.from({ length: 6 }, (_, k) =>
      onAxis(AXIS_NEG_X, 0, HALF + k * STUD_LDU, PIN_HOLE, GENDER_FEMALE),
    ),
  );
  return [
    { name: "plate", model: single(block(2, 2, PLATE_LDU, PLATE_RECEPTOR)), partner: 3 },
    { name: "brick", model: single(brick), partner: 0 },
    { name: "baseplate", model: single(baseplate(8, 8)), partner: 1 },
    {
      name: "jumper",
      model: single(
        table([
          {
            shape: PLATE_RECEPTOR,
            gender: GENDER_FEMALE,
            origin: [HALF, 0, HALF],
            axis: AXIS_NEG_Y,
          },
          {
            shape: PLATE_RECEPTOR,
            gender: GENDER_FEMALE,
            origin: [HALF + STUD_LDU, 0, HALF],
            axis: AXIS_NEG_Y,
          },
          {
            shape: STUD,
            gender: GENDER_MALE,
            origin: [STUD_LDU, PLATE_LDU, HALF],
            axis: AXIS_POS_Y,
          },
        ]),
      ),
      partner: 0,
    },
    {
      name: "side-studded brick",
      model: single(
        table([
          { shape: STUD, gender: GENDER_MALE, origin: [HALF, BRICK_LDU, HALF], axis: AXIS_POS_Y },
          {
            shape: BRICK_RECEPTOR,
            gender: GENDER_FEMALE,
            origin: [HALF, 0, HALF],
            axis: AXIS_NEG_Y,
          },
          {
            shape: STUD,
            gender: GENDER_MALE,
            origin: [STUD_LDU, CARRY_SIDE_Y, HALF],
            axis: AXIS_POS_X,
          },
        ]),
      ),
      partner: 5,
    },
    {
      name: "side-mounted plate",
      model: single(
        table([
          {
            shape: PLATE_RECEPTOR,
            gender: GENDER_FEMALE,
            origin: [STUD_LDU, CARRY_SIDE_Y, HALF],
            axis: AXIS_NEG_X,
          },
          {
            shape: PLATE_RECEPTOR,
            gender: GENDER_FEMALE,
            origin: [HALF, 0, HALF],
            axis: AXIS_NEG_Y,
          },
        ]),
      ),
      partner: 4,
    },
    {
      name: "pin",
      model: single(table([onAxis(AXIS_POS_X, 0, HALF, PIN, GENDER_MALE)])),
      partner: 7,
    },
    {
      name: "hole",
      model: single(table([onAxis(AXIS_NEG_X, 0, HALF, PIN_HOLE, GENDER_FEMALE)])),
      partner: 6,
    },
    { name: "pin row", model: single(pegRow), partner: 9 },
    { name: "hole row", model: single(socketRow), partner: 8 },
    { name: "track", model: trackModel(straightRun(0, 0)), partner: 11 },
    { name: "facing track", model: trackModel(straightRun(0, 8)), partner: 10 },
    {
      name: "brick with pins",
      model: model(
        [brick, pegRow],
        [
          [0, IDENTITY],
          [1, translation(0, PLATE_LDU, 0)],
        ],
      ),
      partner: 9,
    },
    {
      name: "studded track",
      model: ModelConnectors.fromParts(
        [block(2, 2, PLATE_LDU, PLATE_RECEPTOR)],
        { count: 1, partIndex: [0], matrices: Float64Array.from(IDENTITY) },
        mating,
        straightRun(0, 0),
      ),
      partner: 11,
    },
  ];
}

function reportRows(report: MateReport): string {
  const rows: number[][] = [];
  for (let k = 0; k < report.count; k++) {
    rows.push([
      report.connector[k] ?? 0,
      report.shape[k] ?? 0,
      report.gender[k] ?? 0,
      report.partnerShape[k] ?? 0,
      report.partnerGender[k] ?? 0,
      report.sourceMask[k] ?? 0,
      report.status[k] ?? 0,
      report.family[k] ?? 0,
      report.partner[k] ?? 0,
      report.instance[k] ?? 0,
      report.partnerInstance[k] ?? 0,
      report.joint[k] ?? 0,
      ...report.engagement.subarray(k * ENGAGEMENT_FLOATS, (k + 1) * ENGAGEMENT_FLOATS),
    ]);
  }
  return JSON.stringify([report.jointCount, rows]);
}

function candidateRows(candidates: CandidatePoses): string {
  const rows: number[][] = [];
  for (let k = 0; k < candidates.count; k++) {
    rows.push([
      candidates.x[k] ?? 0,
      candidates.z[k] ?? 0,
      candidates.yPlates[k] ?? 0,
      candidates.rot[k] ?? 0,
      candidates.votes[k] ?? 0,
    ]);
  }
  return JSON.stringify(rows);
}

function answer(
  solver: ConnectionSolver,
  kinds: ReadonlyArray<CarryKind>,
  query: Query,
  report: MateReport,
): string {
  const piece = kinds[query.kind]?.model;
  if (!piece) throw new Error(`no carry kind ${query.kind}`);
  const candidates = new CandidatePoses();
  switch (query.type) {
    case "votes":
      return `votes ${solver.votes(piece, query.pose)}`;
    case "dense":
      return `dense ${solver.denseVotes(piece, query.pose)}`;
    case "proposal":
      return `proposal ${solver.proposalVotes(piece, query.pose)}`;
    case "evaluate":
      solver.evaluate(piece, query.pose, report);
      return reportRows(report);
    case "partnered":
      solver.partneredMates(piece, query.pose, report);
      return reportRows(report);
    case "propose":
      solver.proposeMates(piece, window(query.pose, 1, 1, 2), candidates);
      return candidateRows(candidates);
    case "rank":
      solver.rank(piece, window(query.pose, 1, 0), candidates);
      return candidateRows(candidates);
    default: {
      const unhandled: never = query.type;
      throw new Error(`unhandled query ${String(unhandled)}`);
    }
  }
}

function turnedAbout(at: LatticePose, pivot: LatticePose): LatticePose {
  return {
    x: pivot.x + (at.z - pivot.z),
    z: pivot.z - (at.x - pivot.x),
    yPlates: at.yPlates,
    rot: (at.rot + 1) % 4,
  };
}

class CarryRun {
  readonly subject = solverOfThreeFamilies();
  readonly oracle = solverOfThreeFamilies();
  readonly ops: Op[] = [];
  readonly subjectLog: string[] = [];
  readonly oracleLog: string[] = [];
  readonly world = new Map<number, Placement>();
  readonly field: number[] = [];
  readonly holeRows: number[] = [];
  readonly families = new Set<number>();
  readonly report = new MateReport();
  halfStudLattice = 0;
  sideStudSparse = 0;
  stackedTrackHolders = 0;
  chainWitnesses = 0;
  private nextOwner = CARRY_FIRST_OWNER;

  constructor(
    readonly kinds: ReadonlyArray<CarryKind>,
    readonly pick: (below: number) => number,
  ) {
    kinds.forEach((_, k) => this.place(1 + k, k, pose(CARRY_REGISTRY_LDU + k * 2000, 0, 0)));
  }

  randomPlacement(): Placement {
    const kind = this.pick(this.kinds.length);
    const step = this.kinds[kind]?.model.trackEndCount === 0 ? CARRY_STEP_LDU : STUD_LDU;
    const steps = (CARRY_GRID_STEPS * CARRY_STEP_LDU) / step;
    return {
      kind,
      pose: pose(
        this.pick(steps) * step,
        this.pick(steps) * step,
        this.pick(4),
        this.pick(4) as QuarterTurn,
      ),
    };
  }

  populate(count: number): void {
    const placed: Placement[] = [];
    for (let k = 0; k < count; k++) {
      const share = this.pick(CARRY_SHARES);
      const twin = placed[this.pick(placed.length)];
      const placement: Placement =
        twin && share === 0
          ? twin
          : twin && share === 1
            ? {
                kind: STACKED_KINDS[this.pick(STACKED_KINDS.length)] ?? 0,
                pose: {
                  ...twin.pose,
                  x: twin.pose.x + this.pick(2) * HALF,
                  yPlates: twin.pose.yPlates + 1 + 2 * this.pick(2),
                },
              }
            : this.randomPlacement();
      placed.push(placement);
      this.placeNew(placement.kind, placement.pose);
    }
    for (let row = 0; row < CARRY_FIELD_PINS; row++) {
      this.field.push(this.nextOwner);
      this.placeNew(PIN_ROW_KIND, this.fieldPose());
    }
  }

  relayField(): void {
    for (const owner of this.holeRows) if (this.world.has(owner)) this.lift(owner);
    this.holeRows.length = 0;
    for (let row = 0; row < CARRY_FIELD_ROWS; row++) {
      this.holeRows.push(this.nextOwner);
      this.placeNew(HOLE_ROW_KIND, this.fieldPose());
    }
  }

  fieldPose(): LatticePose {
    return pose(
      CARRY_FIELD_LDU + this.pick(CARRY_FIELD_STEPS) * HALF,
      this.pick(CARRY_FIELD_STEPS) * STUD_LDU,
      0,
    );
  }

  survey(): void {
    const everyModel = [...this.world.values()].flatMap((placed) => [
      ...queriesAt(placed.pose, placed.kind, false),
      ...queriesAt(placed.pose, this.kinds[placed.kind]?.partner ?? 0, false),
    ]);
    this.ask(everyModel, null);
  }

  placeNew(kind: number, at: LatticePose): void {
    this.place(this.nextOwner++, kind, at);
  }

  place(owner: number, kind: number, at: LatticePose): void {
    const piece = this.model(kind);
    this.subject.insert(piece, at, owner);
    this.oracle.insert(piece, at, owner);
    this.ops.push({ insert: true, owner, model: piece, pose: at });
    this.world.set(owner, { kind, pose: at });
  }

  lift(owner: number): void {
    const placed = this.world.get(owner);
    if (!placed) throw new Error(`owner ${owner} isn't placed`);
    const piece = this.model(placed.kind);
    this.subject.remove(piece, placed.pose, owner);
    this.oracle.remove(piece, placed.pose, owner);
    this.ops.push({ insert: false, owner, model: piece, pose: placed.pose });
    this.world.delete(owner);
  }

  model(kind: number): ModelConnectors {
    const piece = this.kinds[kind]?.model;
    if (!piece) throw new Error(`no carry kind ${kind}`);
    return piece;
  }

  movable(): number[] {
    return [...this.world.keys()].filter((owner) => owner >= CARRY_FIRST_OWNER);
  }

  entry(owner: number): CarriedEntry {
    const placed = this.world.get(owner);
    if (!placed) throw new Error(`owner ${owner} isn't placed`);
    return [owner, { model: this.model(placed.kind), pose: placed.pose }];
  }

  line(solver: ConnectionSolver, query: Query): string {
    const asked = answer(solver, this.kinds, query, this.report);
    return `${query.type} ${this.kinds[query.kind]?.name} ${JSON.stringify(query.pose)}: ${asked}`;
  }

  subjectAnswers(queries: ReadonlyArray<Query>, held: ReadonlySet<number> | null): void {
    for (const query of queries) {
      this.subjectLog.push(this.line(this.subject, query));
      if (query.type === "evaluate" || query.type === "partnered") this.tally(query, held);
    }
  }

  oracleAnswers(queries: ReadonlyArray<Query>): void {
    for (const query of queries) this.oracleLog.push(this.line(this.oracle, query));
  }

  ask(queries: ReadonlyArray<Query>, held: ReadonlySet<number> | null): void {
    this.subjectAnswers(queries, held);
    this.oracleAnswers(queries);
  }

  private tally(query: Query, held: ReadonlySet<number> | null): void {
    const report = this.report;
    const owners = new Map<number, Set<number>>();
    for (let k = 0; k < report.count; k++) {
      const family = report.family[k] ?? 0;
      this.families.add(family);
      if (
        family === LATTICE_FAMILY &&
        report.gender[k] === GENDER_MALE &&
        this.kinds[query.kind]?.name === "jumper"
      ) {
        this.halfStudLattice++;
      }
      if (
        family === SPARSE_FAMILY &&
        (report.shape[k] === STUD || report.partnerShape[k] === STUD)
      ) {
        this.sideStudSparse++;
      }
      const connector = report.connector[k] ?? 0;
      const named = owners.get(connector) ?? new Set<number>();
      named.add(report.partner[k] ?? NO_PARTNER);
      owners.set(connector, named);
      if (family === TRACK_FAMILY && named.size >= 2) this.stackedTrackHolders++;
    }
    if (!held) return;
    for (const named of owners.values()) {
      let fromHeld = 0;
      for (const owner of named) if (held.has(owner)) fromHeld++;
      if (fromHeld >= 2) this.chainWitnesses++;
    }
  }

  carry(size: number, ending: CarryEnding, inField: boolean): CarriedMoves {
    const owners = inField ? this.field.filter((owner) => this.world.has(owner)) : this.movable();
    const held: number[] = [];
    while (held.length < Math.min(size, owners.length)) {
      const owner = owners[this.pick(owners.length)];
      if (owner !== undefined && !held.includes(owner)) held.push(owner);
    }
    const entries = held.map((owner) => this.entry(owner));
    const pivot = entries[0]?.[1].pose ?? pose(0, 0, 0);
    let targets = entries.map(([, placed]) => placed.pose);
    const moves: Query[][] = [];
    for (let move = 0; move < CARRY_MOVES; move++) {
      const step = inField
        ? (this.pick(3) - 1) * CARRY_FIELD_MOVE_LDU
        : (CARRY_STEPS_LDU[move % CARRY_STEPS_LDU.length] ?? STUD_LDU);
      targets = targets.map((at) =>
        move % 2 === 0 ? { ...at, x: at.x + step } : { ...at, z: at.z + step },
      );
      if (move === CARRY_TURN_AT) targets = targets.map((at) => turnedAbout(at, pivot));
      const asked = targets.flatMap((at, i) =>
        queriesAt(
          at,
          this.world.get(held[i] ?? 0)?.kind ?? 0,
          i % CARRY_DEEP_EVERY === 0 && (!inField || move === 0),
        ),
      );
      moves.push(asked);
      const throws = ending === "throw" && move === CARRY_MOVES - 1;
      if (throws) {
        droppedBy(() =>
          this.subject.withdrawn(entries, () => {
            this.subjectAnswers(asked, null);
            throw new Error(DROPPED);
          }),
        );
      } else {
        this.subject.withdrawn(entries, () => this.subjectAnswers(asked, null));
      }
      this.eagerly(entries, asked, throws);
    }
    if (ending === "drop" || ending === "drop, undo and redo") {
      const from = entries.map(([, placed]) => placed.pose);
      this.relay(held, from, targets);
      if (ending === "drop, undo and redo") {
        this.relay(held, targets, from);
        this.relay(held, from, targets);
      }
    }
    const restored = ending === "cancel" || ending === "throw";
    const after = held.flatMap((owner) => {
      const placed = this.world.get(owner);
      if (!placed) return [];
      return [
        ...queriesAt(placed.pose, placed.kind, false),
        ...queriesAt(placed.pose, this.kinds[placed.kind]?.partner ?? 0, false),
      ];
    });
    this.ask(after, restored ? new Set(held) : null);
    return { entries, moves };
  }

  singleWithdrawals(count: number): void {
    const owners = this.movable();
    for (let k = 0; k < count; k++) {
      const owner = owners[this.pick(owners.length)];
      const placed = owner === undefined ? undefined : this.world.get(owner);
      if (owner === undefined || !placed) continue;
      const entries = [this.entry(owner)];
      const asked = queriesAt(placed.pose, this.kinds[placed.kind]?.partner ?? 0, true);
      this.subject.withdrawn(entries, () => this.subjectAnswers(asked, null));
      this.eagerly(entries, asked, false);
    }
  }

  otherEdits(count: number): void {
    for (let k = 0; k < count; k++) {
      const owners = this.movable();
      const owner = owners[this.pick(owners.length)];
      if (this.pick(2) === 0 && owner !== undefined) this.lift(owner);
      else {
        const placement = this.randomPlacement();
        this.placeNew(placement.kind, placement.pose);
      }
    }
  }

  private relay(
    held: ReadonlyArray<number>,
    from: ReadonlyArray<LatticePose>,
    to: ReadonlyArray<LatticePose>,
  ): void {
    held.forEach((owner, i) => {
      const kind = this.world.get(owner)?.kind ?? 0;
      const at = from[i];
      if (!at) return;
      const piece = this.model(kind);
      this.subject.remove(piece, at, owner);
      this.oracle.remove(piece, at, owner);
      this.ops.push({ insert: false, owner, model: piece, pose: at });
    });
    held.forEach((owner, i) => {
      const kind = this.world.get(owner)?.kind ?? 0;
      const at = to[i];
      if (at) this.place(owner, kind, at);
    });
  }

  private eagerly(
    entries: ReadonlyArray<CarriedEntry>,
    asked: ReadonlyArray<Query>,
    throws: boolean,
  ): void {
    for (const [owner, placed] of entries) {
      this.oracle.remove(placed.model, placed.pose, owner);
      this.ops.push({ insert: false, owner, model: placed.model, pose: placed.pose });
    }
    try {
      this.oracleAnswers(asked);
      if (throws) throw new Error(DROPPED);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== DROPPED) throw error;
    } finally {
      for (const [owner, placed] of entries) {
        this.oracle.insert(placed.model, placed.pose, owner);
        this.ops.push({ insert: true, owner, model: placed.model, pose: placed.pose });
      }
    }
  }
}

const STACKED_KINDS = [0, 1, 3];
const PIN_ROW_KIND = 8;
const HOLE_ROW_KIND = 9;

function queriesAt(at: LatticePose, kind: number, deep: boolean): Query[] {
  const types: ReadonlyArray<QueryKind> = deep
    ? ["votes", "evaluate", "partnered", "propose", "rank"]
    : ["votes", "evaluate"];
  return types.map((type) => ({ type, kind, pose: at }));
}

function replayed(
  ops: ReadonlyArray<Op>,
  upto: number,
  withdrawn: ReadonlyArray<CarriedEntry>,
): ConnectionSolver {
  const solver = solverOfThreeFamilies();
  for (let k = 0; k < upto; k++) {
    const op = ops[k];
    if (!op) continue;
    if (op.insert) solver.insert(op.model, op.pose, op.owner);
    else solver.remove(op.model, op.pose, op.owner);
  }
  for (const [owner, placed] of withdrawn) solver.remove(placed.model, placed.pose, owner);
  return solver;
}

function hasSkipWitness(run: CarryRun, opsAtStart: number, carried: CarriedMoves): boolean {
  const report = new MateReport();
  const { entries, moves } = carried;
  for (let move = 1; move < moves.length; move++) {
    const asked = moves[move] ?? [];
    for (let q = 0; q < asked.length; q++) {
      const query = asked[q];
      if (!query || query.type !== "evaluate") continue;
      const warm = replayed(run.ops, opsAtStart, entries);
      for (let earlier = 0; earlier < move; earlier++) {
        for (const before of moves[earlier] ?? []) answer(warm, run.kinds, before, report);
      }
      const cold = replayed(run.ops, opsAtStart, entries);
      for (let k = 0; k < q; k++) {
        const before = asked[k];
        if (!before) continue;
        answer(warm, run.kinds, before, report);
        answer(cold, run.kinds, before, report);
      }
      if (answer(warm, run.kinds, query, report) !== answer(cold, run.kinds, query, report))
        return true;
    }
  }
  return false;
}

function firstDifference(subject: ReadonlyArray<string>, oracle: ReadonlyArray<string>): unknown {
  for (let k = 0; k < Math.max(subject.length, oracle.length); k++) {
    if (subject[k] !== oracle[k]) return { at: k, subject: subject[k], oracle: oracle[k] };
  }
  return null;
}

const CARRY_PLAN: ReadonlyArray<readonly [number, CarryEnding, boolean]> = [
  [1, "cancel", true],
  [10, "drop", false],
  [1, "throw", true],
  [100, "cancel", false],
  [1, "drop", true],
  [1, "drop, undo and redo", false],
  [4, "cancel", true],
  [10, "throw", false],
  [1, "cancel", true],
  [100, "drop, undo and redo", false],
  [1, "throw", true],
  [1, "throw", false],
  [1, "drop, undo and redo", true],
  [10, "cancel", false],
  [1, "cancel", true],
  [100, "throw", false],
  [1, "drop", false],
  [1, "cancel", true],
  [10, "drop, undo and redo", false],
  [100, "drop", false],
];

describe("ConnectionSolver withdrawals", () => {
  it(
    "answers every query of generated carries of 1, 10 and 100 models, of studs, jumpers, side studs, pins in hole rows, track and multi-part models, turned mid-carry and then dropped, cancelled, undone and redone or thrown out of, exactly as removing and re-inserting the carried models around each move does",
    () => {
      const run = new CarryRun(carryKinds(), seededPick(20261125));
      run.populate(CARRY_WORLD);
      run.survey();
      let skipped = false;
      for (const [size, ending, inField] of CARRY_PLAN) {
        run.otherEdits(CARRY_OTHER_OPS);
        run.singleWithdrawals(CARRY_SINGLE_WITHDRAWALS);
        if (inField) run.relayField();
        const opsAtStart = run.ops.length;
        const carried = run.carry(size, ending, inField);
        if (!skipped && inField) skipped = hasSkipWitness(run, opsAtStart, carried);
      }
      run.survey();
      expect(firstDifference(run.subjectLog, run.oracleLog)).toBeNull();
      expect({
        families: [...run.families].toSorted((a, b) => a - b),
        halfStudLatticeMates: run.halfStudLattice > 0,
        sideStudMates: run.sideStudSparse > 0,
        trackHoldersTwoDeep: run.stackedTrackHolders > 0,
        restoredOrderSeen: run.chainWitnesses > 0,
        skippedMoveOrderSeen: skipped,
      }).toEqual({
        families: [LATTICE_FAMILY, SPARSE_FAMILY, TRACK_FAMILY],
        halfStudLatticeMates: true,
        sideStudMates: true,
        trackHoldersTwoDeep: true,
        restoredOrderSeen: true,
        skippedMoveOrderSeen: true,
      });
    },
    CARRY_TIMEOUT_MS,
  );

  it("pays the restore it owes before withdrawing the same owners from poses they don't hold, then refuses as removing them there does", () => {
    const brick = single(block(2, 4, BRICK_LDU, BRICK_RECEPTOR));
    const plate = single(block(2, 2, PLATE_LDU, PLATE_RECEPTOR));
    const placed = pose(0, 0, 0);
    const elsewhere = pose(STUD_LDU, 0, 0);
    const above = pose(0, 0, 3);
    const subject = solverOfThreeFamilies();
    const oracle = solverOfThreeFamilies();
    for (const solver of [subject, oracle]) {
      solver.insert(brick, placed, 1);
      solver.insert(plate, above, 2);
    }
    subject.withdrawn([[1, { model: brick, pose: placed }]], () => subject.votes(plate, above));
    oracle.remove(brick, placed, 1);
    oracle.votes(plate, above);
    oracle.insert(brick, placed, 1);
    expect(() =>
      subject.withdrawn([[1, { model: brick, pose: elsewhere }]], () =>
        subject.votes(plate, above),
      ),
    ).toThrow(RangeError);
    expect(() => oracle.remove(brick, elsewhere, 1)).toThrow(RangeError);
    expect(reportRows(evaluated(subject, plate, above))).toBe(
      reportRows(evaluated(oracle, plate, above)),
    );
  });
});

const HOVER_SEED = 20261127;
const HOVER_STEPS = 16;
const HOVER_HEIGHTS = [0, 3, 1, 6, 2, 4];
const HOVER_TURN_EVERY = 3;
const HOVER_EDIT_EVERY = 6;
const HOVER_EDITS = 2;
const HOVER_QUERIES: ReadonlyArray<QueryKind> = [
  "dense",
  "proposal",
  "votes",
  "evaluate",
  "propose",
];
const HOVER_STACK_X_LDU = -20_000;
const HOVER_STACK_PLATES = 513;
const HOVER_STACK_REPEATS = 24;
const PLATE_KIND = 0;

describe("ConnectionSolver hovers", () => {
  it(
    "answers every query of generated hovers, of studs, jumpers, side studs, pins in hole rows and multi-part models, held at alternating heights and turns, with placements added and removed between queries, exactly as a solver replayed from the same edits that has answered no earlier query",
    () => {
      const run = new CarryRun(carryKinds(), seededPick(HOVER_SEED));
      run.populate(CARRY_WORLD);
      const subjectLog: string[] = [];
      const oracleLog: string[] = [];
      const ask = (query: Query): string => {
        const asked = run.line(run.subject, query);
        subjectLog.push(asked);
        oracleLog.push(run.line(replayed(run.ops, run.ops.length, []), query));
        return asked;
      };
      let denseAnswered = 0;
      let proposed = 0;
      for (let kind = 0; kind < run.kinds.length; kind++) {
        const anchors = [...run.world.values()];
        const anchor = anchors[run.pick(anchors.length)]?.pose ?? pose(0, 0, 0);
        let at = anchor;
        for (let step = 0; step < HOVER_STEPS; step++) {
          const stride = run.pick(2) === 0 ? HALF : STUD_LDU;
          at = {
            x: at.x + (step % 2 === 0 ? stride : 0),
            z: at.z + (step % 2 === 0 ? 0 : stride),
            yPlates: anchor.yPlates + (HOVER_HEIGHTS[step % HOVER_HEIGHTS.length] ?? 0),
            rot: step % HOVER_TURN_EVERY === 0 ? (at.rot + 1) % 4 : at.rot,
          };
          if (step % HOVER_EDIT_EVERY === HOVER_EDIT_EVERY - 1) run.otherEdits(HOVER_EDITS);
          for (const type of HOVER_QUERIES) {
            const asked = ask({ type, kind, pose: at });
            if (type === "dense" && !asked.endsWith(": dense 0")) denseAnswered++;
            if (type === "propose" && !asked.endsWith(": []")) proposed++;
          }
        }
      }
      for (let level = 0; level < HOVER_STACK_PLATES; level++) {
        run.placeNew(PLATE_KIND, pose(HOVER_STACK_X_LDU, 0, level));
      }
      let stackCounted = 0;
      const stackHeights = [
        ...Array.from({ length: HOVER_STACK_PLATES }, (_, level) => level + 1),
        ...Array.from({ length: HOVER_STACK_REPEATS }, (_, level) => level + 1),
      ];
      for (const yPlates of stackHeights) {
        const asked = ask({
          type: "dense",
          kind: PLATE_KIND,
          pose: pose(HOVER_STACK_X_LDU, 0, yPlates),
        });
        if (!asked.endsWith(": dense 0")) stackCounted++;
      }
      expect({
        difference: firstDifference(subjectLog, oracleLog),
        denseVotesAnswered: denseAnswered > 0,
        latticeProposalsMade: proposed > 0,
        stackHeightsCounted: stackCounted,
      }).toEqual({
        difference: null,
        denseVotesAnswered: true,
        latticeProposalsMade: true,
        stackHeightsCounted: stackHeights.length,
      });
    },
    CARRY_TIMEOUT_MS,
  );
});

function makeHole(): ModelConnectors {
  return single(table([onAxis(AXIS_NEG_X, 0, HALF, PIN_HOLE, GENDER_FEMALE)]));
}

function makeHoleRow(): ModelConnectors {
  return single(
    table(
      Array.from({ length: 6 }, (_, k) =>
        onAxis(AXIS_NEG_X, 0, HALF + k * STUD_LDU, PIN_HOLE, GENDER_FEMALE),
      ),
    ),
  );
}

function makePlate(): ModelConnectors {
  return single(block(2, 2, PLATE_LDU, PLATE_RECEPTOR));
}

function makeBrick(): ModelConnectors {
  return single(block(2, 2, BRICK_LDU, BRICK_RECEPTOR));
}

function makePin(length: number): () => ModelConnectors {
  return () =>
    single(
      table([
        onAxis(
          AXIS_POS_X,
          0,
          HALF,
          shape(CAP_ROOT, false, [[SECTION_ROUND, 6, length]]),
          GENDER_MALE,
        ),
      ]),
    );
}

describe("ConnectionSolver turned models", () => {
  it(
    "answers from a turned model it cached, rebuilt once its finders know more mate classes, exactly as an identical model turned for the first time does",
    () => {
      const pick = seededPick(20261126);
      const copies = new Map<ModelConnectors, () => ModelConnectors>();
      const made = (make: () => ModelConnectors): ModelConnectors => {
        const piece = make();
        copies.set(piece, make);
        return piece;
      };
      const hole = made(makeHole);
      const holeRow = made(makeHoleRow);
      const plate = made(makePlate);
      const brick = made(makeBrick);
      const pins = GROWN_PIN_LENGTHS.map((length) => made(makePin(length)));
      const cachedEarly = [hole, holeRow];
      const known: ModelConnectors[] = [hole, holeRow, plate, brick];
      const partnerOf = (piece: ModelConnectors): ModelConnectors => {
        if (piece === plate) return brick;
        if (piece === brick) return plate;
        if (cachedEarly.includes(piece))
          return known.findLast((other) => pins.includes(other)) ?? brick;
        return hole;
      };
      const nearby = (): LatticePose =>
        pose(
          pick(GROWN_FIELD_STEPS) * HALF,
          pick(GROWN_FIELD_STEPS) * STUD_LDU,
          0,
          (pick(4) === 0 ? pick(4) : 0) as QuarterTurn,
        );
      const subject = solverOfThreeFamilies();
      const inserted: Op[] = [];
      const insert = (piece: ModelConnectors): void => {
        const op = { insert: true, owner: inserted.length + 1, model: piece, pose: nearby() };
        inserted.push(op);
        subject.insert(op.model, op.pose, op.owner);
      };
      for (const piece of known) insert(piece);
      const subjectLog: string[] = [];
      const oracleLog: string[] = [];
      const report = new MateReport();
      let grownClassesProposed = 0;
      for (let step = 0; step < GROWN_STEPS; step++) {
        const grown = pins[Math.floor(step / GROWN_STEPS_PER_PIN)];
        if (grown && !known.includes(grown)) {
          known.push(grown);
          insert(grown);
        } else if (pick(2) === 0) {
          insert(known[pick(known.length)] ?? hole);
        }
        const pinned = inserted.filter((op) => pins.includes(op.model));
        const onPin = pinned[pick(pinned.length)];
        const asked =
          onPin && pick(2) === 0
            ? (cachedEarly[pick(cachedEarly.length)] ?? hole)
            : (known[pick(known.length)] ?? hole);
        const at = onPin && cachedEarly.includes(asked) ? onPin.pose : nearby();
        subject.evaluate(partnerOf(asked), at, report);
        const oracle = solverOfThreeFamilies();
        for (const op of inserted) oracle.insert(op.model, op.pose, op.owner);
        const copy = (copies.get(asked) ?? makeHole)();
        for (const type of GROWN_QUERIES) {
          const query = { type, kind: 0, pose: at };
          const subjectAnswer = answer(
            subject,
            [{ name: "asked", model: asked, partner: 0 }],
            query,
            report,
          );
          const oracleAnswer = answer(
            oracle,
            [{ name: "copy", model: copy, partner: 0 }],
            query,
            report,
          );
          subjectLog.push(`${step} ${type}: ${subjectAnswer}`);
          oracleLog.push(`${step} ${type}: ${oracleAnswer}`);
          if (type === "propose" && onPin && at === onPin.pose && oracleAnswer !== "[]") {
            grownClassesProposed++;
          }
        }
      }
      expect({
        difference: firstDifference(subjectLog, oracleLog),
        grownClassesProposed: grownClassesProposed > 0,
      }).toEqual({ difference: null, grownClassesProposed: true });
    },
    PROPERTY_TIMEOUT_MS,
  );
});

const GROWN_PIN_LENGTHS = [8, 12, 16, 4];
const GROWN_STEPS = 96;
const GROWN_STEPS_PER_PIN = 24;
const GROWN_FIELD_STEPS = 6;
const GROWN_QUERIES: ReadonlyArray<QueryKind> = [
  "evaluate",
  "votes",
  "partnered",
  "propose",
  "rank",
];

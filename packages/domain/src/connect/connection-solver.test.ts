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
import type { TrackEnd } from "../track/end-gaps.ts";
import { CandidatePoses, type LatticePose, type SnapWindow } from "./candidate-poses.ts";
import { ConnectionSolver } from "./connection-solver.ts";
import {
  AXIS_NEG_X,
  AXIS_NEG_Y,
  AXIS_POS_X,
  AXIS_POS_Y,
  ConnectorTable,
  GENDER_FEMALE,
  GENDER_MALE,
  SOURCE_INFERRED,
  SOURCE_PATCH,
  SOURCE_SHADOW,
  STATUS_UNVERIFIED,
  STATUS_VERIFIED,
} from "./connector-table.ts";
import { LatticeStudFinder } from "./lattice-stud-finder.ts";
import { MateReport } from "./mate-report.ts";
import { SnapMating } from "./mating.ts";
import { ModelConnectors } from "./model-connectors.ts";
import { IDENTIFICATION_RESIDUAL_LDU, MODEL_ROOT } from "./submodel-frames.ts";
import { SparseConnectorFinder } from "./sparse-connector-finder.ts";
import { TrackEndFinder } from "./track-end-finder.ts";
import {
  CAP_FAR,
  CAP_ROOT,
  SECTION_AXLE,
  SECTION_ROUND,
  SECTION_SQUARE,
  SECTION_FLARE_JOINS_NEXT,
  SECTION_FLARE_JOINS_PREVIOUS,
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

function table(specs: ReadonlyArray<Spec>): ConnectorTable {
  return new ConnectorTable(
    Uint16Array.from(specs, (s) => s.shape),
    Uint8Array.from(specs, (s) => s.gender),
    Uint8Array.from(specs, (s) => s.source ?? SOURCE_SHADOW),
    Uint8Array.from(specs, (s) => s.status ?? STATUS_VERIFIED),
    Float32Array.from(specs.flatMap((s) => s.origin)),
    Int8Array.from(specs, (s) => s.axis),
    new Float32Array(specs.length * 3),
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
  );
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
    engine.insert(single(baseplate(width, width)), pose(0, 0, 0));
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
    engine.insert(single(baseplate(4, 4)), pose(0, 0, 0));
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
    engine.insert(single(baseplate(8, 8)), pose(0, 0, 0));
    const brick = single(block(2, 2, BRICK_LDU, BRICK_RECEPTOR));
    engine.insert(brick, pose(2 * STUD_LDU, 2 * STUD_LDU, 0));
    const plate = single(block(2, 2, PLATE_LDU, PLATE_RECEPTOR));
    const candidates = new CandidatePoses();
    engine.rank(plate, window(pose(2 * STUD_LDU, 2 * STUD_LDU, 2), 0, 1), candidates);
    expect([candidates.yPlates[0], candidates.votes[0]]).toEqual([BRICK_LDU / PLATE_LDU, 4]);
  });

  it("keeps a connector placed twice until both placements are removed", () => {
    const engine = latticeOnly();
    const base = single(baseplate(2, 2));
    const plate = single(block(2, 2, PLATE_LDU, PLATE_RECEPTOR));
    engine.insert(base, pose(0, 0, 0));
    engine.insert(base, pose(0, 0, 0));
    engine.remove(base, pose(0, 0, 0));
    expect(matesAt(engine, plate, pose(0, 0, 0))).toBe(4);
    engine.remove(base, pose(0, 0, 0));
    expect(matesAt(engine, plate, pose(0, 0, 0))).toBe(0);
    expect(() => engine.remove(base, pose(0, 0, 0))).toThrow(RangeError);
  });

  it("mates a half-stud offset connector only at the offset that puts it on the lattice", () => {
    const engine = latticeOnly();
    engine.insert(single(baseplate(4, 4)), pose(0, 0, 0));
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
    engine.insert(single(table(receptors)), pose(-STUD_LDU, -STUD_LDU, 0));
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
    engine.insert(single(baseplate(1, 1)), pose(0, 0, 0));
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
      engine.insert(single(withProvenance(baseplate(2, 2), placed[0], placed[1])), pose(0, 0, 0));
      engine.insert(single(withProvenance(edgeHoles(), placed[0], placed[1])), pose(0, 0, 0));
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

describe("ModelConnectors", () => {
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
    engine.insert(stack, pose(0, 0, 0));
    const piece = single(plate);
    expect(matesAt(engine, piece, pose(0, 0, 1))).toBe(0);
    expect(matesAt(engine, piece, pose(0, 0, 2))).toBe(4);
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

describe("ConnectionSolver with sparse connectors", () => {
  it("snaps a model to the pose where its edge pins enter a neighbour's holes, not a stud away", () => {
    const solver = allFamilies();
    solver.insert(single(edgeHoles()), pose(0, 0, 0));
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
    solver.insert(single(edgeHoles()), pose(0, 0, 0));
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
    solver.insert(single(edgeHoles()), pose(0, 0, 0));
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
    solver.insert(single(baseplate(4, 4)), pose(0, 0, 0));
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
    solver.insert(jumper, pose(STUD_LDU, STUD_LDU, 0));
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
    solver.insert(single(baseplate(4, 4)), pose(0, 0, 0));
    solver.insert(single(edgeHoles()), pose(0, 0, 0));
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
    solver.insert(holes, pose(0, 0, 0));
    solver.insert(holes, pose(0, 0, 0));
    solver.remove(holes, pose(0, 0, 0));
    expect(matesAt(solver, pins, pose(-NEIGHBOUR_WIDTH_LDU, 0, 0))).toBe(EDGE_ROWS.length);
    solver.remove(holes, pose(0, 0, 0));
    expect(matesAt(solver, pins, pose(-NEIGHBOUR_WIDTH_LDU, 0, 0))).toBe(0);
    expect(() => solver.remove(holes, pose(0, 0, 0))).toThrow(RangeError);
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

function trackModel(ends: ReadonlyArray<TrackEnd>): ModelConnectors {
  return ModelConnectors.fromParts(
    [],
    { count: 0, partIndex: [], matrices: new Float64Array(0) },
    mating,
    ends,
  );
}

function end(coefficients: ReadonlyArray<number>, heading: number, yPlates = 0): TrackEnd {
  return { pose: pose16(zeta16(coefficients.map((c) => BigInt(c))), heading), yPlates };
}

function placedEnd(at: LatticePose, local: TrackEnd): TrackEnd {
  const frame = pose16(
    zeta16([at.x / STUD_LDU, 0, 0, 0, at.z / STUD_LDU, 0, 0, 0].map(BigInt)),
    -4 * at.rot,
  );
  return { pose: composePose16(frame, local.pose), yPlates: local.yPlates + at.yPlates };
}

describe("ConnectionSolver with track ends", () => {
  it("joins track ends exactly where their ℤ[ζ₁₆] poses meet, including off-lattice curve ends", () => {
    const solver = new ConnectionSolver([new TrackEndFinder()]);
    const curveExit = [0, 0, 0, 40, -40, 0, 0, 0];
    solver.insert(
      trackModel([end([10, 0, 0, 0, 0, 0, 0, 0], 0), end(curveExit, 2)]),
      pose(0, 0, 0),
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
      solver.insert(trackModel(local), at);
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

  it("seats a male wherever the next move along the axis meets a section that doesn't fit or a stop", () => {
    const collaredPin = shape(0, false, [
      [SECTION_ROUND, 6, 4],
      [SECTION_ROUND, 8, 2],
      [SECTION_ROUND, 6, 16],
    ]);
    expect(mating.offsets(collaredPin, through(SECTION_ROUND, 6))).toEqual(offsetsInLdu(-4, 6));
    const boreInTwoHalves = shape(0, false, [
      [SECTION_ROUND, 6, 4],
      [SECTION_ROUND, 6, 4],
    ]);
    expect(mating.offsets(collaredPin, boreInTwoHalves)).toEqual(offsetsInLdu(-4, 6));
    const shallowReceptor = shape(CAP_FAR, false, [[SECTION_ROUND, 6, 2]]);
    expect(mating.offsets(STUD, shallowReceptor)).toEqual(offsetsInLdu(2));
    const barHeldAtBothEnds = shape(CAP_ROOT | CAP_FAR, false, [[SECTION_ROUND, 4, 12]]);
    const sleeve = shape(0, false, [[SECTION_ROUND, 4, 4]]);
    expect(mating.offsets(barHeldAtBothEnds, sleeve)).toEqual(offsetsInLdu(0, 8));
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
    engine.insert(carEnd, pose(0, 0, 0));
    const facing = single(facePair(AXIS_NEG_X));
    expect(matesAt(engine, facing, pose(0, 0, 0))).toBe(2);
    expect(matesAt(engine, facing, pose(STUD_LDU, 0, 0))).toBe(0);
    expect(matesAt(engine, single(facePair(AXIS_POS_X)), pose(0, 0, 0))).toBe(0);
  });

  it("mate a face measured off whole LDU, at 136/16 LDU, with its opposite at the coincident pose only, never with one a sixteenth away", () => {
    const measured = 136 / SIXTEENTHS_PER_LDU;
    const engine = allFamilies();
    engine.insert(single(facePair(AXIS_POS_X, measured)), pose(0, 0, 0));
    engine.insert(single(facePair(AXIS_POS_X, 137 / SIXTEENTHS_PER_LDU)), pose(0, 0, 0));
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
      0, 0, 0, 2,
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
    expect(mating.offsets(lipped(0), roundThenSquare)).toEqual(offsetsInLdu(-10, 0));
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

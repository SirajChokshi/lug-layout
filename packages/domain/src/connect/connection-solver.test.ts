import { describe, expect, it } from "vitest";
import { PLATE_LDU, STUD_LDU, rot90Cos, rot90Sin } from "@brr/math";
import { CandidatePoses, type LatticePose, type SnapWindow } from "./candidate-poses.ts";
import { ConnectionSolver } from "./connection-solver.ts";
import {
  ConnectorTable,
  GENDER_FEMALE,
  GENDER_MALE,
  PROFILE_CROSS,
  PROFILE_ROUND,
} from "./connector-table.ts";
import { LatticeStudFinder } from "./lattice-stud-finder.ts";
import { MateReport } from "./mate-report.ts";
import { ModelConnectors } from "./model-connectors.ts";

interface Spec {
  readonly profile?: number;
  readonly gender: number;
  readonly radius?: number;
  readonly origin: readonly [number, number, number];
  readonly axis: readonly [number, number, number];
  readonly reach: number;
}

type QuarterTurn = 0 | 1 | 2 | 3;

const STUD_RADIUS = 6;
const BAR_RADIUS = 4;
const STUD_REACH = 4;
const PLATE_CAVITY = 4;
const BRICK_LDU = 3 * PLATE_LDU;
const BRICK_CAVITY = BRICK_LDU - STUD_REACH;
const HALF = STUD_LDU / 2;
const UP = [0, 1, 0] as const;
const DOWN = [0, -1, 0] as const;

function table(specs: ReadonlyArray<Spec>): ConnectorTable {
  return new ConnectorTable(
    Uint8Array.from(specs, (s) => s.profile ?? PROFILE_ROUND),
    Uint8Array.from(specs, (s) => s.gender),
    Float32Array.from(specs, (s) => s.radius ?? STUD_RADIUS),
    Float32Array.from(specs.flatMap((s) => s.origin)),
    Float32Array.from(specs.flatMap((s) => s.axis)),
    Float32Array.from(specs, (s) => s.reach),
  );
}

function grid(width: number, depth: number, spec: (x: number, z: number) => Spec): Spec[] {
  const specs: Spec[] = [];
  for (let j = 0; j < depth; j++) {
    for (let i = 0; i < width; i++) specs.push(spec(i * STUD_LDU + HALF, j * STUD_LDU + HALF));
  }
  return specs;
}

function block(width: number, depth: number, heightLdu: number, cavity: number): ConnectorTable {
  return table([
    ...grid(width, depth, (x, z) => ({
      gender: GENDER_MALE,
      origin: [x, heightLdu, z],
      axis: UP,
      reach: STUD_REACH,
    })),
    ...grid(width, depth, (x, z) => ({
      gender: GENDER_FEMALE,
      origin: [x, 0, z],
      axis: DOWN,
      reach: cavity,
    })),
  ]);
}

function baseplate(width: number, depth: number): ConnectorTable {
  return table(
    grid(width, depth, (x, z) => ({
      gender: GENDER_MALE,
      origin: [x, 0, z],
      axis: UP,
      reach: STUD_REACH,
    })),
  );
}

function translation(x: number, y: number, z: number): number[] {
  return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z];
}

function model(
  parts: ReadonlyArray<ConnectorTable | null>,
  placements: ReadonlyArray<readonly [number, ReadonlyArray<number>]>,
): ModelConnectors {
  return ModelConnectors.fromParts(parts, {
    count: placements.length,
    partIndex: placements.map(([part]) => part),
    matrices: Float32Array.from(placements.flatMap(([, matrix]) => matrix)),
  });
}

function single(part: ConnectorTable): ModelConnectors {
  return model([part], [[0, translation(0, 0, 0)]]);
}

function pose(x: number, z: number, yPlates: number, rot: QuarterTurn = 0): LatticePose {
  return { x, z, yPlates, rot };
}

function matesAt(solver: ConnectionSolver, piece: ModelConnectors, at: LatticePose): number {
  const report = new MateReport();
  solver.evaluate(piece, at, report);
  return report.count;
}

function window(at: LatticePose, cells: number, plates: number, turns = 1): SnapWindow {
  return { ...at, cells, plates, turns };
}

describe("ConnectionSolver with lattice studs", () => {
  it("mates every anti-stud that lands on a baseplate stud, at every turn and offset", () => {
    const solver = new ConnectionSolver([new LatticeStudFinder()]);
    const width = 6;
    solver.insert(single(baseplate(width, width)), pose(0, 0, 0));
    const plate = single(block(2, 3, PLATE_LDU, PLATE_CAVITY));
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
          expect(matesAt(solver, plate, at)).toBe(expected);
          solver.rank(plate, window(at, 0, 0), candidates);
          expect(candidates.votes[0]).toBe(expected);
          expect(matesAt(solver, plate, pose(at.x, at.z, 1, rot))).toBe(0);
        }
      }
    }
  });

  it("ranks the pose with the most mates first, and the nearest one among equals", () => {
    const solver = new ConnectionSolver([new LatticeStudFinder()]);
    solver.insert(single(baseplate(4, 4)), pose(0, 0, 0));
    const plate = single(block(2, 2, PLATE_LDU, PLATE_CAVITY));
    const candidates = new CandidatePoses();
    solver.rank(plate, window(pose(-STUD_LDU, STUD_LDU, 0), 1, 1), candidates);
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
    const solver = new ConnectionSolver([new LatticeStudFinder()]);
    solver.insert(single(baseplate(8, 8)), pose(0, 0, 0));
    solver.insert(
      single(block(2, 2, BRICK_LDU, BRICK_CAVITY)),
      pose(2 * STUD_LDU, 2 * STUD_LDU, 0),
    );
    const plate = single(block(2, 2, PLATE_LDU, PLATE_CAVITY));
    const candidates = new CandidatePoses();
    solver.rank(plate, window(pose(2 * STUD_LDU, 2 * STUD_LDU, 2), 0, 1), candidates);
    expect([candidates.yPlates[0], candidates.votes[0]]).toEqual([BRICK_LDU / PLATE_LDU, 4]);
  });

  it("keeps a connector placed twice until both placements are removed", () => {
    const solver = new ConnectionSolver([new LatticeStudFinder()]);
    const plateBase = single(baseplate(2, 2));
    const plate = single(block(2, 2, PLATE_LDU, PLATE_CAVITY));
    solver.insert(plateBase, pose(0, 0, 0));
    solver.insert(plateBase, pose(0, 0, 0));
    solver.remove(plateBase, pose(0, 0, 0));
    expect(matesAt(solver, plate, pose(0, 0, 0))).toBe(4);
    solver.remove(plateBase, pose(0, 0, 0));
    expect(matesAt(solver, plate, pose(0, 0, 0))).toBe(0);
    expect(() => solver.remove(plateBase, pose(0, 0, 0))).toThrow(RangeError);
  });

  it("mates a half-stud offset connector only at the offset that puts it on the lattice", () => {
    const solver = new ConnectionSolver([new LatticeStudFinder()]);
    solver.insert(single(baseplate(4, 4)), pose(0, 0, 0));
    const jumper = single(
      table([{ gender: GENDER_FEMALE, origin: [0, 0, HALF], axis: DOWN, reach: PLATE_CAVITY }]),
    );
    expect(matesAt(solver, jumper, pose(HALF + STUD_LDU, 0, 0))).toBe(1);
    expect(matesAt(solver, jumper, pose(STUD_LDU, 0, 0))).toBe(0);
  });

  it.each([
    ["round in round", PROFILE_ROUND, STUD_RADIUS, PROFILE_ROUND, STUD_RADIUS, 1],
    ["cross in round of its half-width", PROFILE_CROSS, STUD_RADIUS, PROFILE_ROUND, STUD_RADIUS, 1],
    ["cross in cross", PROFILE_CROSS, BAR_RADIUS, PROFILE_CROSS, BAR_RADIUS, 1],
    ["round never in cross", PROFILE_ROUND, BAR_RADIUS, PROFILE_CROSS, BAR_RADIUS, 0],
    ["round in a smaller round", PROFILE_ROUND, STUD_RADIUS, PROFILE_ROUND, BAR_RADIUS, 0],
    ["round in a larger round", PROFILE_ROUND, BAR_RADIUS, PROFILE_ROUND, STUD_RADIUS, 0],
  ])(
    "profile containment: %s",
    (_, maleProfile, maleRadius, femaleProfile, femaleRadius, mates) => {
      const solver = new ConnectionSolver([new LatticeStudFinder()]);
      const female = { profile: femaleProfile, radius: femaleRadius, gender: GENDER_FEMALE };
      const receptors = grid(2, 2, (x, z) => ({
        ...female,
        origin: [x, 0, z],
        axis: UP,
        reach: 8,
      }));
      solver.insert(single(table(receptors)), pose(-STUD_LDU, -STUD_LDU, 0));
      const male = { profile: maleProfile, radius: maleRadius, gender: GENDER_MALE };
      const piece = single(table([{ ...male, origin: [HALF, 0, HALF], axis: DOWN, reach: 8 }]));
      for (const rot of [0, 1, 2, 3] as const) {
        expect(matesAt(solver, piece, pose(0, 0, 0, rot))).toBe(mates);
      }
    },
  );

  it.each([
    ["a bar slides through a shorter clip from its root", 20, 4, [0, 1, 2], [-1, 3]],
    ["a stud inserts fully into a deeper cavity", 4, 20, [0], [-1, 1]],
  ])("axial engagement: %s", (_, maleReach, femaleReach, engaged, refused) => {
    const solver = new ConnectionSolver([new LatticeStudFinder()]);
    const male = { gender: GENDER_MALE, radius: BAR_RADIUS, axis: UP, reach: maleReach };
    solver.insert(single(table([{ ...male, origin: [HALF, 0, HALF] }])), pose(0, 0, 0));
    const female = { gender: GENDER_FEMALE, radius: BAR_RADIUS, axis: DOWN, reach: femaleReach };
    const clip = single(table([{ ...female, origin: [HALF, 0, HALF] }]));
    for (const y of engaged) expect(matesAt(solver, clip, pose(0, 0, y))).toBe(1);
    for (const y of refused) expect(matesAt(solver, clip, pose(0, 0, y))).toBe(0);
  });

  it("never mates connectors whose axes point the same way", () => {
    const solver = new ConnectionSolver([new LatticeStudFinder()]);
    solver.insert(single(baseplate(1, 1)), pose(0, 0, 0));
    const upward = single(
      table([{ gender: GENDER_FEMALE, origin: [HALF, 0, HALF], axis: UP, reach: PLATE_CAVITY }]),
    );
    expect(matesAt(solver, upward, pose(0, 0, 0))).toBe(0);
  });
});

describe("ModelConnectors", () => {
  it("consumes internal mates, so studs covered inside a model never vote outside it", () => {
    const plate = block(2, 2, PLATE_LDU, PLATE_CAVITY);
    const stack = model(
      [plate],
      [
        [0, translation(0, 0, 0)],
        [0, translation(0, PLATE_LDU, 0)],
      ],
    );
    expect([stack.internalMates, stack.count]).toEqual([4, 8]);
    const solver = new ConnectionSolver([new LatticeStudFinder()]);
    solver.insert(stack, pose(0, 0, 0));
    const piece = single(plate);
    expect(matesAt(solver, piece, pose(0, 0, 1))).toBe(0);
    expect(matesAt(solver, piece, pose(0, 0, 2))).toBe(4);
  });

  it("identifies connector frames within 0.0005 LDU of the lattice and reports the rest", () => {
    const stud = table([
      { gender: GENDER_MALE, origin: [HALF, 0, HALF], axis: UP, reach: STUD_REACH },
    ]);
    const dust = 0.9999999;
    const residue = 1e-7;
    const diagonal = Math.SQRT1_2;
    const placements: ReadonlyArray<readonly [number, ReadonlyArray<number>]> = [
      [0, translation(0.0003, 0, -0.0002)],
      [0, [dust, -residue, 0, 0, residue, dust, 0, 0, 0, 0, 1, 0]],
      [0, translation(0.0006, 0, 0)],
      [0, translation(0, 0.03, 0)],
      [0, [diagonal, -diagonal, 0, 0, diagonal, diagonal, 0, 0, 0, 0, 1, 0]],
      [1, translation(0, 0, 0)],
    ];
    const connectors = model([stud, null], placements);
    expect([
      connectors.count,
      connectors.offLattice,
      connectors.instancesWithoutConnectors,
    ]).toEqual([2, 3, 1]);
    expect(Array.from(connectors.origin)).toEqual([HALF, 0, HALF, HALF, 0, HALF]);
  });
});

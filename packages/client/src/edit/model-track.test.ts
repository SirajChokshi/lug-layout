import {
  STUD_LDU,
  ZETA16_COEFFICIENT_COUNT,
  composePose16,
  pose16,
  posesJoin16,
  zeta16,
  type Pose16,
} from "@brr/math";
import { describe, expect, it } from "vitest";
import { latticePose16, latticeSnap } from "./model-track.ts";

const QUARTER_TURNS = 4;
const HEADINGS = 16;

function at(coefficients: ReadonlyArray<number>, heading: number): Pose16 {
  const full = Array.from({ length: ZETA16_COEFFICIENT_COUNT }, (_, k) =>
    BigInt(coefficients[k] ?? 0),
  );
  return pose16(zeta16(full), heading);
}

const locals: ReadonlyArray<Pose16> = [
  at([-6, 0, 0, 0, -24], 12),
  at([10, 0, 0, 0, -7], 4),
  at([0, 0, 0, 0, 0], 8),
  at([3, 0, 0, 0, 5], 0),
  at([0, 0, 0, 0, 40, -40], 1),
];

const targets: ReadonlyArray<Pose16> = Array.from({ length: HEADINGS }, (_, heading) => [
  at([7, 0, 0, 0, -3], heading),
  at([-12, 0, 0, 0, 20], heading),
  at([16, 0, 0, 0, 40, -40], heading),
  at([0, 1, 0, 0, 0], heading),
]).flat();

describe("latticeSnap", () => {
  it("offers only lattice poses, and every offer joins its target exactly", () => {
    let offers = 0;
    for (let rot = 0; rot < QUARTER_TURNS; rot++) {
      for (const local of locals) {
        for (const target of targets) {
          const snap = latticeSnap(local, target, rot);
          if (!snap) continue;
          offers++;
          expect(Number.isInteger(snap.xLdu / STUD_LDU)).toBe(true);
          expect(Number.isInteger(snap.zLdu / STUD_LDU)).toBe(true);
          const frame = latticePose16(snap.xLdu, snap.zLdu, rot);
          expect(posesJoin16(composePose16(frame, local), target)).toBe(true);
        }
      }
    }
    expect(offers).toBeGreaterThan(0);
  });

  it("refuses a target that no lattice move of a lattice end can reach", () => {
    const offLattice = targets.filter((target) => target.position[1] !== 0n);
    for (let rot = 0; rot < QUARTER_TURNS; rot++) {
      for (const target of offLattice) {
        expect(latticeSnap(locals[0] ?? at([], 0), target, rot)).toBeNull();
      }
    }
  });
});

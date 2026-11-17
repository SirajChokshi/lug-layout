import { expect, it } from "vitest";
import { gridAnchor, gridAnchorStep, levelLineOffsets } from "./grid-lines.ts";
import type { GridLevel } from "./scene-backend.ts";

const STUD = 20;
const level = (stepLdu: number, halfSteps: number): GridLevel => ({
  stepLdu,
  halfSteps,
  color: 0,
  opacity: 1,
  minPitchPx: 0,
});
const levels = [level(STUD, 48), level(8 * STUD, 40), level(32 * STUD, 40)];

function drawnAt(target: number): Map<number, number[]> {
  const anchor = gridAnchor(target, gridAnchorStep(levels));
  const drawn = new Map<number, number[]>();
  for (const one of levels) {
    for (const offset of levelLineOffsets(one, levels)) {
      const at = anchor + offset;
      drawn.set(at, [...(drawn.get(at) ?? []), one.stepLdu]);
    }
  }
  return drawn;
}

it.each([0, 3 * STUD, 8 * STUD, 5 * STUD, -13 * STUD, 1021 * STUD, -319 * STUD - 7, 16 * STUD])(
  "draws every stud line near target %s LDU once, on the coarsest level through it",
  (target) => {
    const drawn = drawnAt(target);
    const first = Math.ceil((target - 48 * STUD) / STUD) * STUD;
    for (let at = first; at <= target + 48 * STUD; at += STUD) {
      const coarsest = levels.toReversed().find((one) => at % one.stepLdu === 0);
      expect(drawn.get(at), `line at ${at / STUD} studs`).toEqual([coarsest?.stepLdu]);
    }
  },
);

it("refuses steps that don't divide the coarsest one", () => {
  expect(() => gridAnchorStep([level(STUD, 4), level(3 * STUD, 4), level(8 * STUD, 4)])).toThrow(
    /does not divide/u,
  );
});

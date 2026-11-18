import { HALF_TURN_16, STUD_LDU, pose16, zeta16, type Pose16 } from "@brr/math";
import { describe, expect, it } from "vitest";
import { NEAR_MISS_RADIUS_LDU, WORLD_TRACK_FRAME, endGaps, type TrackEnd } from "./end-gaps.ts";

function at(x: number, z: number, heading: number, yPlates = 0): TrackEnd {
  const pose: Pose16 = pose16(zeta16([BigInt(x), 0n, 0n, 0n, BigInt(z), 0n, 0n, 0n]), heading);
  return { pose, yPlates, frame: WORLD_TRACK_FRAME };
}

const facingEast = at(16, 0, 0);

describe("endGaps", () => {
  it.each([
    ["an exact join", at(16, 0, HALF_TURN_16)],
    ["an end on another plate height", at(16, 0, HALF_TURN_16 + 1, 1)],
    ["an end just outside the radius", at(16 + NEAR_MISS_RADIUS_LDU / STUD_LDU + 1, 0, 8)],
  ])("never reports %s", (_label, other) => {
    expect(endGaps([facingEast, other])).toEqual([]);
  });

  it.each([
    ["one stud short", at(17, 0, HALF_TURN_16), STUD_LDU, 0],
    ["coincident but turned one step", at(16, 0, HALF_TURN_16 + 1), 0, -1],
    ["one stud aside and turned back a step", at(16, 1, HALF_TURN_16 - 1), STUD_LDU, 1],
  ])("reports an end %s with its distance and heading error", (_label, other, gap, steps) => {
    expect(endGaps([facingEast, other])).toEqual([
      { a: 0, b: 1, gapLdu: gap, headingErrorSteps: steps },
    ]);
  });

  it("finds near misses across bucket boundaries", () => {
    const radius = NEAR_MISS_RADIUS_LDU / STUD_LDU;
    const left = at(radius - 1, 0, 0);
    const right = at(radius, 0, HALF_TURN_16 + 2);
    expect(endGaps([left, right]).map((g) => [g.a, g.b])).toEqual([[0, 1]]);
  });
});

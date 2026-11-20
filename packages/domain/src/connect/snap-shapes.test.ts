import { describe, expect, it } from "vitest";
import { CAP_ROOT, SECTION_ROUND, SnapShapes } from "./snap-shapes.ts";

const RECORDED_LENGTH = 0.1;
const SAME_IN_FLOAT32 = Math.fround(RECORDED_LENGTH);

describe("SnapShapes", () => {
  it("interns two section lengths equal in Float32 but distinct in Float64 as two shapes, each read back exactly", () => {
    const shapes = new SnapShapes();
    const recorded = shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [6], [RECORDED_LENGTH]);
    const rounded = shapes.intern(CAP_ROOT, false, [SECTION_ROUND], [6], [SAME_IN_FLOAT32]);
    expect({
      sameInFloat32: Math.fround(SAME_IN_FLOAT32) === Math.fround(RECORDED_LENGTH),
      distinct: recorded !== rounded,
      spans: [recorded, rounded].map((shape) => shapes.span(shapes.firstSection(shape))),
    }).toEqual({
      sameInFloat32: true,
      distinct: true,
      spans: [RECORDED_LENGTH, SAME_IN_FLOAT32],
    });
  });
});

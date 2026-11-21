import {
  CAP_ROOT,
  GENDER_FEMALE,
  GENDER_MALE,
  SECTION_FLARE_JOINS_PREVIOUS,
  SECTION_ROUND,
  SnapShapes,
} from "@brr/domain";
import { describe, expect, it } from "vitest";
import { connectorKind } from "./placement-hover-view.ts";

describe("connectorKind", () => {
  it("reports a friction pin's flare at its own size, the section that tells a pin from a plain round peg", () => {
    const shapes = new SnapShapes();
    const pin = shapes.intern(
      CAP_ROOT,
      false,
      [SECTION_ROUND, SECTION_ROUND, SECTION_FLARE_JOINS_PREVIOUS],
      [8, 6, 6.25],
      [2, 16, 2],
    );
    const hole = shapes.intern(
      0,
      true,
      [SECTION_ROUND, SECTION_ROUND, SECTION_ROUND],
      [8, 6, 8],
      [2, 16, 2],
    );
    expect([
      connectorKind(shapes, pin, GENDER_MALE),
      connectorKind(shapes, hole, GENDER_FEMALE),
    ]).toEqual([
      {
        gender: "male",
        slides: false,
        sections: [
          { profile: "round", sizeLdu: 8, lengthLdu: 2 },
          { profile: "round", sizeLdu: 6, lengthLdu: 16 },
          { profile: "flare", sizeLdu: 6.25, lengthLdu: 2 },
        ],
      },
      {
        gender: "female",
        slides: true,
        sections: [
          { profile: "round", sizeLdu: 8, lengthLdu: 2 },
          { profile: "round", sizeLdu: 6, lengthLdu: 16 },
          { profile: "round", sizeLdu: 8, lengthLdu: 2 },
        ],
      },
    ]);
  });
});

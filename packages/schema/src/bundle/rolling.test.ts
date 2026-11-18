import { describe, expect, it } from "vitest";
import { decode } from "../decode/index.ts";
import { PartRolling } from "./index.ts";

const diagnostic = { direction: [0, 0, 1], from: -6, to: -3.57143 };
const tread = { source: "measured", axis: 2, at: [0, 0], from: -56, to: 32, radii: [336, 328] };

function rolling(surfaces: ReadonlyArray<unknown>, unread: ReadonlyArray<unknown>): unknown {
  return { stepsPerLdu: 16, surfaces, unread };
}

describe("PartRolling", () => {
  it("keeps each unread band to the fields its reason identifies", () => {
    const decoded = decode(
      PartRolling,
      rolling(
        [tread],
        [
          { reason: "unoriented", axis: 0, at: [0, 0], diagnostic },
          { reason: "centre", axis: 2, at: [0, 0], from: -96, diagnostic },
          { reason: "width", axis: 2, at: [0, 0], from: -96, diagnostic },
        ],
      ),
    );
    if (!decoded.ok) throw new Error(JSON.stringify(decoded.issues));
    expect(decoded.value.unread).toEqual([
      { reason: "unoriented", diagnostic },
      { reason: "centre", axis: 2, diagnostic },
      { reason: "width", axis: 2, at: [0, 0], from: -96, diagnostic },
    ]);
  });

  it.each([
    ["a surface that doesn't run from below its end", rolling([{ ...tread, to: -56 }], [])],
    ["a surface with no axis", rolling([{ ...tread, axis: undefined }], [])],
    ["a surface on an axis that isn't x, y or z", rolling([{ ...tread, axis: 3 }], [])],
    [
      "a centre band without the axis it identified",
      rolling([], [{ reason: "centre", diagnostic }]),
    ],
    [
      "an unread band whose identified ends run backwards",
      rolling([], [{ reason: "partial", axis: 1, from: 8, to: 4, diagnostic }]),
    ],
  ])("refuses %s", (_case, value) => {
    expect(decode(PartRolling, value).ok).toBe(false);
  });
});

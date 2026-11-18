import { describe, expect, it } from "vitest";
import { decode } from "../decode/index.ts";
import { ExactDecimalText, ExactRationalText } from "./index.ts";

function accepted(numerator: string, denominator: string): boolean {
  return decode(ExactRationalText, { numerator, denominator }).ok;
}

describe("exact number texts", () => {
  it("accept exact decimals only in their canonical form", () => {
    expect(["46.9", "-53.1", "0", "160"].map((text) => decode(ExactDecimalText, text).ok)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(
      ["46.90", "-0", "1e3", ".5", "6.200000000000003x", ""].map(
        (text) => decode(ExactDecimalText, text).ok,
      ),
    ).toEqual([false, false, false, false, false, false]);
  });

  it("accept exact rationals only reduced, with a positive denominator", () => {
    expect(accepted("436286213901517", "70368744177664")).toBe(true);
    expect(accepted("-31", "5")).toBe(true);
    expect([accepted("62", "10"), accepted("31", "-5"), accepted("31", "0")]).toEqual([
      false,
      false,
      false,
    ]);
  });
});

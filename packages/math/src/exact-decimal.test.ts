import { describe, expect, it } from "vitest";
import {
  addExactDecimal,
  compareExactDecimal,
  formatExactDecimal,
  isCanonicalExactDecimal,
  multiplyExactDecimal,
  parseExactDecimal,
  subtractExactDecimal,
} from "./exact-decimal.ts";

const decimal = parseExactDecimal;
const written = formatExactDecimal;

describe("exact decimals", () => {
  it.each([
    ["46.9", "46.9"],
    ["-53.10", "-53.1"],
    [".5", "0.5"],
    ["-0", "0"],
    ["+3", "3"],
    ["007.0", "7"],
    ["1e-3", "0.001"],
    ["2.5E2", "250"],
    ["-1.5e-005", "-0.000015"],
  ])("read the LDraw literal %s as exactly %s", (literal, canonical) => {
    expect(written(decimal(literal))).toBe(canonical);
  });

  it("compose LDraw literals exactly where Float64 rounds", () => {
    expect(53.1 - 46.9).toBe(6.200000000000003);
    expect(written(subtractExactDecimal(decimal("53.1"), decimal("46.9")))).toBe("6.2");
    expect(written(addExactDecimal(decimal("0.1"), decimal("0.2")))).toBe("0.3");
    expect(written(multiplyExactDecimal(decimal("3.1"), decimal("-15.2")))).toBe("-47.12");
  });

  it("compare by value, whatever the written places", () => {
    expect(compareExactDecimal(decimal("46.9"), decimal("46.900"))).toBe(0);
    expect(compareExactDecimal(decimal("-53.1"), decimal("-46.9"))).toBe(-1);
    expect(compareExactDecimal(decimal("0.000015"), decimal("0.00001"))).toBe(1);
  });

  it.each(["", "4..6", "1e", "0x10", "NaN", "Infinity", "1,5", " 1"])(
    "refuse %j, which is not a decimal literal",
    (text) => {
      expect(() => decimal(text)).toThrow("is not a decimal literal");
    },
  );

  it("call only the written form canonical", () => {
    expect(["46.9", "-0.5", "250", "0"].map(isCanonicalExactDecimal)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(["46.90", "-0", "+1", ".5", "2.5e2", "007"].map(isCanonicalExactDecimal)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  addExactDecimal,
  exactDecimal,
  compareExactDecimal,
  formatExactDecimal,
  isCanonicalExactDecimalText,
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

  it("refuse arithmetic that would write past the digit bound", () => {
    const tiny = exactDecimal(1n, 600);
    expect(() => multiplyExactDecimal(tiny, tiny)).toThrow("writes canonically with more than");
    const huge = exactDecimal(10n ** 1099n, 0);
    expect(() => addExactDecimal(huge, multiplyExactDecimal(huge, decimal("9")))).toThrow(
      "writes canonically with more than",
    );
  });

  it("compose LDraw literals exactly where Float64 rounds", () => {
    expect(53.1 - 46.9).toBe(6.200000000000003);
    expect(written(subtractExactDecimal(decimal("53.1"), decimal("46.9")))).toBe("6.2");
    expect(written(addExactDecimal(decimal("0.1"), decimal("0.2")))).toBe("0.3");
    expect(written(multiplyExactDecimal(decimal("3.1"), decimal("-15.2")))).toBe("-47.12");
  });

  it("normalize a coefficient and places into one value", () => {
    expect(exactDecimal(4690n, 2)).toEqual(decimal("46.9"));
    expect(exactDecimal(0n, 7)).toEqual(decimal("0"));
    expect(() => exactDecimal(1n, -1)).toThrow("is not a count of decimal places");
    expect(() => exactDecimal(1n, 1100)).toThrow("is not a count of decimal places");
    expect(() => exactDecimal(10n ** 1100n, 0)).toThrow("writes canonically with more than");
    expect(() => exactDecimal(10n ** 5000n, 1)).toThrow("writes canonically with more than");
  });

  it("compare by value, whatever the written places", () => {
    expect(compareExactDecimal(decimal("46.9"), decimal("46.900"))).toBe(0);
    expect(compareExactDecimal(decimal("-53.1"), decimal("-46.9"))).toBe(-1);
    expect(compareExactDecimal(decimal("0.000015"), decimal("0.00001"))).toBe(1);
  });

  it.each([
    "",
    "4..6",
    "1e",
    "0x10",
    "NaN",
    "Infinity",
    "1,5",
    " 1",
    "1e99999999999999999999",
    "1e-1101",
    "9".repeat(1101),
    `1e${"0".repeat(1200)}1`,
    "1e+01100",
  ])("refuse %j, which is not a decimal literal in range", (text) => {
    expect(() => decimal(text)).toThrow(
      /^the text is not a decimal literal with at most 1100 digits and an exponent of at most 4 digits whose magnitude is at most 1100$/u,
    );
    expect(isCanonicalExactDecimalText(text)).toBe(false);
  });

  it("write every value it reads in a form it reads back", () => {
    for (const literal of ["1e-1099", "-9.5e1098", `0.${"0".repeat(1097)}25`]) {
      const canonical = formatExactDecimal(decimal(literal));
      expect(isCanonicalExactDecimalText(canonical)).toBe(true);
      expect(formatExactDecimal(decimal(canonical))).toBe(canonical);
    }
    const tooLong = /^the literal writes canonically with more than 1100 digits$/u;
    expect(() => decimal("1e-1100")).toThrow(tooLong);
    expect(isCanonicalExactDecimalText("1e-1100")).toBe(false);
    expect(() => decimal("1e1100")).toThrow(tooLong);
    expect(isCanonicalExactDecimalText(`0.${"0".repeat(1099)}1`)).toBe(false);
  });

  it("refuse anything but a string as a literal or as canonical text", () => {
    for (const notText of [46.9, 469n, null, undefined, { text: "46.9" }]) {
      expect(isCanonicalExactDecimalText(notText)).toBe(false);
      expect(() => decimal(notText)).toThrow(/^a decimal literal is a string$/u);
    }
  });

  it("call only the written form canonical", () => {
    expect(["46.9", "-0.5", "250", "0"].map(isCanonicalExactDecimalText)).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(["46.90", "-0", "+1", ".5", "2.5e2", "007"].map(isCanonicalExactDecimalText)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });
});

import { describe, expect, it } from "vitest";
import { compareExactDecimal, parseExactDecimal } from "./exact-decimal.ts";
import {
  addRational,
  compareRational,
  exactRational,
  formatRational,
  meanRational,
  multiplyRational,
  parseRational,
  rationalEquals,
  rationalFromDecimal,
  rationalFromFloat64,
  rationalFromSixteenths,
  rationalToNumber,
  subtractRational,
} from "./exact-rational.ts";

const fromDecimal = (text: string) => rationalFromDecimal(parseExactDecimal(text));

describe("exact rationals", () => {
  it("hold a Float64 exactly, so 6.200000000000003 and 31/5 stay distinct", () => {
    const measured = rationalFromFloat64(6.200000000000003);
    expect(formatRational(measured)).toEqual({
      numerator: "436286213901517",
      denominator: "70368744177664",
    });
    expect(rationalEquals(measured, fromDecimal("6.2"))).toBe(false);
    expect(rationalEquals(rationalFromFloat64(6.2), exactRational(31n, 5n))).toBe(false);
    expect(compareRational(rationalFromFloat64(6.2), exactRational(31n, 5n))).toBe(1);
  });

  it.each([
    0.1,
    -0.1,
    6.200000000000003,
    46.9,
    1 / 3,
    2 ** 53 + 2,
    5e-324,
    -2.2250738585072014e-308,
    1.7976931348623157e308,
    123456789.125,
  ])("round-trip the Float64 %s bit for bit", (value) => {
    expect(Object.is(rationalToNumber(rationalFromFloat64(value)), value)).toBe(true);
  });

  it("read negative zero as zero", () => {
    expect(rationalEquals(rationalFromFloat64(-0), exactRational(0n, 1n))).toBe(true);
  });

  it("convert to the nearest Float64, ties to even", () => {
    const pairs: ReadonlyArray<readonly [number, number]> = [
      [1, 3],
      [2, 3],
      [31, 5],
      [-469, 10],
      [9007199254740991, 9007199254740992],
      [1, 9007199254740994],
      [123456789, 1000],
    ];
    for (const [numerator, denominator] of pairs) {
      expect(rationalToNumber(exactRational(BigInt(numerator), BigInt(denominator)))).toBe(
        numerator / denominator,
      );
    }
    for (const integer of [2n ** 53n + 1n, 2n ** 53n + 3n, -(2n ** 54n + 2n), 10n ** 30n + 7n]) {
      expect(rationalToNumber(exactRational(integer, 1n))).toBe(Number(integer));
    }
    expect(rationalToNumber(exactRational(1n, 2n ** 1075n))).toBe(0);
    expect(rationalToNumber(exactRational(3n, 2n ** 1076n))).toBe(5e-324);
  });

  it("take the mean of two contact radii exactly", () => {
    const tread = rationalFromSixteenths(328);
    const flangeRoot = fromDecimal("21.1");
    const mean = meanRational(tread, flangeRoot);
    expect(formatRational(mean)).toEqual({ numerator: "104", denominator: "5" });
    expect(rationalEquals(subtractRational(addRational(mean, mean), tread), flangeRoot)).toBe(true);
    const a = rationalFromFloat64(0.1);
    const b = rationalFromFloat64(0.2);
    expect(
      rationalEquals(addRational(meanRational(a, b), meanRational(a, b)), addRational(a, b)),
    ).toBe(true);
  });

  it("stay reduced with the sign on the numerator", () => {
    expect(formatRational(addRational(exactRational(1n, 6n), exactRational(1n, 3n)))).toEqual({
      numerator: "1",
      denominator: "2",
    });
    expect(formatRational(exactRational(4n, -6n))).toEqual({ numerator: "-2", denominator: "3" });
    expect(
      formatRational(multiplyRational(exactRational(-3n, 4n), exactRational(-8n, 9n))),
    ).toEqual({ numerator: "2", denominator: "3" });
  });

  it("read back only its own reduced string form", () => {
    const radius = rationalFromFloat64(20.499999999999996);
    expect(rationalEquals(parseRational(formatRational(radius)), radius)).toBe(true);
    for (const text of [
      { numerator: "2", denominator: "4" },
      { numerator: "1", denominator: "-2" },
      { numerator: "01", denominator: "2" },
      { numerator: "1", denominator: "0" },
      { numerator: "-0", denominator: "1" },
      { numerator: "1.5", denominator: "2" },
    ]) {
      expect(() => parseRational(text)).toThrow("is not a reduced exact rational");
    }
  });

  it("take Int32 sixteenths only", () => {
    expect(formatRational(rationalFromSixteenths(-750))).toEqual({
      numerator: "-375",
      denominator: "8",
    });
    expect(() => rationalFromSixteenths(1.5)).toThrow("is not an Int32 count of sixteenths");
    expect(() => rationalFromSixteenths(2 ** 31)).toThrow("is not an Int32 count of sixteenths");
  });

  it("compare sixteenths, decimals and Float64 values in one order", () => {
    const railHeadInner = fromDecimal("46.9");
    expect(compareRational(railHeadInner, rationalFromSixteenths(750))).toBe(1);
    expect(compareRational(rationalFromFloat64(46.9), railHeadInner)).toBe(-1);
    expect(compareRational(rationalFromSixteenths(750), rationalFromFloat64(46.875))).toBe(0);
    for (let sixteenths = 740; sixteenths <= 760; sixteenths += 1) {
      for (const text of ["46.25", "46.875", "46.9", "47", "47.3125", "-46.9"]) {
        const asDecimal = parseExactDecimal(String(sixteenths / 16));
        expect(compareRational(rationalFromSixteenths(sixteenths), fromDecimal(text))).toBe(
          compareExactDecimal(asDecimal, parseExactDecimal(text)),
        );
        expect(compareRational(rationalFromFloat64(sixteenths / 16), fromDecimal(text))).toBe(
          compareRational(rationalFromSixteenths(sixteenths), fromDecimal(text)),
        );
      }
    }
  });
});

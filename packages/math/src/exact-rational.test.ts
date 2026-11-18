import { describe, expect, it } from "vitest";
import { compareExactDecimal, parseExactDecimal } from "./exact-decimal.ts";
import {
  addExactRational,
  compareExactRational,
  divideExactRational,
  exactRational,
  formatExactRational,
  meanExactRational,
  multiplyExactRational,
  parseExactRational,
  exactRationalEquals,
  exactRationalFromDecimal,
  exactRationalFromFloat64,
  exactRationalFromSixteenths,
  exactRationalToFloat64,
  isCanonicalExactRationalText,
  subtractExactRational,
} from "./exact-rational.ts";

const SIXTEENTH_IN_TEN_THOUSANDTHS = 625;
const fromDecimal = (text: string) => exactRationalFromDecimal(parseExactDecimal(text));

describe("exact rationals", () => {
  it("hold a Float64 exactly, so 6.200000000000003 and 31/5 stay distinct", () => {
    const measured = exactRationalFromFloat64(6.200000000000003);
    expect(formatExactRational(measured)).toEqual({
      numerator: "436286213901517",
      denominator: "70368744177664",
    });
    expect(exactRationalEquals(measured, fromDecimal("6.2"))).toBe(false);
    expect(exactRationalEquals(exactRationalFromFloat64(6.2), exactRational(31n, 5n))).toBe(false);
    expect(compareExactRational(exactRationalFromFloat64(6.2), exactRational(31n, 5n))).toBe(1);
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
    expect(Object.is(exactRationalToFloat64(exactRationalFromFloat64(value)), value)).toBe(true);
  });

  it("read negative zero as zero", () => {
    expect(exactRationalEquals(exactRationalFromFloat64(-0), exactRational(0n, 1n))).toBe(true);
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
      expect(exactRationalToFloat64(exactRational(BigInt(numerator), BigInt(denominator)))).toBe(
        numerator / denominator,
      );
    }
    for (const integer of [2n ** 53n + 1n, 2n ** 53n + 3n, -(2n ** 54n + 2n), 10n ** 30n + 7n]) {
      expect(exactRationalToFloat64(exactRational(integer, 1n))).toBe(Number(integer));
    }
    expect(exactRationalToFloat64(exactRational(1n, 2n ** 1075n))).toBe(0);
    expect(exactRationalToFloat64(exactRational(3n, 2n ** 1076n))).toBe(5e-324);
  });

  it("take the mean of two contact radii exactly", () => {
    const tread = exactRationalFromSixteenths(328);
    const flangeRoot = fromDecimal("21.1");
    const mean = meanExactRational(tread, flangeRoot);
    expect(formatExactRational(mean)).toEqual({ numerator: "104", denominator: "5" });
    expect(
      exactRationalEquals(subtractExactRational(addExactRational(mean, mean), tread), flangeRoot),
    ).toBe(true);
    const a = exactRationalFromFloat64(0.1);
    const b = exactRationalFromFloat64(0.2);
    expect(
      exactRationalEquals(
        addExactRational(meanExactRational(a, b), meanExactRational(a, b)),
        addExactRational(a, b),
      ),
    ).toBe(true);
  });

  it("interpolate a cone's radius at a rail head edge exactly", () => {
    const [from, to] = [fromDecimal("46.5"), exactRationalFromSixteenths(52 * 16)];
    const [atFrom, atTo] = [exactRationalFromSixteenths(21 * 16), fromDecimal("20.5")];
    const along = divideExactRational(
      subtractExactRational(fromDecimal("46.9"), from),
      subtractExactRational(to, from),
    );
    const radius = addExactRational(
      atFrom,
      multiplyExactRational(subtractExactRational(atTo, atFrom), along),
    );
    expect(formatExactRational(radius)).toEqual({ numerator: "1153", denominator: "55" });
    expect(() => divideExactRational(atFrom, exactRational(0n, 1n))).toThrow("divided by zero");
  });

  it("stay reduced with the sign on the numerator", () => {
    expect(
      formatExactRational(addExactRational(exactRational(1n, 6n), exactRational(1n, 3n))),
    ).toEqual({
      numerator: "1",
      denominator: "2",
    });
    expect(formatExactRational(exactRational(4n, -6n))).toEqual({
      numerator: "-2",
      denominator: "3",
    });
    expect(
      formatExactRational(multiplyExactRational(exactRational(-3n, 4n), exactRational(-8n, 9n))),
    ).toEqual({ numerator: "2", denominator: "3" });
  });

  it("read back only its own reduced string form", () => {
    const radius = exactRationalFromFloat64(20.499999999999996);
    expect(exactRationalEquals(parseExactRational(formatExactRational(radius)), radius)).toBe(true);
    for (const text of [
      { numerator: "2", denominator: "4" },
      { numerator: "1", denominator: "-2" },
      { numerator: "01", denominator: "2" },
      { numerator: "1", denominator: "0" },
      { numerator: "-0", denominator: "1" },
      { numerator: "1.5", denominator: "2" },
      { numerator: "1", denominator: "3".repeat(1201) },
      { numerator: `1${"0".repeat(1200)}`, denominator: "1" },
    ]) {
      expect(() => parseExactRational(text)).toThrow("is not a reduced exact rational");
    }
  });

  it("refuse arithmetic whose terms would write past the digit bound", () => {
    const tiny = exactRational(1n, 10n ** 700n);
    expect(() => multiplyExactRational(tiny, tiny)).toThrow("more than 1200 digits in a term");
    const huge = exactRational(10n ** 700n, 1n);
    expect(() => multiplyExactRational(huge, huge)).toThrow("more than 1200 digits in a term");
    expect(() => exactRational(10n ** 5000n + 1n, 3n)).toThrow("unreduced terms have more than");
  });

  it("refuse anything but own integer-string fields as canonical text", () => {
    for (const notText of [
      null,
      undefined,
      "31/5",
      { numerator: 31, denominator: 5 },
      Object.assign(["31", "5"], { numerator: "31", denominator: "5" }),
      Object.create({ numerator: "31", denominator: "5" }),
      {
        get numerator(): string {
          throw new Error("a getter is not text");
        },
        denominator: "5",
      },
    ]) {
      expect(isCanonicalExactRationalText(notText)).toBe(false);
    }
    for (const notText of [null, 1n]) {
      expect(() => parseExactRational(notText)).toThrow(
        "the text is not a reduced exact rational of decimal integer strings",
      );
    }
  });

  it("read back a numerator of the full digit bound whatever its sign", () => {
    const longest = `-1${"0".repeat(1199)}`;
    expect(
      formatExactRational(parseExactRational({ numerator: longest, denominator: "1" })),
    ).toEqual({ numerator: longest, denominator: "1" });
  });

  it("take Int32 sixteenths only", () => {
    expect(formatExactRational(exactRationalFromSixteenths(-750))).toEqual({
      numerator: "-375",
      denominator: "8",
    });
    expect(() => exactRationalFromSixteenths(1.5)).toThrow("is not an Int32 count of sixteenths");
    expect(() => exactRationalFromSixteenths(2 ** 31)).toThrow(
      "is not an Int32 count of sixteenths",
    );
  });

  it("compare sixteenths, decimals and Float64 values in one order", () => {
    const railHeadInner = fromDecimal("46.9");
    expect(compareExactRational(railHeadInner, exactRationalFromSixteenths(750))).toBe(1);
    expect(compareExactRational(exactRationalFromFloat64(46.9), railHeadInner)).toBe(-1);
    expect(
      compareExactRational(exactRationalFromSixteenths(750), exactRationalFromFloat64(46.875)),
    ).toBe(0);
    for (let sixteenths = 740; sixteenths <= 760; sixteenths += 1) {
      for (const text of ["46.25", "46.875", "46.9", "47", "47.3125", "-46.9"]) {
        const asDecimal = parseExactDecimal(`${sixteenths * SIXTEENTH_IN_TEN_THOUSANDTHS}e-4`);
        expect(
          compareExactRational(exactRationalFromSixteenths(sixteenths), fromDecimal(text)),
        ).toBe(compareExactDecimal(asDecimal, parseExactDecimal(text)));
        expect(
          compareExactRational(exactRationalFromFloat64(sixteenths / 16), fromDecimal(text)),
        ).toBe(compareExactDecimal(asDecimal, parseExactDecimal(text)));
      }
    }
  });
});

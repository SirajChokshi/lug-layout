import type { ExactDecimal } from "./exact-decimal.ts";

export interface ExactRational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

export interface ExactRationalText {
  readonly numerator: string;
  readonly denominator: string;
}

const INTEGER_TEXT = /^(?:0|-?[1-9]\d*)$/u;
const POSITIVE_INTEGER_TEXT = /^[1-9]\d*$/u;
const MAX_DIGITS = 1200;
const TERM_LIMIT = 10n ** BigInt(MAX_DIGITS);
const UNREDUCED_DIGITS = 2 * MAX_DIGITS + 1;
const UNREDUCED_LIMIT = 10n ** BigInt(UNREDUCED_DIGITS);
const SIXTEENTHS_PER_LDU = 16n;
const SIGNIFICAND_BITS = 53;
const GUARD_BITS = 2;
const FRACTION_BITS = 52n;
const EXPONENT_BIAS = 1075;
const MAX_BIASED_EXPONENT = 0x7ff;
const LEAST_EXPONENT = -1074;
const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;

const float64Bits = new DataView(new ArrayBuffer(8));

function magnitude(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function greatestCommonDivisor(a: bigint, b: bigint): bigint {
  let x = magnitude(a);
  let y = magnitude(b);
  while (y !== 0n) {
    const remainder = x % y;
    x = y;
    y = remainder;
  }
  return x;
}

const WORD_BITS = 32;
const WORD_SHIFT = 32n;
const WORD_MASK = 0xffffffffn;

function bitLength(value: bigint): number {
  let bits = 0;
  let rest = value;
  while (rest > WORD_MASK) {
    rest >>= WORD_SHIFT;
    bits += WORD_BITS;
  }
  return bits + WORD_BITS - Math.clz32(Number(rest));
}

export function exactRational(numerator: bigint, denominator: bigint): ExactRational {
  if (denominator === 0n) throw new Error("an exact rational has a nonzero denominator");
  if (magnitude(numerator) >= UNREDUCED_LIMIT || magnitude(denominator) >= UNREDUCED_LIMIT) {
    throw new Error(
      `an exact rational's unreduced terms have more than ${UNREDUCED_DIGITS} digits`,
    );
  }
  const sign = denominator < 0n ? -1n : 1n;
  const divisor = greatestCommonDivisor(numerator, denominator);
  const reduced = {
    numerator: (sign * numerator) / divisor,
    denominator: (sign * denominator) / divisor,
  };
  if (magnitude(reduced.numerator) >= TERM_LIMIT || reduced.denominator >= TERM_LIMIT) {
    throw new Error(`an exact rational writes more than ${MAX_DIGITS} digits in a term`);
  }
  return reduced;
}

export function exactRationalFromSixteenths(sixteenths: number): ExactRational {
  if (!Number.isInteger(sixteenths) || sixteenths < INT32_MIN || sixteenths > INT32_MAX) {
    throw new Error(`${sixteenths} is not an Int32 count of sixteenths`);
  }
  return exactRational(BigInt(sixteenths), SIXTEENTHS_PER_LDU);
}

export function exactRationalFromDecimal(value: ExactDecimal): ExactRational {
  return exactRational(value.coefficient, 10n ** BigInt(value.places));
}

export function exactRationalFromFloat64(value: number): ExactRational {
  if (!Number.isFinite(value)) throw new Error(`${value} is not a finite Float64`);
  float64Bits.setFloat64(0, value);
  const bits = float64Bits.getBigUint64(0);
  const biased = Number((bits >> FRACTION_BITS) & BigInt(MAX_BIASED_EXPONENT));
  const fraction = bits & ((1n << FRACTION_BITS) - 1n);
  const significand = biased === 0 ? fraction : fraction | (1n << FRACTION_BITS);
  const exponent = Math.max(biased, 1) - EXPONENT_BIAS;
  const signed = bits >> 63n === 1n ? -significand : significand;
  return exponent >= 0
    ? exactRational(signed << BigInt(exponent), 1n)
    : exactRational(signed, 1n << BigInt(-exponent));
}

export function addExactRational(a: ExactRational, b: ExactRational): ExactRational {
  return exactRational(
    a.numerator * b.denominator + b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function subtractExactRational(a: ExactRational, b: ExactRational): ExactRational {
  return exactRational(
    a.numerator * b.denominator - b.numerator * a.denominator,
    a.denominator * b.denominator,
  );
}

export function multiplyExactRational(a: ExactRational, b: ExactRational): ExactRational {
  return exactRational(a.numerator * b.numerator, a.denominator * b.denominator);
}

export function divideExactRational(
  dividend: ExactRational,
  divisor: ExactRational,
): ExactRational {
  if (divisor.numerator === 0n) throw new Error("an exact rational can't be divided by zero");
  return exactRational(
    dividend.numerator * divisor.denominator,
    dividend.denominator * divisor.numerator,
  );
}

export function meanExactRational(a: ExactRational, b: ExactRational): ExactRational {
  return exactRational(
    a.numerator * b.denominator + b.numerator * a.denominator,
    2n * a.denominator * b.denominator,
  );
}

export function floorExactRational(value: ExactRational): bigint {
  const quotient = value.numerator / value.denominator;
  return value.numerator < 0n && quotient * value.denominator !== value.numerator
    ? quotient - 1n
    : quotient;
}

export function ceilExactRational(value: ExactRational): bigint {
  const quotient = value.numerator / value.denominator;
  return value.numerator > 0n && quotient * value.denominator !== value.numerator
    ? quotient + 1n
    : quotient;
}

export function compareExactRational(a: ExactRational, b: ExactRational): -1 | 0 | 1 {
  const difference = a.numerator * b.denominator - b.numerator * a.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function exactRationalEquals(a: ExactRational, b: ExactRational): boolean {
  return a.numerator === b.numerator && a.denominator === b.denominator;
}

export function formatExactRational(value: ExactRational): ExactRationalText {
  return { numerator: value.numerator.toString(), denominator: value.denominator.toString() };
}

function ownText(value: object, key: string): string | undefined {
  const field: unknown = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof field === "string" ? field : undefined;
}

export function isCanonicalExactRationalText(text: unknown): text is ExactRationalText {
  if (typeof text !== "object" || text === null || Array.isArray(text)) return false;
  const numerator = ownText(text, "numerator");
  const denominator = ownText(text, "denominator");
  if (numerator === undefined || denominator === undefined) return false;
  const numeratorDigits = numerator.length - (numerator.startsWith("-") ? 1 : 0);
  if (
    numeratorDigits > MAX_DIGITS ||
    denominator.length > MAX_DIGITS ||
    !INTEGER_TEXT.test(numerator) ||
    !POSITIVE_INTEGER_TEXT.test(denominator)
  ) {
    return false;
  }
  return greatestCommonDivisor(BigInt(numerator), BigInt(denominator)) === 1n;
}

export function parseExactRational(text: unknown): ExactRational {
  if (!isCanonicalExactRationalText(text)) {
    throw new Error("the text is not a reduced exact rational of decimal integer strings");
  }
  return { numerator: BigInt(text.numerator), denominator: BigInt(text.denominator) };
}

export function exactRationalToFloat64(value: ExactRational): number {
  if (value.numerator === 0n) return 0;
  const numerator = magnitude(value.numerator);
  const shift = bitLength(numerator) - bitLength(value.denominator) - SIGNIFICAND_BITS - GUARD_BITS;
  const scaledNumerator = shift < 0 ? numerator << BigInt(-shift) : numerator;
  const scaledDenominator = shift > 0 ? value.denominator << BigInt(shift) : value.denominator;
  const quotient = scaledNumerator / scaledDenominator;
  const inexact = scaledNumerator % scaledDenominator !== 0n;
  const dropped = Math.max(bitLength(quotient) - SIGNIFICAND_BITS, LEAST_EXPONENT - shift, 0);
  const kept = quotient >> BigInt(dropped);
  const remainder = quotient - (kept << BigInt(dropped));
  const half = dropped === 0 ? 0n : 1n << BigInt(dropped - 1);
  const roundsUp =
    dropped > 0 && (remainder > half || (remainder === half && (inexact || (kept & 1n) === 1n)));
  const significand = Number(roundsUp ? kept + 1n : kept);
  const result = significand * 2 ** (shift + dropped);
  return value.numerator < 0n ? -result : result;
}

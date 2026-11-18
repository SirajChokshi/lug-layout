export type ExactDecimalText = string;

export interface ExactDecimal {
  readonly coefficient: bigint;
  readonly places: number;
}

const DECIMAL_LITERAL = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u;
const CANONICAL_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u;
const TEN = 10n;
const MAX_DIGITS = 1100;
const MAX_EXPONENT_MAGNITUDE = 1100;
const COEFFICIENT_LIMIT = TEN ** BigInt(MAX_DIGITS);
const MAX_EXPONENT_DIGITS = String(MAX_EXPONENT_MAGNITUDE).length;
const MAX_LITERAL_LENGTH = MAX_DIGITS + `-.e-${MAX_EXPONENT_MAGNITUDE}`.length;
const MAX_CANONICAL_LENGTH = MAX_DIGITS + "-.".length;

export const EXACT_DECIMAL_ZERO: ExactDecimal = { coefficient: 0n, places: 0 };

export function exactDecimal(coefficient: bigint, places: number): ExactDecimal {
  if (!Number.isSafeInteger(places) || places < 0 || places >= MAX_DIGITS) {
    throw new Error(`${places} is not a count of decimal places below ${MAX_DIGITS}`);
  }
  const magnitude = coefficient < 0n ? -coefficient : coefficient;
  if (magnitude >= COEFFICIENT_LIMIT && magnitude >= COEFFICIENT_LIMIT * TEN ** BigInt(places)) {
    throw new Error(`an exact decimal writes canonically with more than ${MAX_DIGITS} digits`);
  }
  return requireWithinDigitBound(normalized(coefficient, places));
}

function normalized(coefficient: bigint, places: number): ExactDecimal {
  let reduced = coefficient;
  let remaining = places;
  while (remaining > 0 && reduced % TEN === 0n) {
    reduced /= TEN;
    remaining -= 1;
  }
  return { coefficient: reduced, places: reduced === 0n ? 0 : remaining };
}

function scaledTo(value: ExactDecimal, places: number): bigint {
  return value.coefficient * TEN ** BigInt(places - value.places);
}

interface LiteralParts {
  readonly negative: boolean;
  readonly digits: string;
  readonly fractionDigits: number;
  readonly exponent: number;
}

function literalParts(text: string): LiteralParts | null {
  if (text.length > MAX_LITERAL_LENGTH) return null;
  const match = DECIMAL_LITERAL.exec(text);
  if (match === null) return null;
  const [, sign = "", whole = "", fraction = "", bareFraction = "", exponent = "0"] = match;
  const digits = `${whole}${fraction}${bareFraction}`;
  const exponentDigits = exponent.replace(/^[+-]/u, "");
  const power = Number(exponent);
  if (
    digits.length > MAX_DIGITS ||
    exponentDigits.length > MAX_EXPONENT_DIGITS ||
    !(Math.abs(power) <= MAX_EXPONENT_MAGNITUDE)
  ) {
    return null;
  }
  return {
    negative: sign === "-",
    digits: digits === "" ? "0" : digits,
    fractionDigits: fraction.length + bareFraction.length,
    exponent: power,
  };
}

export function parseExactDecimal(text: unknown): ExactDecimal {
  if (typeof text !== "string") throw new Error("a decimal literal is a string");
  const parts = literalParts(text);
  if (parts === null) {
    throw new Error(
      `the text is not a decimal literal with at most ${MAX_DIGITS} digits and an exponent of at most ${MAX_EXPONENT_DIGITS} digits whose magnitude is at most ${MAX_EXPONENT_MAGNITUDE}`,
    );
  }
  const places = parts.fractionDigits - parts.exponent;
  const significant = parts.digits.replace(/^0+/u, "");
  if (places < 0 && significant.length - places > MAX_DIGITS) {
    throw new Error(`the literal writes canonically with more than ${MAX_DIGITS} digits`);
  }
  const magnitude = BigInt(parts.digits) * (places < 0 ? TEN ** BigInt(-places) : 1n);
  const value = normalized(parts.negative ? -magnitude : magnitude, Math.max(places, 0));
  if (!withinDigitBound(value)) {
    throw new Error(`the literal writes canonically with more than ${MAX_DIGITS} digits`);
  }
  return value;
}

function withinDigitBound(value: ExactDecimal): boolean {
  const magnitude = value.coefficient < 0n ? -value.coefficient : value.coefficient;
  return value.places < MAX_DIGITS && magnitude < COEFFICIENT_LIMIT;
}

function requireWithinDigitBound(value: ExactDecimal): ExactDecimal {
  if (!withinDigitBound(value)) {
    throw new Error(`an exact decimal writes canonically with more than ${MAX_DIGITS} digits`);
  }
  return value;
}

export function formatExactDecimal(value: ExactDecimal): ExactDecimalText {
  const negative = value.coefficient < 0n;
  const digits = (negative ? -value.coefficient : value.coefficient)
    .toString()
    .padStart(value.places + 1, "0");
  const whole = digits.slice(0, digits.length - value.places);
  const fraction = digits.slice(digits.length - value.places);
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

export function isCanonicalExactDecimalText(text: unknown): text is ExactDecimalText {
  if (typeof text !== "string" || text.length > MAX_CANONICAL_LENGTH) return false;
  if (text === "-0" || !CANONICAL_DECIMAL.test(text)) return false;
  const digits = text.length - (text.startsWith("-") ? 1 : 0) - (text.includes(".") ? 1 : 0);
  return digits <= MAX_DIGITS;
}

export function addExactDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const places = Math.max(a.places, b.places);
  return requireWithinDigitBound(normalized(scaledTo(a, places) + scaledTo(b, places), places));
}

export function subtractExactDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const places = Math.max(a.places, b.places);
  return requireWithinDigitBound(normalized(scaledTo(a, places) - scaledTo(b, places), places));
}

export function multiplyExactDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  return requireWithinDigitBound(normalized(a.coefficient * b.coefficient, a.places + b.places));
}

export function compareExactDecimal(a: ExactDecimal, b: ExactDecimal): -1 | 0 | 1 {
  const places = Math.max(a.places, b.places);
  const difference = scaledTo(a, places) - scaledTo(b, places);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function exactDecimalEquals(a: ExactDecimal, b: ExactDecimal): boolean {
  return a.coefficient === b.coefficient && a.places === b.places;
}

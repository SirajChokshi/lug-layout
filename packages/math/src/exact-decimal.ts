export interface ExactDecimal {
  readonly units: bigint;
  readonly places: number;
}

const DECIMAL_LITERAL = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u;
const TEN = 10n;
const MAX_LITERAL_DIGITS = 1100;
const MAX_EXPONENT_MAGNITUDE = 1100;

export const EXACT_DECIMAL_ZERO: ExactDecimal = { units: 0n, places: 0 };

function normalized(units: bigint, places: number): ExactDecimal {
  let reduced = units;
  let remaining = places;
  while (remaining > 0 && reduced % TEN === 0n) {
    reduced /= TEN;
    remaining -= 1;
  }
  return { units: reduced, places: reduced === 0n ? 0 : remaining };
}

function scaledTo(value: ExactDecimal, places: number): bigint {
  return value.units * TEN ** BigInt(places - value.places);
}

interface LiteralParts {
  readonly negative: boolean;
  readonly digits: string;
  readonly fractionDigits: number;
  readonly shift: number;
}

function literalParts(text: string): LiteralParts | null {
  const match = DECIMAL_LITERAL.exec(text);
  if (match === null) return null;
  const [, sign = "", whole = "", fraction = "", bareFraction = "", exponent = "0"] = match;
  const digits = `${whole}${fraction}${bareFraction}`;
  const shift = Number(exponent);
  if (digits.length > MAX_LITERAL_DIGITS || !(Math.abs(shift) <= MAX_EXPONENT_MAGNITUDE)) {
    return null;
  }
  return {
    negative: sign === "-",
    digits: digits === "" ? "0" : digits,
    fractionDigits: fraction.length + bareFraction.length,
    shift,
  };
}

export function parseExactDecimal(text: string): ExactDecimal {
  const parts = literalParts(text);
  if (parts === null) {
    throw new Error(
      `"${text}" is not a decimal literal of at most ${MAX_LITERAL_DIGITS} digits and exponent magnitude ${MAX_EXPONENT_MAGNITUDE}`,
    );
  }
  const places = parts.fractionDigits - parts.shift;
  const magnitude = BigInt(parts.digits) * (places < 0 ? TEN ** BigInt(-places) : 1n);
  return normalized(parts.negative ? -magnitude : magnitude, Math.max(places, 0));
}

export function exactDecimalFromInteger(value: bigint): ExactDecimal {
  return { units: value, places: 0 };
}

export function formatExactDecimal(value: ExactDecimal): string {
  const negative = value.units < 0n;
  const digits = (negative ? -value.units : value.units).toString().padStart(value.places + 1, "0");
  const whole = digits.slice(0, digits.length - value.places);
  const fraction = digits.slice(digits.length - value.places);
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

export function isCanonicalExactDecimal(text: string): boolean {
  return literalParts(text) !== null && formatExactDecimal(parseExactDecimal(text)) === text;
}

export function addExactDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const places = Math.max(a.places, b.places);
  return normalized(scaledTo(a, places) + scaledTo(b, places), places);
}

export function subtractExactDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const places = Math.max(a.places, b.places);
  return normalized(scaledTo(a, places) - scaledTo(b, places), places);
}

export function multiplyExactDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  return normalized(a.units * b.units, a.places + b.places);
}

export function compareExactDecimal(a: ExactDecimal, b: ExactDecimal): -1 | 0 | 1 {
  const places = Math.max(a.places, b.places);
  const difference = scaledTo(a, places) - scaledTo(b, places);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

export function exactDecimalEquals(a: ExactDecimal, b: ExactDecimal): boolean {
  return a.units === b.units && a.places === b.places;
}

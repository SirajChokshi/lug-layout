export interface ExactDecimal {
  readonly units: bigint;
  readonly places: number;
}

const DECIMAL_LITERAL = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/u;
const TEN = 10n;

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

export function parseExactDecimal(text: string): ExactDecimal {
  const match = DECIMAL_LITERAL.exec(text);
  if (match === null) throw new Error(`"${text}" is not a decimal literal`);
  const [, sign = "", whole = "", fraction = "", bareFraction = "", exponent = "0"] = match;
  const fractionDigits = fraction + bareFraction;
  const shift = Number.parseInt(exponent, 10);
  const digits = BigInt(`${whole}${fractionDigits}` || "0");
  const places = fractionDigits.length - shift;
  const units = places < 0 ? digits * TEN ** BigInt(-places) : digits;
  return normalized(sign === "-" ? -units : units, Math.max(places, 0));
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
  return DECIMAL_LITERAL.test(text) && formatExactDecimal(parseExactDecimal(text)) === text;
}

export function addExactDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const places = Math.max(a.places, b.places);
  return normalized(scaledTo(a, places) + scaledTo(b, places), places);
}

export function subtractExactDecimal(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const places = Math.max(a.places, b.places);
  return normalized(scaledTo(a, places) - scaledTo(b, places), places);
}

export function negateExactDecimal(value: ExactDecimal): ExactDecimal {
  return { units: -value.units, places: value.places };
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

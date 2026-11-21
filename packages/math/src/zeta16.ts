export const ZETA16_ORDER = 16;
export const ZETA16_COEFFICIENT_COUNT = ZETA16_ORDER / 2;

export type Zeta16 = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

export interface PlaneStuds {
  readonly x: number;
  readonly z: number;
}

export const ZETA16_ZERO: Zeta16 = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n];

const COS_EIGHTH_TURN = Math.cos(Math.PI / 8);
const SIN_EIGHTH_TURN = Math.sin(Math.PI / 8);

function coefficientAt(value: ReadonlyArray<bigint>, power: number): bigint {
  const coefficient = value[power];
  if (coefficient === undefined) throw new Error(`ℤ[ζ₁₆] value has no coefficient ${power}`);
  return coefficient;
}

function fromPowers(at: (power: number) => bigint): Zeta16 {
  return [at(0), at(1), at(2), at(3), at(4), at(5), at(6), at(7)];
}

export function zeta16(coefficients: ReadonlyArray<bigint>): Zeta16 {
  if (coefficients.length !== ZETA16_COEFFICIENT_COUNT) {
    throw new Error(
      `ℤ[ζ₁₆] needs ${ZETA16_COEFFICIENT_COUNT} coefficients, got ${coefficients.length}`,
    );
  }
  return fromPowers((power) => coefficientAt(coefficients, power));
}

export function addZeta16(a: Zeta16, b: Zeta16): Zeta16 {
  return fromPowers((power) => coefficientAt(a, power) + coefficientAt(b, power));
}

export function subtractZeta16(a: Zeta16, b: Zeta16): Zeta16 {
  return fromPowers((power) => coefficientAt(a, power) - coefficientAt(b, power));
}

export function normalizeHeading16(steps: number): number {
  if (!Number.isInteger(steps)) throw new Error(`heading ${steps} is not a whole ζ₁₆ step`);
  return ((steps % ZETA16_ORDER) + ZETA16_ORDER) % ZETA16_ORDER;
}

export function rotateZeta16(value: Zeta16, steps: number): Zeta16 {
  const turns = normalizeHeading16(steps);
  return fromPowers((power) => {
    const source = power - turns;
    if (source >= 0) return coefficientAt(value, source);
    const wrapped = source + ZETA16_COEFFICIENT_COUNT;
    if (wrapped >= 0) return -coefficientAt(value, wrapped);
    return coefficientAt(value, wrapped + ZETA16_COEFFICIENT_COUNT);
  });
}

export function multiplyZeta16(a: Zeta16, b: Zeta16): Zeta16 {
  const product = Array.from({ length: ZETA16_COEFFICIENT_COUNT }, () => 0n);
  for (let i = 0; i < ZETA16_COEFFICIENT_COUNT; i++) {
    for (let j = 0; j < ZETA16_COEFFICIENT_COUNT; j++) {
      const term = coefficientAt(a, i) * coefficientAt(b, j);
      const power = i + j;
      if (power < ZETA16_COEFFICIENT_COUNT) product[power] = (product[power] ?? 0n) + term;
      else
        product[power - ZETA16_COEFFICIENT_COUNT] =
          (product[power - ZETA16_COEFFICIENT_COUNT] ?? 0n) - term;
    }
  }
  return zeta16(product);
}

export function conjugateZeta16(value: Zeta16): Zeta16 {
  return fromPowers((power) =>
    power === 0 ? coefficientAt(value, 0) : -coefficientAt(value, ZETA16_COEFFICIENT_COUNT - power),
  );
}

export function zeta16Equals(a: Zeta16, b: Zeta16): boolean {
  return a.every((coefficient, power) => coefficient === coefficientAt(b, power));
}

export function zeta16ToStuds(value: Zeta16): PlaneStuds {
  const [c0, c1, c2, c3, c4, c5, c6, c7] = value;
  return {
    x:
      Number(c0) +
      Number(c1 - c7) * COS_EIGHTH_TURN +
      Number(c2 - c6) * Math.SQRT1_2 +
      Number(c3 - c5) * SIN_EIGHTH_TURN,
    z:
      Number(c4) +
      Number(c3 + c5) * COS_EIGHTH_TURN +
      Number(c2 + c6) * Math.SQRT1_2 +
      Number(c1 + c7) * SIN_EIGHTH_TURN,
  };
}

const ZETA16_ONE: Zeta16 = [1n, 0n, 0n, 0n, 0n, 0n, 0n, 0n];

const HEADING_DIRECTIONS: ReadonlyArray<PlaneStuds> = Array.from(
  { length: ZETA16_ORDER },
  (_unused, heading) => zeta16ToStuds(rotateZeta16(ZETA16_ONE, heading)),
);

export function zeta16Direction(heading: number): PlaneStuds {
  const direction = HEADING_DIRECTIONS[normalizeHeading16(heading)];
  if (!direction) throw new Error(`no ζ₁₆ direction for heading ${heading}`);
  return direction;
}

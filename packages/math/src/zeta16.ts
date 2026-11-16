export const ZETA16_ORDER = 16;
export const ZETA16_COEFFICIENT_COUNT = ZETA16_ORDER / 2;

export type Zeta16 = readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

export interface PlaneStuds {
  readonly x: number;
  readonly z: number;
}

export const ZETA16_ZERO: Zeta16 = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n];

const STEP_RADIANS = (2 * Math.PI) / ZETA16_ORDER;

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

export function conjugateZeta16(value: Zeta16): Zeta16 {
  return fromPowers((power) =>
    power === 0 ? coefficientAt(value, 0) : -coefficientAt(value, ZETA16_COEFFICIENT_COUNT - power),
  );
}

export function zeta16Equals(a: Zeta16, b: Zeta16): boolean {
  return a.every((coefficient, power) => coefficient === coefficientAt(b, power));
}

export function zeta16ToStuds(value: Zeta16): PlaneStuds {
  let x = 0;
  let z = 0;
  value.forEach((coefficient, power) => {
    x += Number(coefficient) * Math.cos(power * STEP_RADIANS);
    z += Number(coefficient) * Math.sin(power * STEP_RADIANS);
  });
  return { x, z };
}

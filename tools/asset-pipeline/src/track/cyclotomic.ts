export const ZETA16_ORDER = 16;
export const ZETA16_COEFFICIENT_COUNT = ZETA16_ORDER / 2;

const STEP = (2 * Math.PI) / ZETA16_ORDER;
const SEARCH_BOUNDS = [4, 8, 16, 32, 64] as const;

export type Zeta16Coefficients = ReadonlyArray<bigint>;

export interface PlanePoint {
  readonly x: number;
  readonly y: number;
}

export interface FieldRepresentation {
  readonly coefficients: Zeta16Coefficients;
  readonly residual: number;
  readonly bound: number;
  readonly solutionsAtBound: number;
  readonly expectedChanceHitsPerAxis: number;
}

interface AxisHit {
  readonly rational: number;
  readonly first: number;
  readonly second: number;
  readonly third: number;
  readonly residual: number;
}

export function zeta16ToPlane(coefficients: Zeta16Coefficients): PlanePoint {
  let x = 0;
  let y = 0;
  coefficients.forEach((coefficient, power) => {
    x += Number(coefficient) * Math.cos(power * STEP);
    y += Number(coefficient) * Math.sin(power * STEP);
  });
  return { x, y };
}

export function addZeta16(a: Zeta16Coefficients, b: Zeta16Coefficients): Zeta16Coefficients {
  return a.map((value, power) => value + (b[power] ?? 0n));
}

export function rotateZeta16(coefficients: Zeta16Coefficients, steps: number): Zeta16Coefficients {
  const turns = ((steps % ZETA16_ORDER) + ZETA16_ORDER) % ZETA16_ORDER;
  let rotated = [...coefficients];
  for (let step = 0; step < turns; step += 1) {
    const top = rotated[ZETA16_COEFFICIENT_COUNT - 1] ?? 0n;
    rotated = [-top, ...rotated.slice(0, ZETA16_COEFFICIENT_COUNT - 1)];
  }
  return rotated;
}

export function mirrorZeta16(coefficients: Zeta16Coefficients): Zeta16Coefficients {
  return coefficients.map((_value, power) =>
    power === 0 ? (coefficients[0] ?? 0n) : -(coefficients[ZETA16_COEFFICIENT_COUNT - power] ?? 0n),
  );
}

function axisHits(
  target: number,
  basis: readonly [number, number, number],
  bound: number,
  tolerance: number,
): ReadonlyArray<AxisHit> {
  const hits: AxisHit[] = [];
  const [b1, b2, b3] = basis;
  for (let first = -bound; first <= bound; first += 1) {
    for (let second = -bound; second <= bound; second += 1) {
      for (let third = -bound; third <= bound; third += 1) {
        const irrational = first * b1 + second * b2 + third * b3;
        const rational = Math.round(target - irrational);
        if (Math.abs(rational) > bound * 4) continue;
        const residual = Math.abs(target - irrational - rational);
        if (residual <= tolerance) hits.push({ rational, first, second, third, residual });
      }
    }
  }
  return hits;
}

function sameParity(a: number, b: number): boolean {
  return (a - b) % 2 === 0;
}

function half(value: number): bigint {
  return BigInt(value / 2);
}

function combine(real: AxisHit, imaginary: AxisHit): Zeta16Coefficients | undefined {
  if (
    !sameParity(real.first, imaginary.first) ||
    !sameParity(real.second, imaginary.second) ||
    !sameParity(real.third, imaginary.third)
  ) {
    return undefined;
  }
  return [
    BigInt(real.rational),
    half(real.first + imaginary.first),
    half(real.second + imaginary.second),
    half(real.third + imaginary.third),
    BigInt(imaginary.rational),
    half(imaginary.third - real.third),
    half(imaginary.second - real.second),
    half(imaginary.first - real.first),
  ];
}

function l1Norm(coefficients: Zeta16Coefficients): bigint {
  return coefficients.reduce((sum, value) => sum + (value < 0n ? -value : value), 0n);
}

export function findZeta16Representation(
  point: PlanePoint,
  tolerance: number,
): FieldRepresentation | undefined {
  const realBasis = [Math.cos(STEP), Math.cos(2 * STEP), Math.cos(3 * STEP)] as const;
  const imaginaryBasis = [Math.sin(STEP), Math.sin(2 * STEP), Math.sin(3 * STEP)] as const;
  for (const bound of SEARCH_BOUNDS) {
    const realHits = axisHits(point.x, realBasis, bound, tolerance);
    const imaginaryHits = axisHits(point.y, imaginaryBasis, bound, tolerance);
    const solutions: Zeta16Coefficients[] = [];
    for (const real of realHits) {
      for (const imaginary of imaginaryHits) {
        const coefficients = combine(real, imaginary);
        if (coefficients !== undefined) solutions.push(coefficients);
      }
    }
    const best = solutions.toSorted((a, b) => Number(l1Norm(a) - l1Norm(b)))[0];
    if (best === undefined) continue;
    const exact = zeta16ToPlane(best);
    return {
      coefficients: best,
      residual: Math.hypot(exact.x - point.x, exact.y - point.y),
      bound,
      solutionsAtBound: solutions.length,
      expectedChanceHitsPerAxis: (2 * bound + 1) ** 3 * 2 * tolerance,
    };
  }
  return undefined;
}

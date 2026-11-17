import { ZETA16_ORDER, zeta16, zeta16ToStuds, type Zeta16 } from "./zeta16.ts";

export const ZETA16_STEP_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
export const COEFFICIENT_BOUND = 64;
export const CERTIFIED_RESIDUAL_LIMIT_LDU = 0.0005;
export const UNROUNDED_TOLERANCE_LDU = 1e-6;
const LDU_PER_STUD = 20;

interface PlanePoint {
  readonly x: number;
  readonly y: number;
}

export interface FieldRepresentation {
  readonly coefficients: Zeta16;
  readonly residual: number;
  readonly solutionCount: number;
}

interface AxisHit {
  readonly rational: number;
  readonly first: number;
  readonly second: number;
  readonly third: number;
  readonly residual: number;
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
        if (Math.abs(rational) > bound) continue;
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

function combine(real: AxisHit, imaginary: AxisHit): Zeta16 | undefined {
  if (
    !sameParity(real.first, imaginary.first) ||
    !sameParity(real.second, imaginary.second) ||
    !sameParity(real.third, imaginary.third)
  ) {
    return undefined;
  }
  return zeta16([
    BigInt(real.rational),
    half(real.first + imaginary.first),
    half(real.second + imaginary.second),
    half(real.third + imaginary.third),
    BigInt(imaginary.rational),
    half(imaginary.third - real.third),
    half(imaginary.second - real.second),
    half(imaginary.first - real.first),
  ]);
}

function l1Norm(coefficients: Zeta16): bigint {
  return coefficients.reduce((sum, value) => sum + (value < 0n ? -value : value), 0n);
}

export function findZeta16Representation(
  point: PlanePoint,
  tolerance: number,
): FieldRepresentation | undefined {
  const realBasis = [
    Math.cos(ZETA16_STEP_RADIANS),
    Math.cos(2 * ZETA16_STEP_RADIANS),
    Math.cos(3 * ZETA16_STEP_RADIANS),
  ] as const;
  const imaginaryBasis = [
    Math.sin(ZETA16_STEP_RADIANS),
    Math.sin(2 * ZETA16_STEP_RADIANS),
    Math.sin(3 * ZETA16_STEP_RADIANS),
  ] as const;
  const realHits = axisHits(point.x, realBasis, COEFFICIENT_BOUND, tolerance);
  const imaginaryHits = axisHits(point.y, imaginaryBasis, COEFFICIENT_BOUND, tolerance);
  const solutions: Zeta16[] = [];
  for (const real of realHits) {
    for (const imaginary of imaginaryHits) {
      const coefficients = combine(real, imaginary);
      if (coefficients !== undefined) solutions.push(coefficients);
    }
  }
  let best: Zeta16 | undefined;
  for (const candidate of solutions) {
    if (best === undefined || l1Norm(candidate) < l1Norm(best)) best = candidate;
  }
  if (best === undefined) return undefined;
  const exact = zeta16ToStuds(best);
  return {
    coefficients: best,
    residual: Math.hypot(exact.x - point.x, exact.z - point.y),
    solutionCount: solutions.length,
  };
}

export function certifiedZeta16(point: PlanePoint, toleranceLdu: number): Zeta16 | null {
  const field = findZeta16Representation(point, toleranceLdu / LDU_PER_STUD);
  const certified =
    field !== undefined &&
    field.solutionCount === 1 &&
    field.residual * LDU_PER_STUD <= CERTIFIED_RESIDUAL_LIMIT_LDU;
  return certified ? field.coefficients : null;
}

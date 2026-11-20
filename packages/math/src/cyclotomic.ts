import { ZETA16_ORDER, zeta16, zeta16ToStuds, type Zeta16 } from "./zeta16.ts";
import { STUD_LDU } from "./units.ts";

export const ZETA16_STEP_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
export const COEFFICIENT_BOUND = 64;
export const CERTIFIED_RESIDUAL_LIMIT_LDU = 0.0005;
export const UNROUNDED_TOLERANCE_LDU = 1e-6;
export const IDENTIFICATION_REPRESENTATION_GUARD_LDU = 1e-9;
export const IDENTIFICATION_ACCEPTED_DEVIATION_LDU =
  CERTIFIED_RESIDUAL_LIMIT_LDU + IDENTIFICATION_REPRESENTATION_GUARD_LDU;
const LDU_PER_STUD = STUD_LDU;

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

const PAIR_WINDOW_SLACK = 1e-9;

interface PairTable {
  readonly fractions: Float64Array;
  readonly first: Int32Array;
  readonly second: Int32Array;
}

const pairTables = new Map<string, PairTable>();

function fraction(value: number): number {
  return value - Math.floor(value);
}

function pairTable(b1: number, b2: number, bound: number): PairTable {
  const key = `${b1}:${b2}:${bound}`;
  const cached = pairTables.get(key);
  if (cached) return cached;
  const side = 2 * bound + 1;
  const count = side * side;
  const order = Array.from({ length: count }, (_, i) => i);
  const values = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const first = Math.floor(i / side) - bound;
    const second = (i % side) - bound;
    values[i] = fraction(first * b1 + second * b2);
  }
  order.sort((a, b) => (values[a] ?? 0) - (values[b] ?? 0));
  const table: PairTable = {
    fractions: Float64Array.from(order, (i) => values[i] ?? 0),
    first: Int32Array.from(order, (i) => Math.floor(i / side) - bound),
    second: Int32Array.from(order, (i) => (i % side) - bound),
  };
  pairTables.set(key, table);
  return table;
}

function firstAtLeast(sorted: Float64Array, value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] ?? 0) < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

function axisHits(
  target: number,
  basis: readonly [number, number, number],
  bound: number,
  tolerance: number,
): ReadonlyArray<AxisHit> {
  const hits: AxisHit[] = [];
  const [b1, b2, b3] = basis;
  const table = pairTable(b1, b2, bound);
  const window = tolerance + PAIR_WINDOW_SLACK;
  const consider = (index: number, third: number): void => {
    const first = table.first[index] ?? 0;
    const second = table.second[index] ?? 0;
    const irrational = first * b1 + second * b2 + third * b3;
    const rational = Math.round(target - irrational);
    if (Math.abs(rational) > bound) return;
    const residual = Math.abs(target - irrational - rational);
    if (residual <= tolerance) hits.push({ rational, first, second, third, residual });
  };
  const scan = (low: number, high: number, third: number): void => {
    const end = firstAtLeast(table.fractions, high);
    for (let index = firstAtLeast(table.fractions, low); index < end; index++) {
      consider(index, third);
    }
  };
  for (let third = -bound; third <= bound; third += 1) {
    if (2 * window >= 1) {
      scan(0, Number.POSITIVE_INFINITY, third);
      continue;
    }
    const wanted = fraction(target - third * b3);
    scan(Math.max(0, wanted - window), wanted + window, third);
    if (wanted - window < 0) scan(1 + wanted - window, 1, third);
    if (wanted + window >= 1) scan(0, wanted + window - 1, third);
  }
  hits.sort(
    (a: AxisHit, b: AxisHit) => a.first - b.first || a.second - b.second || a.third - b.third,
  );
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
    residual: Math.max(Math.abs(exact.x - point.x), Math.abs(exact.z - point.y)),
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

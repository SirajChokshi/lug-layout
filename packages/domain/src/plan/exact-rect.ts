import type { LduRect } from "./plan-region.ts";

export interface ExactRect {
  readonly minX: bigint;
  readonly minZ: bigint;
  readonly maxX: bigint;
  readonly maxZ: bigint;
}

interface Dyadic {
  readonly mantissa: bigint;
  readonly exponent: number;
}

const FLOAT64_BYTES = 8;
const MANTISSA_BITS = 52n;
const EXPONENT_MASK = 0x7ff;
const EXPONENT_BIAS_WITH_MANTISSA = 1075;
const SUBNORMAL_EXPONENT = -1074;
const HIGH_MANTISSA_MASK = 0xfffff;
const SAFE_BITS = 60;
const LDU_PER_TENTH_MM_NUMERATOR = 4n;
const MM2_PER_LDU2_NUMERATOR = 4n;
const MM2_PER_LDU2_DENOMINATOR = 25n;

export function dyadic(value: number): Dyadic {
  if (value === 0) return { mantissa: 0n, exponent: 0 };
  const view = new DataView(new ArrayBuffer(FLOAT64_BYTES));
  view.setFloat64(0, value);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const biased = (high >>> 20) & EXPONENT_MASK;
  let mantissa = (BigInt(high & HIGH_MANTISSA_MASK) << 32n) | BigInt(low);
  let exponent = SUBNORMAL_EXPONENT;
  if (biased !== 0) {
    mantissa |= 1n << MANTISSA_BITS;
    exponent = biased - EXPONENT_BIAS_WITH_MANTISSA;
  }
  while ((mantissa & 1n) === 0n) {
    mantissa >>= 1n;
    exponent++;
  }
  return { mantissa: high >>> 31 === 1 ? -mantissa : mantissa, exponent };
}

function unscaled(value: bigint, shift: number): number {
  const bits = value.toString(2).replace("-", "").length;
  const drop = Math.max(0, bits - SAFE_BITS);
  return Number(value >> BigInt(drop)) * 2 ** (drop - shift);
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator;
  return quotient * denominator < numerator ? quotient + 1n : quotient;
}

export class ExactFrame {
  readonly shift: number;

  constructor(values: ReadonlyArray<number>) {
    const lowest = values.reduce((low, value) => Math.min(low, dyadic(value).exponent), 0);
    this.shift = 1 - lowest;
  }

  of(value: number): bigint {
    const { mantissa, exponent } = dyadic(value);
    return mantissa << BigInt(exponent + this.shift);
  }

  rect(rect: LduRect): ExactRect {
    return {
      minX: this.of(rect.minX),
      minZ: this.of(rect.minZ),
      maxX: this.of(rect.maxX),
      maxZ: this.of(rect.maxZ),
    };
  }

  toLdu(value: bigint): number {
    return unscaled(value, this.shift);
  }

  toMm2(lduSquared: bigint): number {
    return (
      (unscaled(lduSquared, 2 * this.shift) * Number(MM2_PER_LDU2_NUMERATOR)) /
      Number(MM2_PER_LDU2_DENOMINATOR)
    );
  }

  ceilTenthsOfMm(ldu: bigint): number {
    return Number(ceilDiv(ldu * LDU_PER_TENTH_MM_NUMERATOR, 1n << BigInt(this.shift))) / 10;
  }

  ceilMm2(lduSquared: bigint): number {
    return Number(
      ceilDiv(
        lduSquared * MM2_PER_LDU2_NUMERATOR,
        MM2_PER_LDU2_DENOMINATOR << BigInt(2 * this.shift),
      ),
    );
  }
}

export function exactOverlap(a: ExactRect, b: ExactRect): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minZ < b.maxZ && b.minZ < a.maxZ;
}

function bigMax(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

function bigMin(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function exactSubtract(from: ExactRect, cut: ExactRect): ExactRect[] {
  if (!exactOverlap(from, cut)) return [from];
  const pieces: ExactRect[] = [];
  if (from.minX < cut.minX) pieces.push({ ...from, maxX: cut.minX });
  if (cut.maxX < from.maxX) pieces.push({ ...from, minX: cut.maxX });
  const minX = bigMax(from.minX, cut.minX);
  const maxX = bigMin(from.maxX, cut.maxX);
  if (from.minZ < cut.minZ) pieces.push({ minX, maxX, minZ: from.minZ, maxZ: cut.minZ });
  if (cut.maxZ < from.maxZ) pieces.push({ minX, maxX, minZ: cut.maxZ, maxZ: from.maxZ });
  return pieces;
}

export function exactGrown(rect: ExactRect, by: bigint): ExactRect {
  return { minX: rect.minX - by, minZ: rect.minZ - by, maxX: rect.maxX + by, maxZ: rect.maxZ + by };
}

export function exactUncovered(box: ExactRect, covers: ReadonlyArray<ExactRect>): ExactRect[] {
  let remaining: ExactRect[] = [box];
  for (const cover of covers) {
    remaining = remaining.flatMap((piece) => exactSubtract(piece, cover));
    if (remaining.length === 0) break;
  }
  return remaining;
}

export function exactArea(rects: ReadonlyArray<ExactRect>): bigint {
  return rects.reduce((sum, r) => sum + (r.maxX - r.minX) * (r.maxZ - r.minZ), 0n);
}

export function exactCoveredWithin(
  box: ExactRect,
  tables: ReadonlyArray<ExactRect>,
  reach: bigint,
): boolean {
  return (
    exactUncovered(
      box,
      tables.map((table) => exactGrown(table, reach)),
    ).length === 0
  );
}

function reachCandidates(box: ExactRect, tables: ReadonlyArray<ExactRect>): bigint[] {
  const candidates = new Set<bigint>([0n]);
  const add = (value: bigint): void => {
    if (value > 0n) candidates.add(value);
  };
  tables.forEach((table, i) => {
    for (const [boxMin, boxMax, tableMin, tableMax] of [
      [box.minX, box.maxX, table.minX, table.maxX],
      [box.minZ, box.maxZ, table.minZ, table.maxZ],
    ] as const) {
      add(tableMin - boxMin);
      add(boxMax - tableMax);
      add(tableMin - boxMax);
      add(boxMin - tableMax);
    }
    for (const other of tables.slice(i + 1)) {
      add((other.minX - table.maxX) / 2n);
      add((table.minX - other.maxX) / 2n);
      add((other.minZ - table.maxZ) / 2n);
      add((table.minZ - other.maxZ) / 2n);
    }
  });
  return [...candidates];
}

export function exactReach(box: ExactRect, tables: ReadonlyArray<ExactRect>): bigint {
  const candidates = reachCandidates(box, tables);
  const covering = candidates.filter((r) => exactCoveredWithin(box, tables, r));
  if (covering.length === 0) return candidates.reduce(bigMax);
  return covering.reduce(bigMin);
}

export function exactNearest(box: ExactRect, tables: ReadonlyArray<ExactRect>): bigint {
  return (
    tables.reduce<bigint | null>((nearest, table) => {
      const gapX = bigMax(bigMax(table.minX - box.maxX, box.minX - table.maxX), 0n);
      const gapZ = bigMax(bigMax(table.minZ - box.maxZ, box.minZ - table.maxZ), 0n);
      const gap = bigMax(gapX, gapZ);
      return nearest === null ? gap : bigMin(nearest, gap);
    }, null) ?? 0n
  );
}

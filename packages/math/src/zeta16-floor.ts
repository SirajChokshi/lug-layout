import type { Zeta16 } from "./zeta16.ts";

export interface FloorStuds {
  readonly x: bigint;
  readonly z: bigint;
}

const FIRST_PRECISION_BITS = 64n;
const MAX_PRECISION_BITS = 8192n;

interface FixedBasis {
  readonly bits: bigint;
  readonly cosEighth: bigint;
  readonly halfRootTwo: bigint;
  readonly cosThreeEighths: bigint;
}

function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError("isqrt of a negative number");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

function fixedBasis(bits: bigint): FixedBasis {
  const square = 1n << (2n * bits);
  const half = square >> 1n;
  const rootTwoQuarter = isqrt((square * square) >> 3n);
  return {
    bits,
    cosEighth: isqrt(half + rootTwoQuarter),
    halfRootTwo: isqrt(half),
    cosThreeEighths: isqrt(half - rootTwoQuarter - 1n),
  };
}

const bases = new Map<bigint, FixedBasis>();

function basisAt(bits: bigint): FixedBasis {
  let basis = bases.get(bits);
  if (!basis) {
    basis = fixedBasis(bits);
    bases.set(bits, basis);
  }
  return basis;
}

function magnitude(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function floorOf(
  whole: bigint,
  cosEighth: bigint,
  halfRootTwo: bigint,
  cosThreeEighths: bigint,
): bigint {
  if (cosEighth === 0n && halfRootTwo === 0n && cosThreeEighths === 0n) return whole;
  const slack =
    2n * (magnitude(cosEighth) + magnitude(halfRootTwo) + magnitude(cosThreeEighths)) + 1n;
  for (let bits = FIRST_PRECISION_BITS; bits <= MAX_PRECISION_BITS; bits *= 2n) {
    const basis = basisAt(bits);
    const scaled =
      (whole << bits) +
      cosEighth * basis.cosEighth +
      halfRootTwo * basis.halfRootTwo +
      cosThreeEighths * basis.cosThreeEighths;
    const low = (scaled - slack) >> bits;
    if (low === (scaled + slack) >> bits) return low;
  }
  throw new RangeError("ℤ[ζ₁₆] floor did not settle within the precision limit");
}

export function zeta16FloorStuds(value: Zeta16): FloorStuds {
  const [c0, c1, c2, c3, c4, c5, c6, c7] = value;
  return {
    x: floorOf(c0, c1 - c7, c2 - c6, c3 - c5),
    z: floorOf(c4, c3 + c5, c2 + c6, c1 + c7),
  };
}

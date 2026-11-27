const ISO_5455_MANTISSAS = [1, 2, 5] as const;
const DECADE = 10;
const LARGEST_DENOMINATOR = 10_000;

function isoDenominators(): ReadonlyArray<number> {
  const denominators: number[] = [];
  for (let decade = 1; decade <= LARGEST_DENOMINATOR; decade *= DECADE) {
    for (const mantissa of ISO_5455_MANTISSAS) {
      const denominator = mantissa * decade;
      if (denominator <= LARGEST_DENOMINATOR) denominators.push(denominator);
    }
  }
  return denominators;
}

export const ISO_SCALE_DENOMINATORS: ReadonlyArray<number> = isoDenominators();

export const TILED_SCALE_DENOMINATORS: ReadonlyArray<number> = ISO_SCALE_DENOMINATORS.filter(
  (denominator) => denominator <= 100,
);

export function isIsoScale(denominator: number): boolean {
  return ISO_SCALE_DENOMINATORS.includes(denominator);
}

export function largestFittingScale(fits: (denominator: number) => boolean): number {
  for (const denominator of ISO_SCALE_DENOMINATORS) {
    if (fits(denominator)) return denominator;
  }
  return LARGEST_DENOMINATOR;
}

export function scaleText(denominator: number): string {
  return `1:${denominator.toLocaleString("en-US")}`;
}

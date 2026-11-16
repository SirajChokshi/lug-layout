const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
const INT16_MIN = -(2 ** 15);
const INT16_MAX = 2 ** 15 - 1;

function isIntegerIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function isLatticePose(x: number, z: number, yPlates: number): boolean {
  return (
    isIntegerIn(x, INT32_MIN, INT32_MAX) &&
    isIntegerIn(z, INT32_MIN, INT32_MAX) &&
    isIntegerIn(yPlates, INT16_MIN, INT16_MAX)
  );
}

export const LATTICE_LIMITS = { INT32_MIN, INT32_MAX } as const;

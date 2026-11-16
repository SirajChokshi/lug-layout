export type Rot90 = 0 | 1 | 2 | 3;

const QUARTER_TURN_COS = Int8Array.of(1, 0, -1, 0);
const QUARTER_TURN_SIN = Int8Array.of(0, 1, 0, -1);

export function isRot90(value: number): value is Rot90 {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

export function rot90Cos(rot: Rot90): number {
  return QUARTER_TURN_COS[rot] ?? 1;
}

export function rot90Sin(rot: Rot90): number {
  return QUARTER_TURN_SIN[rot] ?? 0;
}

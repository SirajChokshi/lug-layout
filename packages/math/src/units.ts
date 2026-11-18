export const STUD_LDU = 20;
export const PLATE_LDU = 8;
export const BRICK_LDU = 24;
export const CHUNK_STUDS = 32;
export const CHUNK_LDU = CHUNK_STUDS * STUD_LDU;
export const MM_PER_LDU_NUMERATOR = 2;
export const MM_PER_LDU_DENOMINATOR = 5;
export const MM_PER_STUD = (STUD_LDU * MM_PER_LDU_NUMERATOR) / MM_PER_LDU_DENOMINATOR;

export function lduFromMm(mm: number): number {
  return (mm * MM_PER_LDU_DENOMINATOR) / MM_PER_LDU_NUMERATOR;
}

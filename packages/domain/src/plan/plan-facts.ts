export const FACT_STRIDE = 8;
export const FACT_FLAGS = 0;
export const FACT_OVERLAP_SEGMENT = 1;
export const FACT_OVERLAP_SOURCE = 2;
export const FACT_ROAD_JOINED = 3;
export const FACT_ROAD_MISMATCHED = 4;
export const FACT_UNMAPPED_REBRICKABLE = 5;
export const FACT_UNMAPPED_BRICKLINK = 6;
export const FACT_CUSTOM_PARTS = 7;
export const FLAG_UNMEASURED = 1;
export const NO_OVERLAP_PARTNER = -1;

export interface PlacementFacts {
  readonly unmeasured: boolean;
  readonly overlapWith: string | null;
  readonly roadJoinedCells: number;
  readonly roadMismatchedCells: number;
  readonly unmappedRebrickable: number;
  readonly unmappedBrickLink: number;
}

export function clearFacts(facts: Int32Array, at: number): void {
  for (let k = 0; k < FACT_STRIDE; k++) facts[at + k] = 0;
  facts[at + FACT_OVERLAP_SEGMENT] = NO_OVERLAP_PARTNER;
  facts[at + FACT_OVERLAP_SOURCE] = NO_OVERLAP_PARTNER;
}

export function copyFacts(from: Int32Array, fromAt: number, to: Int32Array, toAt: number): void {
  for (let k = 0; k < FACT_STRIDE; k++) to[toAt + k] = from[fromAt + k] ?? 0;
}

export function emptyFacts(): Int32Array {
  const facts = new Int32Array(FACT_STRIDE);
  clearFacts(facts, 0);
  return facts;
}

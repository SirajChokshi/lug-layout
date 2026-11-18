import { PROFILE_CROSS, PROFILE_ROUND } from "./connector-table.ts";

export function profilesFit(
  maleProfile: number,
  maleRadius: number,
  femaleProfile: number,
  femaleRadius: number,
): boolean {
  const roundInCross = maleProfile === PROFILE_ROUND && femaleProfile === PROFILE_CROSS;
  return maleRadius === femaleRadius && !roundInCross;
}

export function maxAxialOffset(maleReach: number, femaleReach: number): number {
  return Math.max(0, Math.floor(maleReach - femaleReach));
}

export function axialOffsetEngages(
  offset: number,
  maleReach: number,
  femaleReach: number,
): boolean {
  return offset >= 0 && offset <= maxAxialOffset(maleReach, femaleReach);
}

export interface PierCourses {
  readonly tall: number;
  readonly short: number;
}

export function pierCourses(
  heightPlates: number,
  tallPlates: number,
  shortPlates: number,
): PierCourses | null {
  if (!Number.isInteger(heightPlates) || heightPlates <= 0) return null;
  if (!Number.isInteger(tallPlates) || !Number.isInteger(shortPlates)) return null;
  if (tallPlates <= 0 || shortPlates <= 0) return null;
  for (let tall = Math.floor(heightPlates / tallPlates); tall >= 0; tall--) {
    const rest = heightPlates - tall * tallPlates;
    if (rest % shortPlates === 0) return { tall, short: rest / shortPlates };
  }
  return null;
}

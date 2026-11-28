import { STUD_LDU, zeta16Direction, zeta16ToStuds, type Pose16, planeHypot } from "@brr/math";

export interface JoinTarget {
  readonly index: number;
  readonly distanceLdu: number;
}

const JOIN_SEARCH_RADIUS_LDU = 96 * STUD_LDU;
const JOIN_TARGETS = 4;

function targetAhead(start: Pose16, end: Pose16, index: number): JoinTarget | null {
  const from = zeta16ToStuds(start.position);
  const to = zeta16ToStuds(end.position);
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const facing = zeta16Direction(start.heading);
  if (dx * facing.x + dz * facing.z <= 0) return null;
  const distanceLdu = planeHypot(dx, dz) * STUD_LDU;
  return distanceLdu <= JOIN_SEARCH_RADIUS_LDU ? { index, distanceLdu } : null;
}

export function joinTargets(ends: ReadonlyArray<Pose16>, from: number): ReadonlyArray<JoinTarget> {
  const start = ends[from];
  if (!start) throw new RangeError(`there is no open end ${from}`);
  return ends
    .flatMap((end, index) => (index === from ? [] : (targetAhead(start, end, index) ?? [])))
    .toSorted((a, b) => a.distanceLdu - b.distanceLdu)
    .slice(0, JOIN_TARGETS);
}

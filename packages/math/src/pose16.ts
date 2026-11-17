import {
  addZeta16,
  normalizeHeading16,
  rotateZeta16,
  subtractZeta16,
  ZETA16_ORDER,
  ZETA16_ZERO,
  zeta16Equals,
  type Zeta16,
} from "./zeta16.ts";

export const HALF_TURN_16 = ZETA16_ORDER / 2;
export const QUARTER_TURN_16 = ZETA16_ORDER / 4;

export interface Pose16 {
  readonly position: Zeta16;
  readonly heading: number;
}

export const POSE16_IDENTITY: Pose16 = { position: ZETA16_ZERO, heading: 0 };

export function pose16(position: Zeta16, heading: number): Pose16 {
  return { position, heading: normalizeHeading16(heading) };
}

export function composePose16(frame: Pose16, local: Pose16): Pose16 {
  return pose16(
    addZeta16(frame.position, rotateZeta16(local.position, frame.heading)),
    frame.heading + local.heading,
  );
}

export function attachPose16(localEnd: Pose16, target: Pose16): Pose16 {
  const heading = target.heading + HALF_TURN_16 - localEnd.heading;
  return pose16(subtractZeta16(target.position, rotateZeta16(localEnd.position, heading)), heading);
}

export function posesJoin16(a: Pose16, b: Pose16): boolean {
  return (
    zeta16Equals(a.position, b.position) &&
    normalizeHeading16(a.heading - b.heading) === HALF_TURN_16
  );
}

export function nearestQuarterTurn16(heading: number): number {
  const turns = Math.round(normalizeHeading16(heading) / QUARTER_TURN_16);
  return normalizeHeading16(turns * QUARTER_TURN_16);
}

export function isLatticePose16(pose: Pose16): boolean {
  return (
    normalizeHeading16(pose.heading) % QUARTER_TURN_16 === 0 &&
    pose.position.every((coefficient, power) => power % QUARTER_TURN_16 === 0 || coefficient === 0n)
  );
}

export function pose16Equals(a: Pose16, b: Pose16): boolean {
  return (
    zeta16Equals(a.position, b.position) &&
    normalizeHeading16(a.heading) === normalizeHeading16(b.heading)
  );
}

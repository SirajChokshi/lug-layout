import { IDENTIFICATION_ACCEPTED_DEVIATION_LDU, ZETA16_ORDER } from "@brr/math";
import { OUTLINE_UNITS_PER_LDU, type PlanOutline, type TrackPartFrame } from "@brr/schema/bundle";

const HALF_STEP_RADIANS = Math.PI / ZETA16_ORDER;

function identifiedLdu(ldu: number): number | null {
  const whole = Math.round(ldu);
  return Math.abs(ldu - whole) <= IDENTIFICATION_ACCEPTED_DEVIATION_LDU ? whole : null;
}

export function pieceFrameOutline(partRings: PlanOutline, frame: TrackPartFrame): PlanOutline {
  const x = identifiedLdu(frame.xLdu);
  const z = identifiedLdu(frame.zLdu);
  if (frame.headingHalfSteps === 0 && x !== null && z !== null) {
    const dx = x * OUTLINE_UNITS_PER_LDU;
    const dz = z * OUTLINE_UNITS_PER_LDU;
    return partRings.map((ring) => ring.map(([px, pz]): [number, number] => [px + dx, pz + dz]));
  }
  const phi = frame.headingHalfSteps * HALF_STEP_RADIANS;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  const ox = frame.xLdu * OUTLINE_UNITS_PER_LDU;
  const oz = frame.zLdu * OUTLINE_UNITS_PER_LDU;
  return partRings.map((ring) =>
    ring.map(([px, pz]): [number, number] => [
      Math.round(ox + c * px - s * pz),
      Math.round(oz + s * px + c * pz),
    ]),
  );
}

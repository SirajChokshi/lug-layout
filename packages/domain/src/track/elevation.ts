import { BRICK_LDU, PLATE_LDU } from "@brr/math";

export const PLATES_PER_BRICK = BRICK_LDU / PLATE_LDU;

export interface RiserCourses {
  readonly bricks: number;
  readonly plates: number;
}

export function riserCourses(heightPlates: number): RiserCourses {
  if (!Number.isInteger(heightPlates) || heightPlates < 0) {
    throw new RangeError(`a riser can't be ${heightPlates} plates tall`);
  }
  return {
    bricks: Math.floor(heightPlates / PLATES_PER_BRICK),
    plates: heightPlates % PLATES_PER_BRICK,
  };
}

export function rampRises(
  fromPlates: number,
  toPlates: number,
  preferred: ReadonlyArray<boolean>,
  maxRisePlates: number,
): Int8Array | null {
  if (!Number.isInteger(fromPlates) || !Number.isInteger(toPlates)) {
    throw new RangeError(`ramp heights ${fromPlates} → ${toPlates} must be whole plates`);
  }
  if (!Number.isInteger(maxRisePlates) || maxRisePlates < 0) {
    throw new RangeError(`a ramp can't rise ${maxRisePlates} plates per piece`);
  }
  const rises = new Int8Array(preferred.length);
  const direction = Math.sign(toPlates - fromPlates);
  let remaining = Math.abs(toPlates - fromPlates);
  for (const wanted of [true, false]) {
    for (let piece = 0; piece < preferred.length && remaining > 0; piece++) {
      if (preferred[piece] !== wanted) continue;
      const step = Math.min(maxRisePlates, remaining);
      rises[piece] = direction * step;
      remaining -= step;
    }
  }
  return remaining === 0 ? rises : null;
}

export interface TrackSpan {
  readonly bottomLdu: number;
  readonly railTopLdu: number;
}

export type CrossingVerdict =
  | { readonly kind: "clear"; readonly upper: 0 | 1; readonly gapLdu: number }
  | {
      readonly kind: "low";
      readonly upper: 0 | 1;
      readonly gapLdu: number;
      readonly needLdu: number;
    }
  | { readonly kind: "intersects" };

export function crossing(a: TrackSpan, b: TrackSpan, envelopeLdu: number): CrossingVerdict {
  const upper = a.bottomLdu >= b.railTopLdu ? 0 : b.bottomLdu >= a.railTopLdu ? 1 : null;
  if (upper === null) return { kind: "intersects" };
  const [high, low] = upper === 0 ? [a, b] : [b, a];
  const gapLdu = high.bottomLdu - low.railTopLdu;
  return gapLdu >= envelopeLdu
    ? { kind: "clear", upper, gapLdu }
    : { kind: "low", upper, gapLdu, needLdu: envelopeLdu };
}

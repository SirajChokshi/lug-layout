import {
  HALF_TURN_16,
  STUD_LDU,
  ZETA16_ORDER,
  normalizeHeading16,
  posesJoin16,
  zeta16ToStuds,
  type Pose16,
} from "@brr/math";

export interface TrackFrame {
  readonly id: number;
  readonly xLdu: number;
  readonly zLdu: number;
}

export const WORLD_TRACK_FRAME: TrackFrame = { id: 0, xLdu: 0, zLdu: 0 };

export interface TrackEnd {
  readonly pose: Pose16;
  readonly yPlates: number;
  readonly instance?: number;
  readonly frame: TrackFrame;
}

export function trackEndsJoin(a: TrackEnd, b: TrackEnd): boolean {
  return a.frame.id === b.frame.id && a.yPlates === b.yPlates && posesJoin16(a.pose, b.pose);
}

export interface EndGap {
  readonly a: number;
  readonly b: number;
  readonly gapLdu: number;
  readonly headingErrorSteps: number;
}

export const NEAR_MISS_RADIUS_LDU = 4 * STUD_LDU;

interface PlacedEnd {
  readonly index: number;
  readonly x: number;
  readonly z: number;
  readonly end: TrackEnd;
}

function signedHeadingError(a: Pose16, b: Pose16): number {
  const error = normalizeHeading16(a.heading - b.heading - HALF_TURN_16);
  return error > HALF_TURN_16 ? error - ZETA16_ORDER : error;
}

function cellKey(cellX: number, cellZ: number, yPlates: number): string {
  return `${yPlates}:${cellX}:${cellZ}`;
}

export function endGaps(
  ends: ReadonlyArray<TrackEnd>,
  radiusLdu: number = NEAR_MISS_RADIUS_LDU,
): ReadonlyArray<EndGap> {
  if (!(radiusLdu > 0)) throw new RangeError(`near-miss radius ${radiusLdu} LDU is not positive`);
  const cells = new Map<string, PlacedEnd[]>();
  const placed = ends.map((end, index): PlacedEnd => {
    const studs = zeta16ToStuds(end.pose.position);
    return {
      index,
      x: studs.x * STUD_LDU + end.frame.xLdu,
      z: studs.z * STUD_LDU + end.frame.zLdu,
      end,
    };
  });
  for (const end of placed) {
    const key = cellKey(
      Math.floor(end.x / radiusLdu),
      Math.floor(end.z / radiusLdu),
      end.end.yPlates,
    );
    const bucket = cells.get(key);
    if (bucket) bucket.push(end);
    else cells.set(key, [end]);
  }
  const gaps: EndGap[] = [];
  for (const a of placed) {
    const cellX = Math.floor(a.x / radiusLdu);
    const cellZ = Math.floor(a.z / radiusLdu);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        for (const b of cells.get(cellKey(cellX + dx, cellZ + dz, a.end.yPlates)) ?? []) {
          if (b.index <= a.index || trackEndsJoin(a.end, b.end)) continue;
          const gapLdu = Math.hypot(b.x - a.x, b.z - a.z);
          if (gapLdu > radiusLdu) continue;
          gaps.push({
            a: a.index,
            b: b.index,
            gapLdu,
            headingErrorSteps: signedHeadingError(a.end.pose, b.end.pose),
          });
        }
      }
    }
  }
  return gaps;
}

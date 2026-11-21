export interface PlanPose {
  readonly x: number;
  readonly z: number;
  readonly heading: number;
}

export type SimPathSegment =
  | { readonly kind: "straight"; readonly lengthLdu: number }
  | { readonly kind: "arc"; readonly radiusLdu: number; readonly sweepRadians: number };

export interface PlacedSegment {
  readonly x: number;
  readonly z: number;
  readonly heading: number;
  readonly curvature: number;
  readonly length: number;
}

const FULL_TURN = 2 * Math.PI;

export function wrapAngle(angle: number): number {
  const wrapped = (((angle + Math.PI) % FULL_TURN) + FULL_TURN) % FULL_TURN;
  return wrapped - Math.PI;
}

export function pointOnSegment(segment: PlacedSegment, s: number): PlanPose {
  const k = segment.curvature;
  const h = segment.heading;
  if (k === 0) {
    return { x: segment.x + s * Math.cos(h), z: segment.z + s * Math.sin(h), heading: h };
  }
  const turned = h + k * s;
  return {
    x: segment.x + (Math.sin(turned) - Math.sin(h)) / k,
    z: segment.z - (Math.cos(turned) - Math.cos(h)) / k,
    heading: turned,
  };
}

function curvatureAndLength(segment: SimPathSegment): readonly [number, number] {
  switch (segment.kind) {
    case "straight":
      return [0, segment.lengthLdu];
    case "arc":
      return [
        Math.sign(segment.sweepRadians) / segment.radiusLdu,
        segment.radiusLdu * Math.abs(segment.sweepRadians),
      ];
    default: {
      const unhandled: never = segment;
      throw new Error(`unhandled segment ${String(unhandled)}`);
    }
  }
}

export function placeSegments(
  from: PlanPose,
  segments: ReadonlyArray<SimPathSegment>,
): PlacedSegment[] {
  const placed: PlacedSegment[] = [];
  let at = from;
  for (const segment of segments) {
    const [curvature, length] = curvatureAndLength(segment);
    const piece = { x: at.x, z: at.z, heading: at.heading, curvature, length };
    placed.push(piece);
    at = pointOnSegment(piece, length);
  }
  return placed;
}

export function segmentsEnd(from: PlanPose, placed: ReadonlyArray<PlacedSegment>): PlanPose {
  const last = placed.at(-1);
  return last ? pointOnSegment(last, last.length) : from;
}

export function reversedSegments(segments: ReadonlyArray<PlacedSegment>): PlacedSegment[] {
  const reversed: PlacedSegment[] = [];
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (!segment) continue;
    const end = pointOnSegment(segment, segment.length);
    reversed.push({
      x: end.x,
      z: end.z,
      heading: end.heading + Math.PI,
      curvature: -segment.curvature,
      length: segment.length,
    });
  }
  return reversed;
}

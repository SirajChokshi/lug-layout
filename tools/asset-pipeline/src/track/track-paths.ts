import { onRailHead, type PlanPoint, type RailHeads } from "./rail-heads.ts";

const SAMPLE_STEP_LDU = 2;
const ENDPOINT_TOLERANCE_LDU = 1e-6;
const DEGENERATE_SEGMENT_LDU = 1e-6;
const ANGLE_EPSILON = 1e-9;
const MINIMUM_RAIL_COVERAGE = 0.8;

export type PathSegment =
  | { readonly kind: "straight"; readonly lengthLdu: number }
  | { readonly kind: "arc"; readonly radiusLdu: number; readonly sweepRadians: number };

export type PathFamily =
  | "straight"
  | "arc"
  | "arc-then-straight"
  | "straight-then-arc"
  | "reversed-arcs";

export interface RoutePose {
  readonly x: number;
  readonly z: number;
  readonly heading: number;
}

interface Candidate {
  readonly family: PathFamily;
  readonly segments: ReadonlyArray<PathSegment>;
}

export interface FittedPath {
  readonly family: PathFamily;
  readonly segments: ReadonlyArray<PathSegment>;
  readonly lengthLdu: number;
  readonly railCoverage: readonly [number, number];
  readonly rejected: ReadonlyArray<{ readonly family: PathFamily; readonly railCoverage: number }>;
}

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function segmentLength(segment: PathSegment): number {
  return segment.kind === "straight"
    ? segment.lengthLdu
    : segment.radiusLdu * Math.abs(segment.sweepRadians);
}

function advance(pose: RoutePose, segment: PathSegment, distance: number): RoutePose {
  if (segment.kind === "straight") {
    return {
      x: pose.x + Math.cos(pose.heading) * distance,
      z: pose.z + Math.sin(pose.heading) * distance,
      heading: pose.heading,
    };
  }
  const curvature = Math.sign(segment.sweepRadians) / segment.radiusLdu;
  const heading = pose.heading + curvature * distance;
  return {
    x: pose.x + (Math.sin(heading) - Math.sin(pose.heading)) / curvature,
    z: pose.z + (Math.cos(pose.heading) - Math.cos(heading)) / curvature,
    heading,
  };
}

export function walkPath(start: RoutePose, segments: ReadonlyArray<PathSegment>): RoutePose {
  return segments.reduce((pose, segment) => advance(pose, segment, segmentLength(segment)), start);
}

export function samplePath(
  start: RoutePose,
  segments: ReadonlyArray<PathSegment>,
  step: number,
): ReadonlyArray<RoutePose> {
  const samples: RoutePose[] = [];
  let pose = start;
  for (const segment of segments) {
    const length = segmentLength(segment);
    const count = Math.max(1, Math.ceil(length / step));
    for (let index = 0; index < count; index += 1) {
      samples.push(advance(pose, segment, (index * length) / count));
    }
    pose = advance(pose, segment, length);
  }
  samples.push(pose);
  return samples;
}

function arc(radius: number, sweep: number): PathSegment {
  return { kind: "arc", radiusLdu: Math.abs(radius), sweepRadians: sweep };
}

function candidates(x: number, z: number, turn: number): ReadonlyArray<Candidate> {
  const found: Candidate[] = [];
  const sin = Math.sin(turn);
  const cos = Math.cos(turn);
  if (Math.abs(turn) < ANGLE_EPSILON) {
    if (x > 0) found.push({ family: "straight", segments: [{ kind: "straight", lengthLdu: x }] });
    return found;
  }
  const signedRadius = x / sin;
  if (signedRadius * turn > 0) {
    found.push({ family: "arc", segments: [arc(signedRadius, turn)] });
  }
  const determinant = sin * sin - cos * (1 - cos);
  if (Math.abs(determinant) > ANGLE_EPSILON) {
    const radius = (x * sin - z * cos) / determinant;
    const straight = (z * sin - x * (1 - cos)) / determinant;
    if (radius * turn > 0 && straight > 0) {
      found.push({
        family: "arc-then-straight",
        segments: [arc(radius, turn), { kind: "straight", lengthLdu: straight }],
      });
    }
  }
  const radiusAfter = z / (1 - cos);
  const straightBefore = x - radiusAfter * sin;
  if (radiusAfter * turn > 0 && straightBefore > 0) {
    found.push({
      family: "straight-then-arc",
      segments: [{ kind: "straight", lengthLdu: straightBefore }, arc(radiusAfter, turn)],
    });
  }
  const tail = 1 + cos;
  const a = x * x + z * z;
  const b = 2 * (x * sin - z * tail);
  const c = sin * sin + tail * tail - 4;
  const discriminant = b * b - 4 * a * c;
  if (discriminant >= 0) {
    for (const root of [
      (-b + Math.sqrt(discriminant)) / (2 * a),
      (-b - Math.sqrt(discriminant)) / (2 * a),
    ]) {
      if (Math.abs(root) < ANGLE_EPSILON) continue;
      const first = Math.atan2((x * root + sin) / 2, (tail - z * root) / 2);
      const second = wrapAngle(turn - first);
      const radius = 1 / root;
      if (first * radius > 0 && second * radius < 0) {
        found.push({
          family: "reversed-arcs",
          segments: [arc(radius, first), arc(radius, second)],
        });
      }
    }
  }
  return found;
}

function railCoverage(
  heads: RailHeads,
  toPart: (point: PlanPoint) => PlanPoint,
  start: RoutePose,
  segments: ReadonlyArray<PathSegment>,
  halfSpacing: number,
): readonly [number, number] {
  const samples = samplePath(start, segments, SAMPLE_STEP_LDU);
  const covered = [0, 0];
  for (const sample of samples) {
    [-1, 1].forEach((side, index) => {
      const point = toPart({
        x: sample.x - Math.sin(sample.heading) * side * halfSpacing,
        z: sample.z + Math.cos(sample.heading) * side * halfSpacing,
      });
      if (onRailHead(heads, point)) covered[index] = (covered[index] ?? 0) + 1;
    });
  }
  return [(covered[0] ?? 0) / samples.length, (covered[1] ?? 0) / samples.length];
}

export function fitRoutePath(
  heads: RailHeads,
  toPart: (point: PlanPoint) => PlanPoint,
  start: RoutePose,
  end: RoutePose,
  halfSpacing: number,
  label: string,
): FittedPath {
  const dx = end.x - start.x;
  const dz = end.z - start.z;
  const x = dx * Math.cos(start.heading) + dz * Math.sin(start.heading);
  const z = -dx * Math.sin(start.heading) + dz * Math.cos(start.heading);
  const turn = wrapAngle(end.heading - start.heading);
  const local: RoutePose = { x: 0, z: 0, heading: 0 };
  const toPartFromLocal = (point: PlanPoint): PlanPoint =>
    toPart({
      x: start.x + point.x * Math.cos(start.heading) - point.z * Math.sin(start.heading),
      z: start.z + point.x * Math.sin(start.heading) + point.z * Math.cos(start.heading),
    });
  const scored = candidates(x, z, turn)
    .filter((candidate) =>
      candidate.segments.every((segment) => segmentLength(segment) > DEGENERATE_SEGMENT_LDU),
    )
    .filter((candidate) => {
      const reached = walkPath(local, candidate.segments);
      return (
        Math.hypot(reached.x - x, reached.z - z) <= ENDPOINT_TOLERANCE_LDU &&
        Math.abs(wrapAngle(reached.heading - turn)) <= ANGLE_EPSILON
      );
    })
    .map((candidate) => ({
      candidate,
      coverage: railCoverage(heads, toPartFromLocal, local, candidate.segments, halfSpacing),
    }))
    .toSorted((p, q) => Math.min(...q.coverage) - Math.min(...p.coverage));
  const [best, ...rest] = scored;
  if (best === undefined || Math.min(...best.coverage) < MINIMUM_RAIL_COVERAGE) {
    throw new Error(
      `${label}: no path family keeps both rails on rail heads (${scored
        .map((s) => `${s.candidate.family} ${Math.min(...s.coverage).toFixed(3)}`)
        .join(", ")})`,
    );
  }
  return {
    family: best.candidate.family,
    segments: best.candidate.segments,
    lengthLdu: best.candidate.segments.reduce((sum, segment) => sum + segmentLength(segment), 0),
    railCoverage: best.coverage,
    rejected: rest.map((s) => ({
      family: s.candidate.family,
      railCoverage: Math.min(...s.coverage),
    })),
  };
}

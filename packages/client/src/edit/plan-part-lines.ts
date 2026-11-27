import type { PartShapeAsset } from "@brr/catalog";
import { placeSegments, pointOnSegment, type PlacedSegment } from "@brr/domain";
import { STUD_LDU, ZETA16_ORDER, zeta16ToStuds } from "@brr/math";
import type { PlanPartLines } from "@brr/render";
import { OUTLINE_UNITS_PER_LDU, type PlanOutline, type TrackPiece } from "@brr/schema/bundle";

const HEADING_STEP_RADIANS = (2 * Math.PI) / ZETA16_ORDER;
const HALF_STEP_RADIANS = HEADING_STEP_RADIANS / 2;
const CENTRELINE_STEP_LDU = 10;

function outlineSegments(outline: PlanOutline): Float32Array {
  const segments: number[] = [];
  for (const ring of outline) {
    for (let k = 0; k < ring.length; k++) {
      const [ax = 0, az = 0] = ring[k] ?? [];
      const [bx = 0, bz = 0] = ring[(k + 1) % ring.length] ?? [];
      segments.push(
        ax / OUTLINE_UNITS_PER_LDU,
        az / OUTLINE_UNITS_PER_LDU,
        bx / OUTLINE_UNITS_PER_LDU,
        bz / OUTLINE_UNITS_PER_LDU,
      );
    }
  }
  return Float32Array.from(segments);
}

function centreSegments(pieces: ReadonlyArray<TrackPiece>): Float32Array {
  const segments: number[] = [];
  for (const piece of pieces) {
    const { xLdu, zLdu, headingHalfSteps } = piece.partFrame;
    const cos = Math.cos(headingHalfSteps * HALF_STEP_RADIANS);
    const sin = Math.sin(headingHalfSteps * HALF_STEP_RADIANS);
    const pushInPartFrame = (segment: PlacedSegment, along: number): void => {
      const point = pointOnSegment(segment, along);
      const dx = point.x - xLdu;
      const dz = point.z - zLdu;
      segments.push(cos * dx + sin * dz, -sin * dx + cos * dz);
    };
    for (const route of piece.routes) {
      const start = piece.connectors[route.from]?.pose;
      if (!start) continue;
      const at = zeta16ToStuds(start.position);
      const placed = placeSegments(
        {
          x: at.x * STUD_LDU,
          z: at.z * STUD_LDU,
          heading: (start.heading + ZETA16_ORDER / 2) * HEADING_STEP_RADIANS,
        },
        route.segments,
      );
      for (const segment of placed) {
        const steps = segment.curvature === 0 ? 1 : Math.ceil(segment.length / CENTRELINE_STEP_LDU);
        for (let k = 0; k < steps; k++) {
          pushInPartFrame(segment, (segment.length * k) / steps);
          pushInPartFrame(segment, (segment.length * (k + 1)) / steps);
        }
      }
    }
  }
  return Float32Array.from(segments);
}

export function planPartLines(
  part: PartShapeAsset,
  pieces: ReadonlyArray<TrackPiece>,
): PlanPartLines | null {
  if (!part.outline) return null;
  return {
    topY: part.boundsMax[1],
    outline: outlineSegments(part.outline),
    centre: centreSegments(pieces.filter((piece) => piece.part === part.id)),
  };
}

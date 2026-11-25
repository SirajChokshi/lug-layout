import type { PlanOutline, PlanPoint } from "@brr/schema/bundle";

const MIN_RING_POINTS = 3;

function samePoint(a: PlanPoint, b: PlanPoint): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

function isSpikeTip(previous: PlanPoint, tip: PlanPoint, next: PlanPoint): boolean {
  const inX = BigInt(tip[0]) - BigInt(previous[0]);
  const inZ = BigInt(tip[1]) - BigInt(previous[1]);
  const outX = BigInt(next[0]) - BigInt(tip[0]);
  const outZ = BigInt(next[1]) - BigInt(tip[1]);
  return inX * outZ === inZ * outX && inX * outX + inZ * outZ < 0n;
}

function withoutDegeneratePoints(ring: ReadonlyArray<PlanPoint>): PlanPoint[] {
  let points = [...ring];
  let index = 0;
  while (points.length >= MIN_RING_POINTS && index < points.length) {
    const previous = points[(index + points.length - 1) % points.length];
    const point = points[index];
    const next = points[(index + 1) % points.length];
    if (
      previous &&
      point &&
      next &&
      (samePoint(previous, point) || isSpikeTip(previous, point, next))
    ) {
      points = points.toSpliced(index, 1);
      index = 0;
    } else {
      index++;
    }
  }
  return points;
}

export function withoutDegeneratePieces(
  outline: ReadonlyArray<ReadonlyArray<PlanPoint>>,
): PlanOutline {
  return outline.map(withoutDegeneratePoints).filter((ring) => ring.length >= MIN_RING_POINTS);
}

import type { LduRect, OutlineRing, RecordChanges, WorldDiff } from "@brr/domain";
import type { GuideKind, GuideSegment } from "@brr/render";
import type { PlacementRecordV1, TrackRecordV1 } from "@brr/schema/world";
import { rectRings, ringsBounds } from "../sheets/plan-drawing.ts";

export interface DiffShapes {
  placementBox(record: PlacementRecordV1): LduRect;
  trackRings(record: TrackRecordV1): ReadonlyArray<OutlineRing>;
}

function outlineGuides(
  rings: ReadonlyArray<OutlineRing>,
  kind: GuideKind,
  y: number,
  out: GuideSegment[],
): void {
  for (const ring of rings) {
    ring.forEach(([ax, az], i) => {
      const [bx, bz] = ring[(i + 1) % ring.length] ?? [ax, az];
      out.push({ kind, ax, ay: y, az, bx, by: y, bz });
    });
  }
}

function centreOf(rings: ReadonlyArray<OutlineRing>): readonly [number, number] {
  const bounds = ringsBounds(rings);
  return [(bounds.minX + bounds.maxX) / 2, (bounds.minZ + bounds.maxZ) / 2];
}

function changeGuides<T>(
  changes: RecordChanges<T>,
  ringsOf: (record: T) => ReadonlyArray<OutlineRing>,
  y: number,
  out: GuideSegment[],
): void {
  for (const record of changes.added) outlineGuides(ringsOf(record), "added", y, out);
  for (const record of changes.removed) outlineGuides(ringsOf(record), "removed", y, out);
  for (const { from, to } of changes.moved) {
    const rings = ringsOf(to);
    outlineGuides(rings, "moved", y, out);
    const [ax, az] = centreOf(ringsOf(from));
    const [bx, bz] = centreOf(rings);
    out.push({ kind: "moved", ax, ay: y, az, bx, by: y, bz });
  }
}

export function diffGuides(diff: WorldDiff, shapes: DiffShapes, y: number): GuideSegment[] {
  const out: GuideSegment[] = [];
  changeGuides(diff.placements, (record) => rectRings(shapes.placementBox(record)), y, out);
  changeGuides(diff.track, (record) => shapes.trackRings(record), y, out);
  return out;
}

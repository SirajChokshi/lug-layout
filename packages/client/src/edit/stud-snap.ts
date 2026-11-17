import { isSupported, type BaseCells } from "@brr/domain";
import { PLATE_LDU, STUD_LDU } from "@brr/math";
import type { EdgeMarker } from "@brr/render";
import type { LandingAt, PlacedOverlap, PlacementCheck } from "./placed-chunks.ts";

export const STUD_SNAP_RADIUS_STUDS = 3;
const PAD_INSET_LDU = 1;
const PAD_LIFT_LDU = 0;
const PAD_HEIGHT_LDU = 5;

function offsetsByDistance(radius: number): Int8Array {
  const pairs: Array<readonly [number, number]> = [];
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if ((dx !== 0 || dz !== 0) && dx * dx + dz * dz <= radius * radius) pairs.push([dx, dz]);
    }
  }
  const nearestFirst = pairs.toSorted(
    ([ax, az], [bx, bz]) =>
      ax * ax + az * az - (bx * bx + bz * bz) || Math.abs(az) - Math.abs(bz) || az - bz || ax - bx,
  );
  return Int8Array.from(nearestFirst.flat());
}

const OFFSETS = offsetsByDistance(STUD_SNAP_RADIUS_STUDS);

export type CheckAt = (x: number, z: number, at: LandingAt) => PlacementCheck;
export type FirstPlaceableShift = (yPlates: number, shifts: Int8Array) => number;

export interface StudSnap {
  readonly x: number;
  readonly z: number;
  readonly at: LandingAt;
  readonly offsetStuds: readonly [number, number] | null;
}

export function acceptable(check: PlacementCheck): boolean {
  return check.overlap === null && (check.support === null || isSupported(check.support));
}

export function snapToStuds(
  x: number,
  z: number,
  cursor: LandingAt,
  checkAt: CheckAt,
  firstShift: FirstPlaceableShift,
): StudSnap {
  const first = checkAt(x, z, cursor);
  const unchanged: StudSnap = { x, z, at: cursor, offsetStuds: null };
  if (acceptable(first) || first.support === null || first.support.kind === "no-base") {
    return unchanged;
  }
  const shift = firstShift(first.yPlates, OFFSETS);
  if (shift < 0) return unchanged;
  const dx = OFFSETS[2 * shift] ?? 0;
  const dz = OFFSETS[2 * shift + 1] ?? 0;
  return {
    x: x + dx * STUD_LDU,
    z: z + dz * STUD_LDU,
    at: { kind: "height", yPlates: first.yPlates },
    offsetStuds: [dx, dz],
  };
}

function padRow(
  markers: EdgeMarker[],
  kind: EdgeMarker["kind"],
  cellZ: number,
  fromX: number,
  toX: number,
  yLdu: number,
): void {
  markers.push({
    kind,
    box: {
      minX: fromX * STUD_LDU + PAD_INSET_LDU,
      maxX: (toX + 1) * STUD_LDU - PAD_INSET_LDU,
      minY: yLdu + PAD_LIFT_LDU,
      maxY: yLdu + PAD_LIFT_LDU + PAD_HEIGHT_LDU,
      minZ: cellZ * STUD_LDU + PAD_INSET_LDU,
      maxZ: (cellZ + 1) * STUD_LDU - PAD_INSET_LDU,
    },
  });
}

export function connectionMarkers(
  engaged: BaseCells,
  yPlates: number,
  overlap: PlacedOverlap | null,
): EdgeMarker[] {
  const order = Array.from({ length: engaged.count }, (_, c) => c).toSorted(
    (a, b) =>
      (engaged.cellZ[a] ?? 0) - (engaged.cellZ[b] ?? 0) ||
      (engaged.cellX[a] ?? 0) - (engaged.cellX[b] ?? 0),
  );
  const markers: EdgeMarker[] = [];
  const yLdu = yPlates * PLATE_LDU;
  let open = false;
  let runZ = 0;
  let runFrom = 0;
  let runTo = 0;
  for (const c of order) {
    const x = engaged.cellX[c] ?? 0;
    const z = engaged.cellZ[c] ?? 0;
    if (open && z === runZ && x === runTo + 1) {
      runTo = x;
      continue;
    }
    if (open) padRow(markers, "stud", runZ, runFrom, runTo, yLdu);
    open = true;
    runZ = z;
    runFrom = x;
    runTo = x;
  }
  if (open) padRow(markers, "stud", runZ, runFrom, runTo, yLdu);
  if (overlap) {
    const { cellX, cellZ, bottomLdu, topLdu, candidateBottomLdu, candidateTopLdu } =
      overlap.overlap;
    markers.push({
      kind: "mismatch",
      box: {
        minX: cellX * STUD_LDU,
        maxX: (cellX + 1) * STUD_LDU,
        minY: Math.max(bottomLdu, candidateBottomLdu),
        maxY: Math.min(topLdu, candidateTopLdu),
        minZ: cellZ * STUD_LDU,
        maxZ: (cellZ + 1) * STUD_LDU,
      },
    });
  }
  return markers;
}

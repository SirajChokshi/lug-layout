import { STUD_LDU } from "@brr/math";
import type { BaseCells, SupportGrid } from "./support.ts";
import type { OwnerFilter, VolumeHit, VolumeIndex } from "./volume-index.ts";

export interface SurfaceHit {
  cellX: number;
  cellZ: number;
  topLdu: number;
  x: number;
  z: number;
}

export const MAX_PICK_CELLS = 4096;

const topHit: VolumeHit = { owner: 0, bottomLdu: 0, topLdu: 0 };

function boundaryTime(origin: number, direction: number, cell: number): number {
  if (direction > 0) return ((cell + 1) * STUD_LDU - origin) / direction;
  if (direction < 0) return (cell * STUD_LDU - origin) / direction;
  return Number.POSITIVE_INFINITY;
}

function hitAt(
  out: SurfaceHit,
  ray: Float64Array,
  t: number,
  cellX: number,
  cellZ: number,
  topLdu: number,
): true {
  out.cellX = cellX;
  out.cellZ = cellZ;
  out.topLdu = topLdu;
  out.x = (ray[0] ?? 0) + (ray[3] ?? 0) * t;
  out.z = (ray[2] ?? 0) + (ray[5] ?? 0) * t;
  return true;
}

export function pickSurface(
  ray: Float64Array,
  volumes: VolumeIndex,
  ignore: OwnerFilter,
  floorLdu: number,
  ceilingLdu: number,
  out: SurfaceHit,
): boolean {
  const ox = ray[0] ?? 0;
  const oy = ray[1] ?? 0;
  const oz = ray[2] ?? 0;
  const dx = ray[3] ?? 0;
  const dy = ray[4] ?? 0;
  const dz = ray[5] ?? 0;
  if (dy >= 0) return false;
  const tFloor = (floorLdu - oy) / dy;
  if (tFloor < 0) return false;
  let t = Math.min(tFloor, Math.max(0, (ceilingLdu - oy) / dy));
  let cellX = Math.floor((ox + dx * t) / STUD_LDU);
  let cellZ = Math.floor((oz + dz * t) / STUD_LDU);
  const stepX = Math.sign(dx);
  const stepZ = Math.sign(dz);
  const deltaX = dx === 0 ? Number.POSITIVE_INFINITY : STUD_LDU / Math.abs(dx);
  const deltaZ = dz === 0 ? Number.POSITIVE_INFINITY : STUD_LDU / Math.abs(dz);
  let nextX = boundaryTime(ox, dx, cellX);
  let nextZ = boundaryTime(oz, dz, cellZ);
  for (let visited = 0; visited < MAX_PICK_CELLS; visited++) {
    const exit = Math.min(nextX, nextZ, tFloor);
    const top = volumes.topOwnerAt(cellX, cellZ, ignore, topHit)
      ? Math.max(topHit.topLdu, floorLdu)
      : floorLdu;
    if (exit >= tFloor || oy + dy * exit <= top) {
      return hitAt(out, ray, Math.max(t, (top - oy) / dy), cellX, cellZ, top);
    }
    t = exit;
    if (nextX < nextZ) {
      cellX += stepX;
      nextX += deltaX;
    } else {
      cellZ += stepZ;
      nextZ += deltaZ;
    }
  }
  return hitAt(
    out,
    ray,
    tFloor,
    Math.floor((ox + dx * tFloor) / STUD_LDU),
    Math.floor((oz + dz * tFloor) / STUD_LDU),
    floorLdu,
  );
}

export function engagedStuds(
  base: BaseCells,
  yPlates: number,
  volumes: VolumeIndex,
  support: SupportGrid,
  ignore: OwnerFilter,
): BaseCells {
  let count = 0;
  for (let c = 0; c < base.count; c++) {
    const x = base.cellX[c] ?? 0;
    const z = base.cellZ[c] ?? 0;
    if (support.studTopAt(x, z) === yPlates && volumes.topOwnerAt(x, z, ignore, topHit)) count++;
  }
  const out = {
    count,
    cellX: new Int32Array(count),
    cellZ: new Int32Array(count),
    flat: new Uint8Array(count),
  };
  let e = 0;
  for (let c = 0; c < base.count; c++) {
    const x = base.cellX[c] ?? 0;
    const z = base.cellZ[c] ?? 0;
    if (support.studTopAt(x, z) !== yPlates || !volumes.topOwnerAt(x, z, ignore, topHit)) continue;
    out.cellX[e] = x;
    out.cellZ[e] = z;
    out.flat[e] = base.flat[c] ?? 0;
    e++;
  }
  return out;
}

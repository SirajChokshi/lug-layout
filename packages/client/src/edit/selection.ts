import { isRot90, rot90Cos, rot90Sin } from "@brr/math";
import { RAY_FLOATS, type WorldBox } from "@brr/render";

export type RectMode = "window" | "crossing";

const CORNERS = 4;
const PLANE_FLOATS = 4;
const QUARTER_TURNS = 4;

export interface LatticePoint {
  readonly x: number;
  readonly z: number;
}

export interface QuarterTurnPose {
  readonly x: number;
  readonly z: number;
  readonly rot: number;
}

export function rectMode(startNdcX: number, endNdcX: number): RectMode {
  return endNdcX >= startNdcX ? "window" : "crossing";
}

export class ScreenRect {
  private readonly planes = new Float64Array(CORNERS * PLANE_FLOATS);

  constructor(cornerRays: ReadonlyArray<Float64Array>, centreRay: Float64Array) {
    if (cornerRays.length !== CORNERS) throw new Error("a screen rectangle needs four corner rays");
    for (let i = 0; i < CORNERS; i++) {
      const a = cornerRays[i];
      const b = cornerRays[(i + 1) % CORNERS];
      if (!a || !b || a.length < RAY_FLOATS || b.length < RAY_FLOATS) {
        throw new Error("corner rays need an origin and a direction");
      }
      this.setPlane(i, a, b, centreRay);
    }
  }

  private setPlane(i: number, a: Float64Array, b: Float64Array, inside: Float64Array): void {
    const ax = a[3] ?? 0;
    const ay = a[4] ?? 0;
    const az = a[5] ?? 0;
    const bx = (b[0] ?? 0) + (b[3] ?? 0) - (a[0] ?? 0);
    const by = (b[1] ?? 0) + (b[4] ?? 0) - (a[1] ?? 0);
    const bz = (b[2] ?? 0) + (b[5] ?? 0) - (a[2] ?? 0);
    let nx = ay * bz - az * by;
    let ny = az * bx - ax * bz;
    let nz = ax * by - ay * bx;
    let d = -(nx * (a[0] ?? 0) + ny * (a[1] ?? 0) + nz * (a[2] ?? 0));
    const probe =
      nx * ((inside[0] ?? 0) + (inside[3] ?? 0)) +
      ny * ((inside[1] ?? 0) + (inside[4] ?? 0)) +
      nz * ((inside[2] ?? 0) + (inside[5] ?? 0)) +
      d;
    if (probe < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
      d = -d;
    }
    const o = i * PLANE_FLOATS;
    this.planes[o] = nx;
    this.planes[o + 1] = ny;
    this.planes[o + 2] = nz;
    this.planes[o + 3] = d;
  }

  private cornersInside(plane: number, box: WorldBox): number {
    const o = plane * PLANE_FLOATS;
    const nx = this.planes[o] ?? 0;
    const ny = this.planes[o + 1] ?? 0;
    const nz = this.planes[o + 2] ?? 0;
    const d = this.planes[o + 3] ?? 0;
    let inside = 0;
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? box.maxX : box.minX;
      const y = corner & 2 ? box.maxY : box.minY;
      const z = corner & 4 ? box.maxZ : box.minZ;
      if (nx * x + ny * y + nz * z + d >= 0) inside++;
    }
    return inside;
  }

  picks(box: WorldBox, mode: RectMode): boolean {
    for (let plane = 0; plane < CORNERS; plane++) {
      const inside = this.cornersInside(plane, box);
      if (mode === "window" ? inside < 8 : inside === 0) return false;
    }
    return true;
  }
}

export function unionBox(boxes: ReadonlyArray<WorldBox>): WorldBox | null {
  const first = boxes[0];
  if (!first) return null;
  let { minX, minY, minZ, maxX, maxY, maxZ } = first;
  for (const box of boxes) {
    minX = Math.min(minX, box.minX);
    minY = Math.min(minY, box.minY);
    minZ = Math.min(minZ, box.minZ);
    maxX = Math.max(maxX, box.maxX);
    maxY = Math.max(maxY, box.maxY);
    maxZ = Math.max(maxZ, box.maxZ);
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

export function rotationPivot(box: WorldBox, grid: number): LatticePoint {
  return {
    x: Math.round((box.minX + box.maxX) / 2 / grid) * grid + 0,
    z: Math.round((box.minZ + box.maxZ) / 2 / grid) * grid + 0,
  };
}

export function quarterTurnAbout<T extends QuarterTurnPose>(pose: T, pivot: LatticePoint): T {
  const quarter = 1;
  const c = rot90Cos(quarter);
  const s = rot90Sin(quarter);
  const dx = pose.x - pivot.x;
  const dz = pose.z - pivot.z;
  const rot = (pose.rot + 1) % QUARTER_TURNS;
  if (!isRot90(rot)) throw new Error(`rotation ${rot} is not a quarter turn 0-3`);
  return {
    ...pose,
    x: pivot.x + c * dx + s * dz + 0,
    z: pivot.z - s * dx + c * dz + 0,
    rot,
  };
}

export function turnedBox(box: WorldBox, pivot: LatticePoint, turns: number): WorldBox {
  let corners = [
    { x: box.minX, z: box.minZ, rot: 0 },
    { x: box.maxX, z: box.maxZ, rot: 0 },
  ];
  for (let turn = 0; turn < turns; turn++) {
    corners = corners.map((corner) => quarterTurnAbout(corner, pivot));
  }
  const xs = corners.map((corner) => corner.x);
  const zs = corners.map((corner) => corner.z);
  return {
    minX: Math.min(...xs),
    minY: box.minY,
    minZ: Math.min(...zs),
    maxX: Math.max(...xs),
    maxY: box.maxY,
    maxZ: Math.max(...zs),
  };
}

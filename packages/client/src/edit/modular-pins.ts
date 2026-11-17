import { NO_PIN, TECHNIC_HOLE, TECHNIC_SHAFT, type TechnicSet } from "@brr/domain";
import type { SeatedGround } from "./ground.ts";

export const HOLE_X = 0;
export const HOLE_Y = 1;
export const HOLE_Z = 2;
export const HOLE_OUT_X = 3;
export const HOLE_OUT_Z = 4;
export const HOLE_PIN = 5;
export const EDGE_HOLE_FIELDS = 6;
export const PINNED = 1;
export const UNPINNED = 0;

const AXIS_X = 0;
const AXIS_Z = 2;

export interface EdgeHoles {
  readonly count: number;
  readonly holes: Int32Array;
}

export const NO_EDGE_HOLES: EdgeHoles = { count: 0, holes: new Int32Array(0) };

interface Mouth {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly outX: number;
  readonly outZ: number;
}

function onEdge(ground: SeatedGround, mouth: Mouth): boolean {
  const alongZ = ground.minZ < mouth.z && mouth.z < ground.maxZ;
  const alongX = ground.minX < mouth.x && mouth.x < ground.maxX;
  if (mouth.outX === 1) return mouth.x === ground.maxX && alongZ;
  if (mouth.outX === -1) return mouth.x === ground.minX && alongZ;
  if (mouth.outZ === 1) return mouth.z === ground.maxZ && alongX;
  if (mouth.outZ === -1) return mouth.z === ground.minZ && alongX;
  return false;
}

function mouthAt(axis: number, u: number, v: number, along: number, outward: number): Mouth {
  return axis === AXIS_X
    ? { x: along, y: u, z: v, outX: outward, outZ: 0 }
    : { x: u, y: v, z: along, outX: 0, outZ: outward };
}

function pinsOutOf(technic: TechnicSet, f: number, along: number, outward: number): boolean {
  const axis = technic.axis[f];
  const u = technic.atU[f];
  const v = technic.atV[f];
  for (let item = 0; item < technic.count; item++) {
    if (technic.kind[item] !== TECHNIC_SHAFT) continue;
    const end = technic.featureStart[item + 1] ?? 0;
    for (let c = technic.featureStart[item] ?? 0; c < end; c++) {
      if (technic.axis[c] !== axis || technic.atU[c] !== u || technic.atV[c] !== v) continue;
      const direction = technic.pinDirection[c] ?? NO_PIN;
      if (direction === outward && technic.pinOrigin[c] === along) return true;
    }
  }
  return false;
}

export function edgeHoles(technic: TechnicSet, ground: SeatedGround | null): EdgeHoles {
  if (!ground) return NO_EDGE_HOLES;
  const found: number[] = [];
  for (let item = 0; item < technic.count; item++) {
    if (technic.kind[item] !== TECHNIC_HOLE) continue;
    const end = technic.featureStart[item + 1] ?? 0;
    for (let f = technic.featureStart[item] ?? 0; f < end; f++) {
      const axis = technic.axis[f] ?? AXIS_X;
      if (axis !== AXIS_X && axis !== AXIS_Z) continue;
      const u = technic.atU[f] ?? 0;
      const v = technic.atV[f] ?? 0;
      const from = technic.from[f] ?? 0;
      const to = from + (technic.bins[f] ?? 0);
      for (const [along, outward] of [
        [from, -1],
        [to, 1],
      ] as const) {
        const mouth = mouthAt(axis, u, v, along, outward);
        if (!onEdge(ground, mouth)) continue;
        const pinned = pinsOutOf(technic, f, along, outward) ? PINNED : UNPINNED;
        found.push(mouth.x, mouth.y, mouth.z, mouth.outX, mouth.outZ, pinned);
      }
    }
  }
  return { count: found.length / EDGE_HOLE_FIELDS, holes: Int32Array.from(found) };
}

export class HolePose {
  x = 0;
  yLdu = 0;
  z = 0;
  cos = 1;
  sin = 0;

  set(x: number, yLdu: number, z: number, cos: number, sin: number): this {
    this.x = x;
    this.yLdu = yLdu;
    this.z = z;
    this.cos = cos;
    this.sin = sin;
    return this;
  }

  holeInto(edge: EdgeHoles, hole: number, out: Int32Array, to: number): void {
    const o = hole * EDGE_HOLE_FIELDS;
    const lx = edge.holes[o + HOLE_X] ?? 0;
    const lz = edge.holes[o + HOLE_Z] ?? 0;
    const nx = edge.holes[o + HOLE_OUT_X] ?? 0;
    const nz = edge.holes[o + HOLE_OUT_Z] ?? 0;
    out[to + HOLE_X] = this.x + this.cos * lx + this.sin * lz;
    out[to + HOLE_Y] = this.yLdu + (edge.holes[o + HOLE_Y] ?? 0);
    out[to + HOLE_Z] = this.z - this.sin * lx + this.cos * lz;
    out[to + HOLE_OUT_X] = this.cos * nx + this.sin * nz;
    out[to + HOLE_OUT_Z] = -this.sin * nx + this.cos * nz;
    out[to + HOLE_PIN] = edge.holes[o + HOLE_PIN] ?? UNPINNED;
  }

  worldHoles(edge: EdgeHoles): Int32Array {
    const out = new Int32Array(edge.count * EDGE_HOLE_FIELDS);
    for (let h = 0; h < edge.count; h++) this.holeInto(edge, h, out, h * EDGE_HOLE_FIELDS);
    return out;
  }
}

export function facesOpposite(a: Int32Array, ao: number, b: Int32Array, bo: number): boolean {
  return (
    a[ao + HOLE_OUT_X] === -(b[bo + HOLE_OUT_X] ?? 0) &&
    a[ao + HOLE_OUT_Z] === -(b[bo + HOLE_OUT_Z] ?? 0)
  );
}

export function holesMeet(a: Int32Array, ao: number, b: Int32Array, bo: number): boolean {
  return (
    a[ao + HOLE_X] === b[bo + HOLE_X] &&
    a[ao + HOLE_Y] === b[bo + HOLE_Y] &&
    a[ao + HOLE_Z] === b[bo + HOLE_Z] &&
    facesOpposite(a, ao, b, bo)
  );
}

export function bothPinned(a: Int32Array, ao: number, b: Int32Array, bo: number): boolean {
  return a[ao + HOLE_PIN] === PINNED && b[bo + HOLE_PIN] === PINNED;
}

export function onePinned(a: Int32Array, ao: number, b: Int32Array, bo: number): boolean {
  return (a[ao + HOLE_PIN] === PINNED) !== (b[bo + HOLE_PIN] === PINNED);
}

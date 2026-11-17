import { CHUNK_LDU, chunkKey, chunkOf, isRot90, rot90Cos, rot90Sin } from "@brr/math";

export const AXIS_POS_X = 0;
export const AXIS_NEG_X = 1;
export const AXIS_POS_Y = 2;
export const AXIS_NEG_Y = 3;
export const AXIS_POS_Z = 4;
export const AXIS_NEG_Z = 5;
const AXES = 6;
const Y_OFFSET_LDU = 1 << 20;
const Y_RANGE_LDU = 1 << 21;

export interface HoleEnds {
  readonly count: number;
  readonly x: Int32Array;
  readonly y: Int32Array;
  readonly z: Int32Array;
  readonly axis: Uint8Array;
}

export interface LatticePlacement {
  readonly x: number;
  readonly z: number;
  readonly yLdu: number;
  readonly rot: number;
}

export function oppositeAxis(axis: number): number {
  return axis ^ 1;
}

function axisOf(dx: number, dy: number, dz: number): number {
  if (dx !== 0) return dx > 0 ? AXIS_POS_X : AXIS_NEG_X;
  if (dy !== 0) return dy > 0 ? AXIS_POS_Y : AXIS_NEG_Y;
  return dz > 0 ? AXIS_POS_Z : AXIS_NEG_Z;
}

const AXIS_DX = Int8Array.of(1, -1, 0, 0, 0, 0);
const AXIS_DY = Int8Array.of(0, 0, 1, -1, 0, 0);
const AXIS_DZ = Int8Array.of(0, 0, 0, 0, 1, -1);

export function placedHoleEnds(local: HoleEnds, at: LatticePlacement): HoleEnds {
  if (!isRot90(at.rot)) throw new Error(`rotation ${at.rot} is not a quarter turn 0-3`);
  const cos = rot90Cos(at.rot);
  const sin = rot90Sin(at.rot);
  const out = {
    count: local.count,
    x: new Int32Array(local.count),
    y: new Int32Array(local.count),
    z: new Int32Array(local.count),
    axis: new Uint8Array(local.count),
  };
  for (let i = 0; i < local.count; i++) {
    const lx = local.x[i] ?? 0;
    const lz = local.z[i] ?? 0;
    out.x[i] = at.x + cos * lx + sin * lz;
    out.y[i] = at.yLdu + (local.y[i] ?? 0);
    out.z[i] = at.z - sin * lx + cos * lz;
    const a = local.axis[i] ?? 0;
    const ax = AXIS_DX[a] ?? 0;
    const az = AXIS_DZ[a] ?? 0;
    out.axis[i] = axisOf(cos * ax + sin * az, AXIS_DY[a] ?? 0, -sin * ax + cos * az);
  }
  return out;
}

function localKey(x: number, y: number, z: number, axis: number): number {
  const lx = x - chunkOf(x) * CHUNK_LDU;
  const lz = z - chunkOf(z) * CHUNK_LDU;
  return ((lx * CHUNK_LDU + lz) * Y_RANGE_LDU + (y + Y_OFFSET_LDU)) * AXES + axis;
}

const PIN_SLOTS = 1 << 16;

export interface PinRef {
  readonly owner: number;
  readonly pin: number;
}

export class TechnicJoins {
  private readonly byChunk = new Map<number, Map<number, number>>();
  private readonly owners = new Map<number, HoleEnds>();
  private readonly pinsByChunk = new Map<number, Map<number, number>>();

  addPins(owner: number, pins: HoleEnds, index: Int32Array): void {
    for (let i = 0; i < pins.count; i++) {
      const x = pins.x[i] ?? 0;
      const z = pins.z[i] ?? 0;
      const key = chunkKey(chunkOf(x), chunkOf(z));
      let chunk = this.pinsByChunk.get(key);
      if (!chunk) {
        chunk = new Map();
        this.pinsByChunk.set(key, chunk);
      }
      chunk.set(
        localKey(x, pins.y[i] ?? 0, z, pins.axis[i] ?? 0),
        owner * PIN_SLOTS + (index[i] ?? 0),
      );
    }
  }

  pinAt(x: number, y: number, z: number, axis: number): PinRef | null {
    const found = this.pinsByChunk
      .get(chunkKey(chunkOf(x), chunkOf(z)))
      ?.get(localKey(x, y, z, axis));
    return found === undefined
      ? null
      : { owner: Math.floor(found / PIN_SLOTS), pin: found % PIN_SLOTS };
  }

  holeOwnerAt(x: number, y: number, z: number, inward: number): number {
    return this.ownerFacing(x, y, z, oppositeAxis(inward));
  }

  add(owner: number, ends: HoleEnds): void {
    this.owners.set(owner, ends);
    for (let i = 0; i < ends.count; i++) {
      const x = ends.x[i] ?? 0;
      const z = ends.z[i] ?? 0;
      const key = chunkKey(chunkOf(x), chunkOf(z));
      let chunk = this.byChunk.get(key);
      if (!chunk) {
        chunk = new Map();
        this.byChunk.set(key, chunk);
      }
      chunk.set(localKey(x, ends.y[i] ?? 0, z, ends.axis[i] ?? 0), owner);
    }
  }

  ownerFacing(x: number, y: number, z: number, axis: number): number {
    const chunk = this.byChunk.get(chunkKey(chunkOf(x), chunkOf(z)));
    return chunk?.get(localKey(x, y, z, oppositeAxis(axis))) ?? -1;
  }

  joinsAt(ends: HoleEnds, dx: number, dz: number, out: Uint8Array | null): number {
    let joins = 0;
    for (let i = 0; i < ends.count; i++) {
      const joined =
        this.ownerFacing(
          (ends.x[i] ?? 0) + dx,
          ends.y[i] ?? 0,
          (ends.z[i] ?? 0) + dz,
          ends.axis[i] ?? 0,
        ) >= 0;
      if (out) out[i] = joined ? 1 : 0;
      if (joined) joins++;
    }
    return joins;
  }

  shiftsWithin(ends: HoleEnds, radiusLdu: number): Int32Array {
    const reach = Math.ceil(radiusLdu);
    const span = 2 * reach + 1;
    const keys = new Set<number>();
    for (const placed of this.owners.values()) {
      for (let p = 0; p < placed.count; p++) {
        for (let i = 0; i < ends.count; i++) {
          if ((placed.y[p] ?? 0) !== (ends.y[i] ?? 0)) continue;
          if ((placed.axis[p] ?? 0) !== oppositeAxis(ends.axis[i] ?? 0)) continue;
          const dx = (placed.x[p] ?? 0) - (ends.x[i] ?? 0);
          const dz = (placed.z[p] ?? 0) - (ends.z[i] ?? 0);
          const distance = dx * dx + dz * dz;
          if (distance > radiusLdu * radiusLdu) continue;
          keys.add((distance * span + dz + reach) * span + dx + reach);
        }
      }
    }
    const scored = new Float64Array(keys.size);
    const most = ends.count + 1;
    let k = 0;
    for (const key of keys) {
      const dx = (key % span) - reach;
      const dz = (Math.floor(key / span) % span) - reach;
      scored[k++] = (most - this.joinsAt(ends, dx, dz, null)) * span ** 4 + key;
    }
    scored.sort();
    const shifts = new Int32Array(scored.length * 2);
    for (let i = 0; i < scored.length; i++) {
      const key = (scored[i] ?? 0) % span ** 4;
      shifts[2 * i] = (key % span) - reach;
      shifts[2 * i + 1] = (Math.floor(key / span) % span) - reach;
    }
    return shifts;
  }
}

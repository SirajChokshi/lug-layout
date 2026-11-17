import { PIN_BOX_FLOATS, PIN_ORIGIN_FLOATS, type PartAsset } from "@brr/catalog";
import {
  AXIS_NEG_X,
  AXIS_NEG_Y,
  AXIS_NEG_Z,
  AXIS_POS_X,
  AXIS_POS_Y,
  AXIS_POS_Z,
  type CellVolumes,
  type HoleEnds,
} from "@brr/domain";
import { CERTIFIED_RESIDUAL_LIMIT_LDU, STUD_LDU } from "@brr/math";
import { INSTANCE_MATRIX_FLOATS } from "@brr/render";
import type { ChunkPartInstances } from "../scene/placements.ts";

export interface ModelPins {
  readonly count: number;
  readonly boxes: Float64Array;
  readonly certified: HoleEnds;
  readonly certifiedPin: Int32Array;
}

export interface PinPose {
  readonly x: number;
  readonly z: number;
  readonly cos: number;
  readonly sin: number;
  readonly yLdu: number;
}

export interface PinCells extends CellVolumes {
  readonly pin: Int32Array;
}

const NO_AXIS = -1;

function identified(value: number): number | null {
  const rounded = Math.round(value);
  return Math.abs(value - rounded) <= CERTIFIED_RESIDUAL_LIMIT_LDU ? rounded + 0 : null;
}

function directionOf(dx: number, dy: number, dz: number): number {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const az = Math.abs(dz);
  const limit = CERTIFIED_RESIDUAL_LIMIT_LDU;
  if (ax > limit && ay <= limit && az <= limit) return dx > 0 ? AXIS_POS_X : AXIS_NEG_X;
  if (ay > limit && ax <= limit && az <= limit) return dy > 0 ? AXIS_POS_Y : AXIS_NEG_Y;
  if (az > limit && ax <= limit && ay <= limit) return dz > 0 ? AXIS_POS_Z : AXIS_NEG_Z;
  return NO_AXIS;
}

function apply(m: Float32Array, o: number, row: number, x: number, y: number, z: number): number {
  return (
    (m[o + row * 4] ?? 0) * x +
    (m[o + row * 4 + 1] ?? 0) * y +
    (m[o + row * 4 + 2] ?? 0) * z +
    (m[o + row * 4 + 3] ?? 0)
  );
}

export function modelPins(
  instances: ChunkPartInstances,
  parts: ReadonlyArray<PartAsset>,
): ModelPins {
  let total = 0;
  for (let i = 0; i < instances.count; i++) {
    total += (parts[instances.partIndex[i] ?? 0]?.pinOrigins.length ?? 0) / PIN_ORIGIN_FLOATS;
  }
  const boxes = new Float64Array(total * PIN_BOX_FLOATS);
  const x = new Int32Array(total);
  const y = new Int32Array(total);
  const z = new Int32Array(total);
  const axis = new Uint8Array(total);
  const certifiedPin = new Int32Array(total);
  const m = instances.matrices;
  let count = 0;
  let certified = 0;
  for (let i = 0; i < instances.count; i++) {
    const part = parts[instances.partIndex[i] ?? 0];
    if (!part) continue;
    const o = i * INSTANCE_MATRIX_FLOATS;
    for (let p = 0; p * PIN_ORIGIN_FLOATS < part.pinOrigins.length; p++) {
      const origin = part.pinOrigins.subarray(p * PIN_ORIGIN_FLOATS);
      const box = part.pinBoxes.subarray(p * PIN_BOX_FLOATS);
      const b = count * PIN_BOX_FLOATS;
      boxes.fill(Number.POSITIVE_INFINITY, b, b + 3);
      boxes.fill(Number.NEGATIVE_INFINITY, b + 3, b + 6);
      for (let corner = 0; corner < 8; corner++) {
        const cx = box[(corner & 1) === 0 ? 0 : 3] ?? 0;
        const cy = box[(corner & 2) === 0 ? 1 : 4] ?? 0;
        const cz = box[(corner & 4) === 0 ? 2 : 5] ?? 0;
        for (let row = 0; row < 3; row++) {
          const v = apply(m, o, row, cx, cy, cz);
          boxes[b + row] = Math.min(boxes[b + row] ?? v, v);
          boxes[b + 3 + row] = Math.max(boxes[b + 3 + row] ?? v, v);
        }
      }
      const ox = apply(m, o, 0, origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
      const oy = apply(m, o, 1, origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
      const oz = apply(m, o, 2, origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0);
      const direction = directionOf(
        ((boxes[b] ?? 0) + (boxes[b + 3] ?? 0)) / 2 - ox,
        ((boxes[b + 1] ?? 0) + (boxes[b + 4] ?? 0)) / 2 - oy,
        ((boxes[b + 2] ?? 0) + (boxes[b + 5] ?? 0)) / 2 - oz,
      );
      const px = identified(ox);
      const py = identified(oy);
      const pz = identified(oz);
      if (px !== null && py !== null && pz !== null && direction !== NO_AXIS) {
        x[certified] = px;
        y[certified] = py;
        z[certified] = pz;
        axis[certified] = direction;
        certifiedPin[certified] = count;
        certified++;
      }
      count++;
    }
  }
  return {
    count,
    boxes,
    certified: {
      count: certified,
      x: x.slice(0, certified),
      y: y.slice(0, certified),
      z: z.slice(0, certified),
      axis: axis.slice(0, certified),
    },
    certifiedPin: certifiedPin.slice(0, certified),
  };
}

function cellRange(lo: number, hi: number): readonly [number, number] {
  const first = Math.floor(lo / STUD_LDU);
  const last = Math.max(first, Math.ceil(hi / STUD_LDU) - 1);
  return [first, last];
}

export function pinCells(pins: ModelPins, at: PinPose): PinCells {
  const cellX: number[] = [];
  const cellZ: number[] = [];
  const bottomLdu: number[] = [];
  const topLdu: number[] = [];
  const pin: number[] = [];
  for (let p = 0; p < pins.count; p++) {
    const b = p * PIN_BOX_FLOATS;
    const ax = at.x + at.cos * (pins.boxes[b] ?? 0) + at.sin * (pins.boxes[b + 2] ?? 0);
    const az = at.z - at.sin * (pins.boxes[b] ?? 0) + at.cos * (pins.boxes[b + 2] ?? 0);
    const bx = at.x + at.cos * (pins.boxes[b + 3] ?? 0) + at.sin * (pins.boxes[b + 5] ?? 0);
    const bz = at.z - at.sin * (pins.boxes[b + 3] ?? 0) + at.cos * (pins.boxes[b + 5] ?? 0);
    const [x0, x1] = cellRange(Math.min(ax, bx), Math.max(ax, bx));
    const [z0, z1] = cellRange(Math.min(az, bz), Math.max(az, bz));
    const bottom = Math.floor(at.yLdu + (pins.boxes[b + 1] ?? 0));
    const top = Math.max(bottom + 1, Math.ceil(at.yLdu + (pins.boxes[b + 4] ?? 0)));
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        cellX.push(cx);
        cellZ.push(cz);
        bottomLdu.push(bottom);
        topLdu.push(top);
        pin.push(p);
      }
    }
  }
  return {
    count: pin.length,
    cellX: Int32Array.from(cellX),
    cellZ: Int32Array.from(cellZ),
    bottomLdu: Int32Array.from(bottomLdu),
    topLdu: Int32Array.from(topLdu),
    pin: Int32Array.from(pin),
  };
}

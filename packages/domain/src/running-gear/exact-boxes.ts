import { PLATE_LDU, exactRationalToFloat64 } from "@brr/math";
import { AXIS_POS_X, AXIS_POS_Y, AXIS_POS_Z } from "../connect/connector-table.ts";
import {
  NO_FRAME,
  TRANSFORM_FLOATS,
  type PartInstances,
  type SubmodelFrames,
} from "../connect/submodel-frames.ts";
import type { PartExtents } from "./part-extents.ts";
import { PlacedInstance, modelAxisIn, type Interval } from "./placed-instance.ts";
import { commonFrame } from "./support-plane.ts";

export const MODEL_UP = 1;
export const BOX_FLOATS = 6;
export const BOX_AXES = 3;
export const CANDIDATE_REACH_LDU = PLATE_LDU;
const ROW = 4;
const TRANSLATION = 3;
const CORNERS = 8;
const PLAN_AXES = [0, 2] as const;
const FRAME_AXES = [AXIS_POS_X, AXIS_POS_Y, AXIS_POS_Z] as const;

export type ExactBox = ReadonlyArray<Interval>;

export class ExactBoxes {
  private readonly placed: PlacedInstance;
  private readonly boxes = new Map<number, ExactBox | null>();
  private readonly ups = new Map<number, number>();

  constructor(
    private readonly frames: SubmodelFrames,
    private readonly instances: PartInstances,
    private readonly extents: ReadonlyArray<PartExtents | null>,
  ) {
    this.placed = new PlacedInstance(frames);
  }

  hasExtents(instance: number): boolean {
    return Boolean(this.extents[this.instances.partIndex[instance] ?? -1]);
  }

  sharedFrame(a: number, b: number): number {
    return commonFrame(this.frames, this.frames.frameOf(a), this.frames.frameOf(b));
  }

  up(instance: number, frame: number): number {
    const key = this.key(instance, frame);
    const known = this.ups.get(key);
    if (known !== undefined) return known;
    const up = modelAxisIn(this.frames, instance, frame, MODEL_UP);
    this.ups.set(key, up);
    return up;
  }

  box(instance: number, frame: number): ExactBox | null {
    const key = this.key(instance, frame);
    const known = this.boxes.get(key);
    if (known !== undefined) return known;
    const part = this.extents[this.instances.partIndex[instance] ?? -1];
    let box: ExactBox | null = null;
    if (part && this.placed.place(instance, frame)) {
      const intervals = FRAME_AXES.map((axis) => this.placed.exactlyAlong(axis, part));
      if (intervals.every((interval) => interval !== null)) box = intervals;
    }
    this.boxes.set(key, box);
    return box;
  }

  private key(instance: number, frame: number): number {
    return (frame - NO_FRAME) * this.instances.count + instance;
  }
}

export function modelBoxes(
  instances: PartInstances,
  extents: ReadonlyArray<PartExtents | null>,
): Float64Array {
  const boxes = new Float64Array(instances.count * BOX_FLOATS).fill(Number.NaN);
  const m = instances.matrices;
  for (let i = 0; i < instances.count; i++) {
    const part = extents[instances.partIndex[i] ?? -1];
    if (!part) continue;
    const low = part.min.map(exactRationalToFloat64);
    const high = part.max.map(exactRationalToFloat64);
    const o = i * BOX_FLOATS;
    const t = i * TRANSFORM_FLOATS;
    boxes.fill(Number.POSITIVE_INFINITY, o, o + BOX_AXES);
    boxes.fill(Number.NEGATIVE_INFINITY, o + BOX_AXES, o + BOX_FLOATS);
    for (let corner = 0; corner < CORNERS; corner++) {
      const local = [0, 1, 2].map((k) => ((corner >> k) & 1 ? high[k] : low[k]) ?? 0);
      for (let r = 0; r < BOX_AXES; r++) {
        const row = t + r * ROW;
        const value =
          (m[row] ?? 0) * (local[0] ?? 0) +
          (m[row + 1] ?? 0) * (local[1] ?? 0) +
          (m[row + 2] ?? 0) * (local[2] ?? 0) +
          (m[row + TRANSLATION] ?? 0);
        boxes[o + r] = Math.min(boxes[o + r] ?? value, value);
        boxes[o + BOX_AXES + r] = Math.max(boxes[o + BOX_AXES + r] ?? value, value);
      }
    }
  }
  return boxes;
}

export function planReach(boxes: Float64Array, a: number, b: number): boolean {
  for (const d of PLAN_AXES) {
    const low = Math.max(boxes[a * BOX_FLOATS + d] ?? 0, boxes[b * BOX_FLOATS + d] ?? 0);
    const high = Math.min(
      boxes[a * BOX_FLOATS + BOX_AXES + d] ?? 0,
      boxes[b * BOX_FLOATS + BOX_AXES + d] ?? 0,
    );
    if (!(low <= high + CANDIDATE_REACH_LDU)) return false;
  }
  return true;
}

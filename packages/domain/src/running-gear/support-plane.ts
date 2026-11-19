import {
  compareExactRational,
  exactRationalEquals,
  exactRationalFromSixteenths,
  subtractExactRational,
  type ExactRational,
} from "@brr/math";
import { AXIS_FREE, axisDimension, axisSign } from "../connect/connector-table.ts";
import {
  IdentifiedPoint,
  MODEL_ROOT,
  NO_FRAME,
  TRANSFORM_FLOATS,
  identifyDirection,
  identifyPoint,
  type SubmodelFrames,
} from "../connect/submodel-frames.ts";

const MODEL_UP_ROW = 4;

export interface SeatingWheelset {
  readonly axleInstance: number;
  readonly axlePoint: Float64Array;
  readonly frame: number;
  readonly axleHeight: number;
  readonly rollingRadius: ExactRational;
}

export interface SupportPlane {
  readonly seated: Uint8Array;
  readonly unidentified: readonly [number, number] | null;
}

export class AxleHeights {
  private readonly toFrame = new Float64Array(TRANSFORM_FLOATS);
  private readonly toModel = new Float64Array(TRANSFORM_FLOATS);
  private readonly point = new IdentifiedPoint();

  constructor(private readonly frames: SubmodelFrames) {}

  inFrame(instance: number, axlePoint: Float64Array, frame: number): number | null {
    if (!this.frames.relate(instance, frame, this.toFrame)) return null;
    this.frames.relate(instance, MODEL_ROOT, this.toModel);
    const up = identifyDirection(
      this.toFrame,
      this.toModel[MODEL_UP_ROW] ?? 0,
      this.toModel[MODEL_UP_ROW + 1] ?? 0,
      this.toModel[MODEL_UP_ROW + 2] ?? 0,
    );
    if (up === AXIS_FREE) return null;
    const dimension = axisDimension(up);
    const identified = identifyPoint(
      this.toFrame,
      axlePoint[0] ?? 0,
      axlePoint[1] ?? 0,
      axlePoint[2] ?? 0,
      1 << dimension,
      this.point,
    );
    return identified ? axisSign(up) * (this.point.sixteenths[dimension] ?? 0) : null;
  }
}

function commonFrame(frames: SubmodelFrames, a: number, b: number): number {
  for (let x = a; x !== NO_FRAME; x = frames.parentFrame(x)) {
    for (let y = b; y !== NO_FRAME; y = frames.parentFrame(y)) if (x === y) return x;
  }
  return MODEL_ROOT;
}

export function supportPlane(
  frames: SubmodelFrames,
  heights: AxleHeights,
  wheelsets: ReadonlyArray<SeatingWheelset>,
  vehicleWheelsets: ReadonlyArray<number>,
): SupportPlane {
  const seated = new Uint8Array(vehicleWheelsets.length);
  const heightsIn = new Map<number, number | null>();
  const heightIn = (w: number, frame: number): number | null => {
    const wheelset = wheelsets[w];
    if (!wheelset) return null;
    if (frame === wheelset.frame) return wheelset.axleHeight;
    const key = (frame - NO_FRAME) * wheelsets.length + w;
    const known = heightsIn.get(key);
    if (known !== undefined) return known;
    const height = heights.inFrame(wheelset.axleInstance, wheelset.axlePoint, frame);
    heightsIn.set(key, height);
    return height;
  };
  const compare = (a: number, b: number): number | null => {
    const first = wheelsets[a];
    const second = wheelsets[b];
    if (!first || !second) return null;
    const frame = commonFrame(frames, first.frame, second.frame);
    const firstHeight = heightIn(a, frame);
    const secondHeight = heightIn(b, frame);
    if (firstHeight === null || secondHeight === null) return null;
    if (exactRationalEquals(first.rollingRadius, second.rollingRadius)) {
      return Math.sign(firstHeight - secondHeight);
    }
    return compareExactRational(
      subtractExactRational(exactRationalFromSixteenths(firstHeight), first.rollingRadius),
      subtractExactRational(exactRationalFromSixteenths(secondHeight), second.rollingRadius),
    );
  };
  let lowest = vehicleWheelsets[0] ?? 0;
  for (const wheelset of vehicleWheelsets) {
    const order = compare(wheelset, lowest);
    if (order === null) return { seated, unidentified: [wheelset, lowest] };
    if (order < 0) lowest = wheelset;
  }
  for (let k = 0; k < vehicleWheelsets.length; k++) {
    const wheelset = vehicleWheelsets[k] ?? 0;
    const order = compare(wheelset, lowest);
    if (order === null) return { seated, unidentified: [wheelset, lowest] };
    seated[k] = order === 0 ? 1 : 0;
  }
  return { seated, unidentified: null };
}

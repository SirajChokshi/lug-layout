import {
  addExactRational,
  compareExactRational,
  exactRational,
  exactRationalFromFloat64,
  exactRationalFromSixteenths,
  multiplyExactRational,
  subtractExactRational,
  type ExactRational,
} from "@brr/math";
import { AXIS_FREE, axisDimension, axisSign } from "../connect/connector-table.ts";
import {
  ALL_COORDINATES,
  IdentifiedPoint,
  MODEL_ROOT,
  TRANSFORM_FLOATS,
  identifyDirection,
  identifyPoint,
  type SubmodelFrames,
} from "../connect/submodel-frames.ts";
import type { PartExtents } from "./part-extents.ts";

const ROW = 4;
const AXES = 3;
const ZERO = exactRational(0n, 1n);
const ONE = exactRational(1n, 1n);
const LOCAL_AXES: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export interface Interval {
  readonly low: ExactRational;
  readonly high: ExactRational;
}

function lesser(a: ExactRational, b: ExactRational): ExactRational {
  return compareExactRational(a, b) <= 0 ? a : b;
}

function greater(a: ExactRational, b: ExactRational): ExactRational {
  return compareExactRational(a, b) >= 0 ? a : b;
}

function negate(value: ExactRational): ExactRational {
  return subtractExactRational(ZERO, value);
}

function magnitude(value: ExactRational): ExactRational {
  return compareExactRational(value, ZERO) < 0 ? negate(value) : value;
}

export function overlapsWithLength(a: Interval, b: Interval): boolean {
  return compareExactRational(greater(a.low, b.low), lesser(a.high, b.high)) < 0;
}

export function signedInterval(sign: number, low: ExactRational, high: ExactRational): Interval {
  return sign > 0 ? { low, high } : { low: negate(high), high: negate(low) };
}

function largestCornerL1(extents: PartExtents): ExactRational {
  let sum = ZERO;
  for (let k = 0; k < AXES; k++) {
    const min = extents.min[k];
    const max = extents.max[k];
    if (!min || !max) continue;
    sum = addExactRational(sum, greater(magnitude(min), magnitude(max)));
  }
  return sum;
}

export class PlacedInstance {
  private readonly toFrame = new Float64Array(TRANSFORM_FLOATS);
  private readonly point = new IdentifiedPoint();
  private readonly localAxis = new Int8Array(AXES);

  constructor(private readonly frames: SubmodelFrames) {}

  place(instance: number, frame: number): boolean {
    if (!this.frames.relate(instance, frame, this.toFrame)) return false;
    if (!identifyPoint(this.toFrame, 0, 0, 0, ALL_COORDINATES, this.point)) return false;
    for (let k = 0; k < AXES; k++) {
      const [x, y, z] = LOCAL_AXES[k] ?? [0, 0, 0];
      this.localAxis[k] = identifyDirection(this.toFrame, x, y, z);
    }
    return true;
  }

  exactlyAlong(direction: number, extents: PartExtents): Interval | null {
    const dimension = axisDimension(direction);
    const local = Array.from(this.localAxis).findIndex(
      (code) => code !== AXIS_FREE && axisDimension(code) === dimension,
    );
    const aligned = Array.from(this.localAxis).every((code) => code !== AXIS_FREE);
    if (!aligned || local < 0) return null;
    const origin = exactRationalFromSixteenths(this.point.sixteenths[dimension] ?? 0);
    const span = signedInterval(
      axisSign(this.localAxis[local] ?? 0),
      extents.min[local] ?? ZERO,
      extents.max[local] ?? ZERO,
    );
    return signedInterval(
      axisSign(direction),
      addExactRational(origin, span.low),
      addExactRational(origin, span.high),
    );
  }

  along(direction: number, extents: PartExtents): Interval {
    const exact = this.exactlyAlong(direction, extents);
    if (exact) return exact;
    const dimension = axisDimension(direction);
    const origin = exactRationalFromSixteenths(this.point.sixteenths[dimension] ?? 0);
    const reach = multiplyExactRational(largestCornerL1(extents), this.largestRowEntry(dimension));
    return signedInterval(
      axisSign(direction),
      subtractExactRational(origin, reach),
      addExactRational(origin, reach),
    );
  }

  private largestRowEntry(dimension: number): ExactRational {
    const row = dimension * ROW;
    let largest = ONE;
    for (let k = 0; k < AXES; k++) {
      largest = greater(largest, magnitude(exactRationalFromFloat64(this.toFrame[row + k] ?? 0)));
    }
    return largest;
  }
}

export function modelAxisIn(
  frames: SubmodelFrames,
  instance: number,
  frame: number,
  modelDimension: number,
): number {
  const toFrame = new Float64Array(TRANSFORM_FLOATS);
  const toModel = new Float64Array(TRANSFORM_FLOATS);
  if (!frames.relate(instance, frame, toFrame)) return AXIS_FREE;
  frames.relate(instance, MODEL_ROOT, toModel);
  const row = modelDimension * ROW;
  return identifyDirection(
    toFrame,
    toModel[row] ?? 0,
    toModel[row + 1] ?? 0,
    toModel[row + 2] ?? 0,
  );
}

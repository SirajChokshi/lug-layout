import {
  addExactRational,
  compareExactRational,
  divideExactRational,
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
  type PartInstances,
  type SubmodelFrames,
} from "../connect/submodel-frames.ts";
import type { PartExtents } from "./part-extents.ts";
import { commonFrame, type AxleHeights } from "./support-plane.ts";
import type { DetectedWheelset, HeadBand } from "./wheelset-detector.ts";

const ROW = 4;
const AXES = 3;
const MODEL_UP = 1;
const SIXTEENTHS = exactRational(16n, 1n);
const ZERO = exactRational(0n, 1n);
const ONE = exactRational(1n, 1n);
const LOCAL_AXES: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0, 1],
];

export interface ClearanceWheelset {
  readonly wheelset: DetectedWheelset;
  readonly headBands: readonly [HeadBand, HeadBand];
}

export interface ClearanceFailure {
  readonly reason: "belowRailTop" | "clearanceUnidentified";
  readonly instances: ReadonlyArray<number>;
}

interface Interval {
  readonly low: ExactRational;
  readonly high: ExactRational;
}

const UNIDENTIFIED = null;

function toLdu(sixteenths: ExactRational): ExactRational {
  return divideExactRational(sixteenths, SIXTEENTHS);
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

function overlapsWithLength(a: Interval, b: Interval): boolean {
  return compareExactRational(greater(a.low, b.low), lesser(a.high, b.high)) < 0;
}

function signedInterval(sign: number, low: ExactRational, high: ExactRational): Interval {
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

class PlacedInstance {
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

  along(direction: number, extents: PartExtents): Interval {
    const dimension = axisDimension(direction);
    const origin = exactRationalFromSixteenths(this.point.sixteenths[dimension] ?? 0);
    const local = Array.from(this.localAxis).findIndex(
      (code) => code !== AXIS_FREE && axisDimension(code) === dimension,
    );
    const aligned = Array.from(this.localAxis).every((code) => code !== AXIS_FREE);
    if (aligned && local >= 0) {
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

interface WheelsetPlane {
  readonly up: number;
  readonly lateral: number;
  readonly railTop: ExactRational;
  readonly headBands: ReadonlyArray<Interval>;
}

function modelAxisIn(
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

function wheelsetPlane(
  frames: SubmodelFrames,
  heights: AxleHeights,
  seated: ClearanceWheelset,
  frame: number,
): WheelsetPlane | typeof UNIDENTIFIED {
  const { wheelset } = seated;
  const axle = wheelset.axleInstance;
  const up = modelAxisIn(frames, axle, frame, MODEL_UP);
  const lateral = modelAxisIn(frames, axle, frame, wheelset.modelDimension);
  const own = modelAxisIn(frames, axle, wheelset.frame, wheelset.modelDimension);
  const height = heights.inFrame(axle, wheelset.axlePoint, frame);
  const lateralHere = heights.along(axle, wheelset.axlePoint, frame, wheelset.modelDimension);
  const lateralOwn = heights.along(
    axle,
    wheelset.axlePoint,
    wheelset.frame,
    wheelset.modelDimension,
  );
  if (
    up === AXIS_FREE ||
    lateral === AXIS_FREE ||
    own === AXIS_FREE ||
    axisDimension(own) !== wheelset.dimension ||
    height === null ||
    lateralHere === null ||
    lateralOwn === null
  ) {
    return UNIDENTIFIED;
  }
  const shift = exactRational(BigInt(lateralHere - lateralOwn), 1n);
  const centre = exactRational(BigInt(wheelset.trackCentre), 1n);
  return {
    up,
    lateral,
    railTop: subtractExactRational(exactRationalFromSixteenths(height), wheelset.rollingRadius),
    headBands: seated.headBands.map(([from, to]) => {
      const band = signedInterval(
        axisSign(own),
        addExactRational(centre, from),
        addExactRational(centre, to),
      );
      return {
        low: toLdu(addExactRational(band.low, shift)),
        high: toLdu(addExactRational(band.high, shift)),
      };
    }),
  };
}

export function clearance(
  frames: SubmodelFrames,
  heights: AxleHeights,
  instances: PartInstances,
  extents: ReadonlyArray<PartExtents | null>,
  seated: ReadonlyArray<ClearanceWheelset>,
  checked: ReadonlyArray<number>,
): ClearanceFailure | null {
  const placed = new PlacedInstance(frames);
  const planes = new Map<string, WheelsetPlane | typeof UNIDENTIFIED>();
  const below: number[] = [];
  const unidentified: number[] = [];
  for (const instance of checked) {
    const part = extents[instances.partIndex[instance] ?? -1];
    if (!part) continue;
    let fails = false;
    let identified = true;
    let placedIn: number | null = null;
    let placedHere = false;
    const intervals = new Map<number, Interval>();
    const along = (direction: number): Interval => {
      const known = intervals.get(direction);
      if (known) return known;
      const interval = placed.along(direction, part);
      intervals.set(direction, interval);
      return interval;
    };
    for (let w = 0; w < seated.length && !fails; w++) {
      const wheelset = seated[w];
      if (!wheelset) continue;
      const frame = commonFrame(frames, frames.frameOf(instance), wheelset.wheelset.frame);
      const key = `${w} ${frame}`;
      if (!planes.has(key)) planes.set(key, wheelsetPlane(frames, heights, wheelset, frame));
      const plane = planes.get(key) ?? UNIDENTIFIED;
      if (placedIn !== frame) {
        placedIn = frame;
        placedHere = placed.place(instance, frame);
        intervals.clear();
      }
      if (!plane || !placedHere) {
        identified = false;
        continue;
      }
      const lateral = along(plane.lateral);
      fails =
        compareExactRational(along(plane.up).low, plane.railTop) < 0 &&
        plane.headBands.some((band) => overlapsWithLength(lateral, band));
    }
    if (fails) below.push(instance);
    else if (!identified) unidentified.push(instance);
  }
  if (below.length > 0) return { reason: "belowRailTop", instances: below };
  if (unidentified.length > 0) return { reason: "clearanceUnidentified", instances: unidentified };
  return null;
}

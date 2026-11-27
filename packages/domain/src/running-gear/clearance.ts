import {
  addExactRational,
  compareExactRational,
  divideExactRational,
  exactRational,
  exactRationalFromSixteenths,
  subtractExactRational,
  type ExactRational,
} from "@brr/math";
import { AXIS_FREE, axisDimension, axisSign } from "../connect/connector-table.ts";
import type { PartInstances, SubmodelFrames } from "../connect/submodel-frames.ts";
import type { PartExtents } from "./part-extents.ts";
import {
  PlacedInstance,
  modelAxisIn,
  overlapsWithLength,
  signedInterval,
  type Interval,
} from "./placed-instance.ts";
import { commonFrame, type AxleHeights } from "./support-plane.ts";
import type { DetectedWheelset, HeadBand } from "./wheelset-detector.ts";

const MODEL_UP = 1;
const SIXTEENTHS = exactRational(16n, 1n);

export interface ClearanceWheelset {
  readonly wheelset: DetectedWheelset;
  readonly headBands: readonly [HeadBand, HeadBand];
}

export interface ClearanceFailure {
  readonly reason: "belowRailTop" | "clearanceUnidentified";
  readonly instances: ReadonlyArray<number>;
}

const UNIDENTIFIED = null;

function toLdu(sixteenths: ExactRational): ExactRational {
  return divideExactRational(sixteenths, SIXTEENTHS);
}

interface WheelsetPlane {
  readonly up: number;
  readonly lateral: number;
  readonly railTop: ExactRational;
  readonly headBands: ReadonlyArray<Interval>;
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

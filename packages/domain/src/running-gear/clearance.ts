import {
  addExactRational,
  compareExactRational,
  divideExactRational,
  exactRational,
  exactRationalEquals,
  exactRationalFromFloat64,
  exactRationalFromSixteenths,
  multiplyExactRational,
  subtractExactRational,
  type ExactRational,
} from "@brr/math";
import { AXIS_FREE, axisDimension, axisSign } from "../connect/connector-table.ts";
import type { PartInstances, SubmodelFrames } from "../connect/submodel-frames.ts";
import type { AuthoredBoxes } from "./authored-boxes.ts";
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
const ROW = 4;
const TRANSLATION = 3;
const AXES = 3;
const ZERO = exactRational(0n, 1n);

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

interface AuthoredPlane {
  readonly lateral: number;
  readonly railTop: ExactRational;
  readonly headBands: ReadonlyArray<Interval>;
}

interface LocalAxis {
  readonly axis: number;
  readonly sign: number;
}

function latticeAxis(
  instances: PartInstances,
  instance: number,
  modelRow: number,
): LocalAxis | null {
  const row = instance * ROW * AXES + modelRow * ROW;
  const entries = [0, 1, 2].map((k) => instances.matrices[row + k] ?? 0);
  const axis = entries.findIndex((entry) => Math.abs(entry) === 1);
  if (axis < 0 || entries.some((entry, k) => k !== axis && entry !== 0)) return null;
  return { axis, sign: Math.sign(entries[axis] ?? 0) };
}

function carries(pose: ReadonlyArray<ExactRational>, local: LocalAxis, modelRow: number): boolean {
  return [0, 1, 2].every((row) =>
    exactRationalEquals(
      pose[row * ROW + local.axis] ?? ZERO,
      exactRational(BigInt(row === modelRow ? local.sign : 0), 1n),
    ),
  );
}

function authoredPlane(
  frames: SubmodelFrames,
  heights: AxleHeights,
  instances: PartInstances,
  authored: AuthoredBoxes,
  seated: ClearanceWheelset,
): AuthoredPlane | typeof UNIDENTIFIED {
  const { wheelset } = seated;
  const axle = wheelset.axleInstance;
  const pose = authored.pose(axle);
  const up = latticeAxis(instances, axle, MODEL_UP);
  const lateralAxis = latticeAxis(instances, axle, wheelset.modelDimension);
  const own = modelAxisIn(frames, axle, wheelset.frame, wheelset.modelDimension);
  const lateralOwn = heights.along(
    axle,
    wheelset.axlePoint,
    wheelset.frame,
    wheelset.modelDimension,
  );
  if (
    !pose ||
    !up ||
    !lateralAxis ||
    !carries(pose, up, MODEL_UP) ||
    !carries(pose, lateralAxis, wheelset.modelDimension) ||
    own === AXIS_FREE ||
    lateralOwn === null
  ) {
    return UNIDENTIFIED;
  }
  const point = [0, 1, 2].map((k) => exactRationalFromFloat64(wheelset.axlePoint[k] ?? 0));
  const at = (row: number): ExactRational =>
    point.reduce(
      (sum, value, k) =>
        addExactRational(sum, multiplyExactRational(pose[row * ROW + k] ?? ZERO, value)),
      pose[row * ROW + TRANSLATION] ?? ZERO,
    );
  const lateral = at(wheelset.modelDimension);
  const centre = exactRational(BigInt(wheelset.trackCentre), 1n);
  const offOwn = exactRational(BigInt(lateralOwn), 1n);
  return {
    lateral: wheelset.modelDimension,
    railTop: subtractExactRational(at(MODEL_UP), wheelset.rollingRadius),
    headBands: seated.headBands.map(([from, to]) => {
      const band = signedInterval(
        axisSign(own),
        addExactRational(centre, from),
        addExactRational(centre, to),
      );
      return {
        low: addExactRational(lateral, toLdu(subtractExactRational(band.low, offOwn))),
        high: addExactRational(lateral, toLdu(subtractExactRational(band.high, offOwn))),
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
  authored: AuthoredBoxes,
): ClearanceFailure | null {
  const placed = new PlacedInstance(frames);
  const planes = new Map<string, WheelsetPlane | typeof UNIDENTIFIED>();
  const rootPlanes = seated.map((wheelset) =>
    authoredPlane(frames, heights, instances, authored, wheelset),
  );
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
        const box = authored.box(instance);
        const root = rootPlanes[w] ?? UNIDENTIFIED;
        const lateral = box?.[root?.lateral ?? -1];
        const height = box?.[MODEL_UP];
        if (!root || !lateral || !height) {
          identified = false;
          continue;
        }
        fails =
          compareExactRational(height.low, root.railTop) < 0 &&
          root.headBands.some((band) => overlapsWithLength(lateral, band));
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

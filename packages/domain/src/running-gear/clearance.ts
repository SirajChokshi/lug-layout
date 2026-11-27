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
import {
  IdentifiedPoint,
  identifyPoint,
  MODEL_ROOT,
  TRANSFORM_FLOATS,
  type PartInstances,
  type SubmodelFrames,
} from "../connect/submodel-frames.ts";
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
const ZERO = exactRational(0n, 1n);
const ONE = exactRational(1n, 1n);
const MINUS_ONE = exactRational(-1n, 1n);

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
  readonly up: number;
  readonly upSign: number;
  readonly railTopHeight: ExactRational;
  readonly lateral: number;
  readonly headBands: ReadonlyArray<Interval>;
}

interface SignedAxis {
  readonly axis: number;
  readonly sign: number;
}

function signedUnitRow(transform: ArrayLike<number>, row: number): SignedAxis | null {
  const entries = [0, 1, 2].map((k) => transform[row * ROW + k] ?? 0);
  const axis = entries.findIndex((entry) => Math.abs(entry) === 1);
  if (axis < 0 || entries.some((entry, k) => k !== axis && entry !== 0)) return null;
  return { axis, sign: Math.sign(entries[axis] ?? 0) };
}

function carriedTo(pose: ReadonlyArray<ExactRational>, local: SignedAxis): SignedAxis | null {
  const column = [0, 1, 2].map((row) =>
    multiplyExactRational(
      pose[row * ROW + local.axis] ?? ZERO,
      exactRational(BigInt(local.sign), 1n),
    ),
  );
  const axis = column.findIndex((entry) => !exactRationalEquals(entry, ZERO));
  if (axis < 0) return null;
  const value = column[axis] ?? ZERO;
  const unit = exactRationalEquals(value, ONE) ? 1 : exactRationalEquals(value, MINUS_ONE) ? -1 : 0;
  if (
    unit === 0 ||
    column.some((entry, row) => row !== axis && !exactRationalEquals(entry, ZERO))
  ) {
    return null;
  }
  return { axis, sign: unit };
}

function authoredPlane(
  frames: SubmodelFrames,
  instances: PartInstances,
  authored: AuthoredBoxes,
  seated: ClearanceWheelset,
): AuthoredPlane | typeof UNIDENTIFIED {
  const { wheelset } = seated;
  const axle = wheelset.axleInstance;
  const pose = authored.pose(axle);
  const toFrame = new Float64Array(TRANSFORM_FLOATS);
  const toModel = new Float64Array(TRANSFORM_FLOATS);
  if (!pose || !frames.relate(axle, wheelset.frame, toFrame)) return UNIDENTIFIED;
  frames.relate(axle, MODEL_ROOT, toModel);
  const ownLocal = signedUnitRow(toFrame, wheelset.dimension);
  const upLocal = signedUnitRow(toModel, MODEL_UP);
  const own = ownLocal ? carriedTo(pose, ownLocal) : null;
  const up = upLocal ? carriedTo(pose, upLocal) : null;
  const point = new IdentifiedPoint();
  const identified = identifyPoint(
    toFrame,
    wheelset.axlePoint[0] ?? 0,
    wheelset.axlePoint[1] ?? 0,
    wheelset.axlePoint[2] ?? 0,
    1 << wheelset.dimension,
    point,
  );
  if (!own || !up || !identified) return UNIDENTIFIED;
  const local = [0, 1, 2].map((k) => exactRationalFromFloat64(wheelset.axlePoint[k] ?? 0));
  const at = (row: number): ExactRational =>
    local.reduce(
      (sum, value, k) =>
        addExactRational(sum, multiplyExactRational(pose[row * ROW + k] ?? ZERO, value)),
      pose[row * ROW + TRANSLATION] ?? ZERO,
    );
  const axleLateral = exactRational(BigInt(point.sixteenths[wheelset.dimension] ?? 0), 1n);
  const centre = exactRational(BigInt(wheelset.trackCentre), 1n);
  const lateralRoot = at(own.axis);
  const along = (offset: ExactRational): ExactRational =>
    addExactRational(
      lateralRoot,
      multiplyExactRational(toLdu(offset), exactRational(BigInt(own.sign), 1n)),
    );
  return {
    up: up.axis,
    upSign: up.sign,
    railTopHeight: subtractExactRational(
      multiplyExactRational(at(up.axis), exactRational(BigInt(up.sign), 1n)),
      wheelset.rollingRadius,
    ),
    lateral: own.axis,
    headBands: seated.headBands.map(([from, to]) => {
      const ends = [from, to].map((end) =>
        along(subtractExactRational(addExactRational(centre, end), axleLateral)),
      );
      const [first = ZERO, second = ZERO] = ends;
      return compareExactRational(first, second) <= 0
        ? { low: first, high: second }
        : { low: second, high: first };
    }),
  };
}

function lowestAlong(
  box: ReadonlyArray<Interval>,
  axis: number,
  sign: number,
): ExactRational | null {
  const interval = box[axis];
  if (!interval) return null;
  return sign > 0 ? interval.low : multiplyExactRational(interval.high, MINUS_ONE);
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
  const rootPlanes = seated.map((wheelset) => authoredPlane(frames, instances, authored, wheelset));
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
        const lateral = root ? box?.[root.lateral] : undefined;
        const lowest = root && box ? lowestAlong(box, root.up, root.upSign) : null;
        if (!root || !lateral || !lowest) {
          identified = false;
          continue;
        }
        fails =
          compareExactRational(lowest, root.railTopHeight) < 0 &&
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

import { SIXTEENTHS_PER_LDU } from "@brr/math";
import {
  AXIS_FREE,
  AXIS_NEG_X,
  AXIS_NEG_Y,
  AXIS_NEG_Z,
  AXIS_POS_X,
  AXIS_POS_Y,
  AXIS_POS_Z,
} from "./connector-table.ts";
import {
  CAP_FAR,
  CAP_ROOT,
  FINGER_RADIUS_UNSTATED,
  SECTION_AXLE,
  SECTION_FEMALE_FINGER,
  SECTION_MALE_FINGER,
  SECTION_ROUND,
  SECTION_SQUARE,
  type SnapShapes,
} from "./snap-shapes.ts";

const MISFIT = 0;
const LOOSE = 1;
const TOUCHING = 2;
const PAIR_KEY_SPAN = 2 ** 16;
const NO_OFFSETS = new Int32Array(0);

function inside(inner: number, outer: number): number {
  if (inner < outer) return LOOSE;
  return inner === outer ? TOUCHING : MISFIT;
}

function hasReading(code: number): boolean {
  return code === SECTION_ROUND || code === SECTION_AXLE || code === SECTION_SQUARE;
}

function containment(
  maleCode: number,
  maleSize: number,
  femaleCode: number,
  femaleSize: number,
): number {
  const symmetric = hasReading(maleCode);
  if (femaleCode === SECTION_AXLE) {
    return maleCode === SECTION_AXLE ? inside(maleSize, femaleSize) : MISFIT;
  }
  if (femaleCode === SECTION_SQUARE) return symmetric ? inside(maleSize, femaleSize) : MISFIT;
  if (femaleCode !== SECTION_ROUND || !symmetric) return MISFIT;
  return maleCode === SECTION_SQUARE
    ? inside(2 * maleSize * maleSize, femaleSize * femaleSize)
    : inside(maleSize, femaleSize);
}

function interleaves(maleCode: number, femaleCode: number): boolean {
  return (
    (maleCode === SECTION_MALE_FINGER && femaleCode === SECTION_FEMALE_FINGER) ||
    (maleCode === SECTION_FEMALE_FINGER && femaleCode === SECTION_MALE_FINGER)
  );
}

function radiiAgree(maleRadius: number, femaleRadius: number): boolean {
  return (
    maleRadius === FINGER_RADIUS_UNSTATED ||
    femaleRadius === FINGER_RADIUS_UNSTATED ||
    maleRadius === femaleRadius
  );
}

function locksRotation(maleCode: number, femaleCode: number): boolean {
  return maleCode === femaleCode && maleCode !== SECTION_ROUND;
}

function axisLine(axis: number): number {
  switch (axis) {
    case AXIS_POS_X:
    case AXIS_NEG_X:
      return AXIS_POS_X;
    case AXIS_POS_Y:
    case AXIS_NEG_Y:
      return AXIS_POS_Y;
    case AXIS_POS_Z:
    case AXIS_NEG_Z:
      return AXIS_POS_Z;
    default:
      return AXIS_FREE;
  }
}

function addRange(ranges: number[], from: number, to: number): void {
  const last = ranges.length - 1;
  if (last > 0 && (ranges[last] ?? 0) + 1 >= from) {
    ranges[last] = Math.max(ranges[last] ?? 0, to);
    return;
  }
  ranges.push(from, to);
}

function pointsOf(ranges: Int32Array): Int32Array {
  let count = 0;
  for (let i = 0; i < ranges.length; i += 2) count += (ranges[i + 1] ?? 0) - (ranges[i] ?? 0) + 1;
  const points = new Int32Array(count);
  let n = 0;
  for (let i = 0; i < ranges.length; i += 2) {
    for (let d = ranges[i] ?? 0; d <= (ranges[i + 1] ?? 0); d++) points[n++] = d;
  }
  return points;
}

export interface MateFreedom {
  readonly spins: boolean;
  readonly axis: number;
  readonly freeAboutVertical: boolean;
}

export class SnapMating {
  private readonly rangeMemo = new Map<number, Int32Array>();
  private readonly offsetMemo = new Map<number, Int32Array>();

  constructor(readonly shapes: SnapShapes) {}

  ranges(maleShape: number, femaleShape: number): Int32Array {
    const key = maleShape * PAIR_KEY_SPAN + femaleShape;
    let ranges = this.rangeMemo.get(key);
    if (!ranges) {
      ranges = this.engagedRanges(maleShape, femaleShape);
      this.rangeMemo.set(key, ranges);
    }
    return ranges;
  }

  offsets(maleShape: number, femaleShape: number): Int32Array {
    const key = maleShape * PAIR_KEY_SPAN + femaleShape;
    let offsets = this.offsetMemo.get(key);
    if (!offsets) {
      offsets = pointsOf(this.ranges(maleShape, femaleShape));
      this.offsetMemo.set(key, offsets);
    }
    return offsets;
  }

  engages(maleShape: number, femaleShape: number, offsetSixteenths: number): boolean {
    const ranges = this.ranges(maleShape, femaleShape);
    for (let i = 0; i < ranges.length; i += 2) {
      if (offsetSixteenths < (ranges[i] ?? 0)) return false;
      if (offsetSixteenths <= (ranges[i + 1] ?? 0)) return true;
    }
    return false;
  }

  freedom(
    maleShape: number,
    femaleShape: number,
    offsetSixteenths: number,
    maleAxis: number,
  ): MateFreedom {
    if (!this.engages(maleShape, femaleShape, offsetSixteenths)) {
      throw new RangeError(
        `shapes ${maleShape} and ${femaleShape} don't mate at offset ${offsetSixteenths}/${SIXTEENTHS_PER_LDU} LDU, so they have no freedom to report`,
      );
    }
    const shapes = this.shapes;
    let locked = false;
    let inserted = false;
    const offset = offsetSixteenths / SIXTEENTHS_PER_LDU;
    this.overlaps(maleShape, femaleShape, offset, (m, f, shared) => {
      if (shared === 0) return true;
      inserted = true;
      locked ||= locksRotation(shapes.maleCode(m), shapes.femaleCode(f));
      return true;
    });
    return { spins: !locked, axis: axisLine(maleAxis), freeAboutVertical: !inserted };
  }

  private engagedRanges(male: number, female: number): Int32Array {
    const shapes = this.shapes;
    if (shapes.group(male) !== shapes.group(female)) return NO_OFFSETS;
    const maleLength = shapes.length(male);
    const femaleLength = shapes.length(female);
    const travel = (maleLength - femaleLength) * SIXTEENTHS_PER_LDU;
    const threadable =
      (shapes.caps(female) & CAP_FAR) === 0 || (shapes.caps(male) & CAP_ROOT) === 0;
    const sliding = shapes.slides(male) || shapes.slides(female);
    let low = 0;
    let high = 0;
    if (sliding || threadable) {
      low = femaleLength <= maleLength ? 0 : Math.ceil(travel);
      high = femaleLength <= maleLength ? Math.floor(travel) : 0;
    }
    const partway = sliding && threadable;
    const events = this.events(male, female, low, high);
    const ranges: number[] = [];
    for (let i = 0; i < events.length; i++) {
      const at = events[i] ?? 0;
      if (this.engagedAt(male, female, at, low, high, partway)) addRange(ranges, at, at);
      const next = events[i + 1];
      if (next === undefined || next - at < 2) continue;
      if (this.engagedAt(male, female, at + 1, low, high, partway)) {
        addRange(ranges, at + 1, next - 1);
      }
    }
    return ranges.length === 0 ? NO_OFFSETS : Int32Array.from(ranges);
  }

  private engagedAt(
    male: number,
    female: number,
    sixteenths: number,
    low: number,
    high: number,
    partway: boolean,
  ): boolean {
    const offset = sixteenths / SIXTEENTHS_PER_LDU;
    if (!this.stopsAllow(male, female, offset) || !this.contains(male, female, offset))
      return false;
    if (partway || (sixteenths >= low && sixteenths <= high)) return true;
    return this.seated(male, female, offset);
  }

  private events(male: number, female: number, low: number, high: number): number[] {
    const shapes = this.shapes;
    const events: number[] = [low, high];
    let maleAt = 0;
    for (let m = 0; m <= shapes.sectionCount(male); m++) {
      if (m > 0) maleAt += shapes.span(shapes.firstSection(male) + m - 1);
      let femaleAt = 0;
      for (let f = 0; f <= shapes.sectionCount(female); f++) {
        if (f > 0) femaleAt += shapes.span(shapes.firstSection(female) + f - 1);
        const d = (maleAt - femaleAt) * SIXTEENTHS_PER_LDU;
        events.push(Math.floor(d), Math.ceil(d));
      }
    }
    events.sort((a, b) => a - b);
    return events.filter((d, i) => i === 0 || d !== events[i - 1]);
  }

  private seated(male: number, female: number, offset: number): boolean {
    const shapes = this.shapes;
    const femaleFar = offset + shapes.length(female);
    const maleLength = shapes.length(male);
    if ((shapes.caps(female) & CAP_FAR) !== 0 && femaleFar <= maleLength) return true;
    if ((shapes.caps(male) & CAP_FAR) !== 0 && femaleFar >= maleLength) return true;
    return this.meetsBlockingSection(male, female, offset);
  }

  private meetsBlockingSection(male: number, female: number, offset: number): boolean {
    const shapes = this.shapes;
    let maleFrom = 0;
    for (
      let m = shapes.firstSection(male);
      m < shapes.firstSection(male) + shapes.sectionCount(male);
      m++
    ) {
      const maleTo = maleFrom + shapes.span(m);
      let femaleFrom = offset;
      for (
        let f = shapes.firstSection(female);
        f < shapes.firstSection(female) + shapes.sectionCount(female);
        f++
      ) {
        const femaleTo = femaleFrom + shapes.span(f);
        const meeting = maleTo === femaleFrom || femaleTo === maleFrom;
        if (meeting && this.blocks(m, f, female, offset, maleFrom, maleTo)) return true;
        femaleFrom = femaleTo;
      }
      maleFrom = maleTo;
    }
    return false;
  }

  private blocks(
    m: number,
    f: number,
    female: number,
    offset: number,
    maleFrom: number,
    maleTo: number,
  ): boolean {
    const shapes = this.shapes;
    const code = shapes.maleCode(m);
    if (!hasReading(code) || !hasReading(shapes.femaleCode(f))) return false;
    if (
      containment(code, shapes.maleSize(m), shapes.femaleCode(f), shapes.femaleSize(f)) === MISFIT
    ) {
      return true;
    }
    const relaxed = shapes.maleRelaxedSize(m);
    return (
      containment(code, relaxed, shapes.femaleCode(f), shapes.femaleSize(f)) === MISFIT &&
      this.relaxedWithin(code, relaxed, female, offset, maleFrom, maleTo)
    );
  }

  private relaxedWithin(
    code: number,
    relaxed: number,
    female: number,
    offset: number,
    maleFrom: number,
    maleTo: number,
  ): boolean {
    const shapes = this.shapes;
    let femaleFrom = offset;
    for (
      let f = shapes.firstSection(female);
      f < shapes.firstSection(female) + shapes.sectionCount(female);
      f++
    ) {
      const femaleTo = femaleFrom + shapes.span(f);
      const overlapping = Math.min(maleTo, femaleTo) - Math.max(maleFrom, femaleFrom) > 0;
      if (
        overlapping &&
        containment(code, relaxed, shapes.femaleCode(f), shapes.femaleSize(f)) === MISFIT
      ) {
        return false;
      }
      femaleFrom = femaleTo;
    }
    return true;
  }

  private stopsAllow(male: number, female: number, offset: number): boolean {
    const shapes = this.shapes;
    const femaleFar = offset + shapes.length(female);
    const maleLength = shapes.length(male);
    if ((shapes.caps(male) & CAP_ROOT) !== 0 && offset < 0) return false;
    if ((shapes.caps(female) & CAP_FAR) !== 0 && femaleFar < maleLength) return false;
    return (shapes.caps(male) & CAP_FAR) === 0 || femaleFar <= maleLength;
  }

  private contains(male: number, female: number, offset: number): boolean {
    let touched = false;
    const comparesRadii = !this.shapes.grouped(male);
    const fits = this.overlaps(male, female, offset, (m, f, shared) => {
      const fit = this.fit(m, f, shared, comparesRadii);
      touched ||= fit === TOUCHING;
      return fit !== MISFIT;
    });
    return fits && touched;
  }

  private fit(m: number, f: number, shared: number, comparesRadii: boolean): number {
    const shapes = this.shapes;
    const maleCode = shapes.maleCode(m);
    const femaleCode = shapes.femaleCode(f);
    const maleSize = shapes.maleSize(m);
    const femaleSize = shapes.femaleSize(f);
    if (interleaves(maleCode, femaleCode)) {
      const exact = shared === shapes.span(m) && shared === shapes.span(f);
      const radii = !comparesRadii || radiiAgree(maleSize, femaleSize);
      return exact && radii ? TOUCHING : MISFIT;
    }
    return containment(maleCode, maleSize, femaleCode, femaleSize);
  }

  private overlaps(
    male: number,
    female: number,
    offset: number,
    visit: (maleSection: number, femaleSection: number, shared: number) => boolean,
  ): boolean {
    const shapes = this.shapes;
    let m = shapes.firstSection(male);
    const maleEnd = m + shapes.sectionCount(male);
    let f = shapes.firstSection(female);
    const femaleEnd = f + shapes.sectionCount(female);
    let maleFrom = 0;
    let maleTo = shapes.span(m);
    let femaleFrom = offset;
    let femaleTo = offset + shapes.span(f);
    while (m < maleEnd && f < femaleEnd) {
      const shared = Math.min(maleTo, femaleTo) - Math.max(maleFrom, femaleFrom);
      const degenerate = maleTo === maleFrom || femaleTo === femaleFrom;
      if ((shared > 0 || (shared === 0 && degenerate)) && !visit(m, f, shared)) return false;
      if (maleTo <= femaleTo) {
        m++;
        maleFrom = maleTo;
        maleTo += shapes.span(m);
      } else {
        f++;
        femaleFrom = femaleTo;
        femaleTo += shapes.span(f);
      }
    }
    return true;
  }
}

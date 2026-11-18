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
  SECTION_AXLE,
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

function containment(
  maleCode: number,
  maleSize: number,
  femaleCode: number,
  femaleSize: number,
): number {
  const symmetric =
    maleCode === SECTION_ROUND || maleCode === SECTION_AXLE || maleCode === SECTION_SQUARE;
  if (femaleCode === SECTION_AXLE) {
    return maleCode === SECTION_AXLE ? inside(maleSize, femaleSize) : MISFIT;
  }
  if (femaleCode === SECTION_SQUARE) return symmetric ? inside(maleSize, femaleSize) : MISFIT;
  if (femaleCode !== SECTION_ROUND || !symmetric) return MISFIT;
  return maleCode === SECTION_SQUARE
    ? inside(2 * maleSize * maleSize, femaleSize * femaleSize)
    : inside(maleSize, femaleSize);
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

export interface MateFreedom {
  readonly spins: boolean;
  readonly axis: number;
  readonly pivots: boolean;
}

export class SnapMating {
  private readonly memo = new Map<number, Int32Array>();

  constructor(readonly shapes: SnapShapes) {}

  offsets(maleShape: number, femaleShape: number): Int32Array {
    const key = maleShape * PAIR_KEY_SPAN + femaleShape;
    let offsets = this.memo.get(key);
    if (!offsets) {
      offsets = this.engagedOffsets(maleShape, femaleShape);
      this.memo.set(key, offsets);
    }
    return offsets;
  }

  engages(maleShape: number, femaleShape: number, offset: number): boolean {
    const offsets = this.offsets(maleShape, femaleShape);
    for (let i = 0; i < offsets.length; i++) if (offsets[i] === offset) return true;
    return false;
  }

  freedom(maleShape: number, femaleShape: number, offset: number, maleAxis: number): MateFreedom {
    if (!this.engages(maleShape, femaleShape, offset)) {
      throw new RangeError(
        `shapes ${maleShape} and ${femaleShape} don't mate at offset ${offset}, so they have no freedom to report`,
      );
    }
    const shapes = this.shapes;
    let locked = false;
    let inserted = false;
    this.overlaps(maleShape, femaleShape, offset, (m, f, shared) => {
      if (shared === 0) return true;
      inserted = true;
      locked ||= locksRotation(shapes.maleCode(m), shapes.femaleCode(f));
      return true;
    });
    return { spins: !locked, axis: axisLine(maleAxis), pivots: !inserted };
  }

  private engagedOffsets(male: number, female: number): Int32Array {
    const shapes = this.shapes;
    if (shapes.group(male) !== shapes.group(female)) return NO_OFFSETS;
    const maleLength = shapes.length(male);
    const femaleLength = shapes.length(female);
    let low = 0;
    let high = 0;
    if (shapes.slides(male) || shapes.slides(female)) {
      low = femaleLength <= maleLength ? 0 : Math.ceil(maleLength - femaleLength);
      high = femaleLength <= maleLength ? Math.floor(maleLength - femaleLength) : 0;
    }
    const valid: number[] = [];
    for (let d = low; d <= high; d++) {
      if (this.stopsAllow(male, female, d) && this.contains(male, female, d)) valid.push(d);
    }
    return valid.length === 0 ? NO_OFFSETS : Int32Array.from(valid);
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
    const shapes = this.shapes;
    let touched = false;
    const fits = this.overlaps(male, female, offset, (m, f) => {
      const fit = containment(
        shapes.maleCode(m),
        shapes.maleSize(m),
        shapes.femaleCode(f),
        shapes.femaleSize(f),
      );
      touched ||= fit === TOUCHING;
      return fit !== MISFIT;
    });
    return fits && touched;
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

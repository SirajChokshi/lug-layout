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

  private engagedOffsets(male: number, female: number): Int32Array {
    const shapes = this.shapes;
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
    let m = shapes.firstSection(male);
    const maleEnd = m + shapes.sectionCount(male);
    let f = shapes.firstSection(female);
    const femaleEnd = f + shapes.sectionCount(female);
    let maleFrom = 0;
    let maleTo = shapes.span(m);
    let femaleFrom = offset;
    let femaleTo = offset + shapes.span(f);
    let touched = false;
    while (m < maleEnd && f < femaleEnd) {
      if (Math.min(maleTo, femaleTo) > Math.max(maleFrom, femaleFrom)) {
        const fit = containment(shapes.code(m), shapes.size(m), shapes.code(f), shapes.size(f));
        if (fit === MISFIT) return false;
        touched ||= fit === TOUCHING;
      }
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
    return touched;
  }
}

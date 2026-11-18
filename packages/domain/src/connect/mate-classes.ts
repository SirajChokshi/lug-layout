import { GENDER_FEMALE, GENDER_MALE } from "./connector-table.ts";
import type { SnapMating } from "./mating.ts";

const GENDERS = 2;
const RANGE_INTS = 2;
const NO_RANGES = new Int32Array(0);

export class MateClasses {
  private readonly shape: number[] = [];
  private readonly gender: number[] = [];
  private readonly ids = new Map<number, number>();
  pairStart = new Int32Array(1);
  pairClass = new Int32Array(0);
  pairRangeStart = new Int32Array(1);
  rangeLow = new Int32Array(0);
  rangeHigh = new Int32Array(0);
  lineLow = new Int32Array(0);
  lineHigh = new Int32Array(0);

  constructor(private readonly mating: SnapMating) {}

  get count(): number {
    return this.shape.length;
  }

  classOf(shape: number, gender: number): number {
    const key = shape * GENDERS + gender;
    const known = this.ids.get(key);
    if (known !== undefined) return known;
    this.shape.push(shape);
    this.gender.push(gender);
    this.ids.set(key, this.shape.length - 1);
    this.rebuildPairs();
    return this.shape.length - 1;
  }

  engagesAt(own: number, partner: number, offset: number): boolean {
    for (let p = this.pairStart[own] ?? 0; p < (this.pairStart[own + 1] ?? 0); p++) {
      if (this.pairClass[p] === partner) return this.pairEngages(p, offset);
    }
    return false;
  }

  pairEngages(pair: number, offset: number): boolean {
    const r = this.firstRangeReaching(pair, offset);
    return r < (this.pairRangeStart[pair + 1] ?? 0) && (this.rangeLow[r] ?? 0) <= offset;
  }

  firstRangeReaching(pair: number, offset: number): number {
    let low = this.pairRangeStart[pair] ?? 0;
    let high = this.pairRangeStart[pair + 1] ?? 0;
    while (low < high) {
      const middle = (low + high) >> 1;
      if ((this.rangeHigh[middle] ?? 0) < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  private engagement(own: number, other: number): Int32Array {
    const male = this.gender[own] === GENDER_MALE ? own : other;
    const female = male === own ? other : own;
    if (this.gender[male] !== GENDER_MALE || this.gender[female] !== GENDER_FEMALE) {
      return NO_RANGES;
    }
    return this.mating.ranges(this.shape[male] ?? 0, this.shape[female] ?? 0);
  }

  private rebuildPairs(): void {
    const classes = this.shape.length;
    const start = new Int32Array(classes + 1);
    const lineLow = new Int32Array(classes).fill(1);
    const lineHigh = new Int32Array(classes);
    const partner: number[] = [];
    const runStart: number[] = [0];
    const low: number[] = [];
    const high: number[] = [];
    for (let own = 0; own < classes; own++) {
      start[own] = partner.length;
      for (let other = 0; other < classes; other++) {
        const ranges = this.engagement(own, other);
        if (ranges.length === 0) continue;
        const first = ranges[0] ?? 0;
        const last = ranges[ranges.length - 1] ?? 0;
        const opened = partner.length > (start[own] ?? 0);
        lineLow[own] = opened ? Math.min(lineLow[own] ?? 0, first) : first;
        lineHigh[own] = opened ? Math.max(lineHigh[own] ?? 0, last) : last;
        partner.push(other);
        for (let k = 0; k < ranges.length; k += RANGE_INTS) {
          low.push(ranges[k] ?? 0);
          high.push(ranges[k + 1] ?? 0);
        }
        runStart.push(low.length);
      }
    }
    start[classes] = partner.length;
    this.pairStart = start;
    this.pairClass = Int32Array.from(partner);
    this.pairRangeStart = Int32Array.from(runStart);
    this.rangeLow = Int32Array.from(low);
    this.rangeHigh = Int32Array.from(high);
    this.lineLow = lineLow;
    this.lineHigh = lineHigh;
  }
}

import { GENDER_FEMALE, GENDER_MALE } from "./connector-table.ts";
import type { SnapMating } from "./mating.ts";

export class MateClasses {
  private readonly shape: number[] = [];
  private readonly gender: number[] = [];
  pairStart = new Int32Array(1);
  pairClass = new Int32Array(0);
  pairOffsetStart = new Int32Array(1);
  offsets = new Int32Array(0);

  constructor(private readonly mating: SnapMating) {}

  classOf(shape: number, gender: number): number {
    for (let c = 0; c < this.shape.length; c++) {
      if (this.shape[c] === shape && this.gender[c] === gender) return c;
    }
    this.shape.push(shape);
    this.gender.push(gender);
    this.rebuildPairs();
    return this.shape.length - 1;
  }

  private engagement(own: number, other: number): Int32Array | null {
    if (this.gender[own] === GENDER_MALE && this.gender[other] === GENDER_FEMALE) {
      return this.mating.offsets(this.shape[own] ?? 0, this.shape[other] ?? 0);
    }
    if (this.gender[own] === GENDER_FEMALE && this.gender[other] === GENDER_MALE) {
      return this.mating.offsets(this.shape[other] ?? 0, this.shape[own] ?? 0);
    }
    return null;
  }

  private rebuildPairs(): void {
    const classes = this.shape.length;
    const start = new Int32Array(classes + 1);
    const partner: number[] = [];
    const offsetStart: number[] = [0];
    const offsets: number[] = [];
    for (let own = 0; own < classes; own++) {
      start[own] = partner.length;
      for (let other = 0; other < classes; other++) {
        const engaged = this.engagement(own, other);
        if (!engaged || engaged.length === 0) continue;
        partner.push(other);
        for (let k = 0; k < engaged.length; k++) offsets.push(engaged[k] ?? 0);
        offsetStart.push(offsets.length);
      }
    }
    start[classes] = partner.length;
    this.pairStart = start;
    this.pairClass = Int32Array.from(partner);
    this.pairOffsetStart = Int32Array.from(offsetStart);
    this.offsets = Int32Array.from(offsets);
  }
}

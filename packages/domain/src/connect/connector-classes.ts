import { GENDER_FEMALE, GENDER_MALE } from "./connector-table.ts";
import type { SnapMating } from "./mating.ts";
import type { ModelConnectors } from "./model-connectors.ts";

export class ConnectorClasses {
  private readonly shape: number[] = [];
  private readonly gender: number[] = [];
  private readonly axisKey: number[] = [];
  private readonly source: number[] = [];
  pairStart = new Int32Array(1);
  pairClass = new Int32Array(0);
  pairStep = new Int8Array(0);
  pairSource = new Uint8Array(0);
  pairOffsetStart = new Int32Array(1);
  offsets = new Int32Array(0);

  constructor(private readonly mating: SnapMating) {}

  classOf(model: ModelConnectors, connector: number, axisKey: number): number {
    const shape = model.shape[connector] ?? 0;
    const gender = model.gender[connector] ?? 0;
    const source = model.source[connector] ?? 0;
    for (let c = 0; c < this.shape.length; c++) {
      if (
        this.shape[c] === shape &&
        this.gender[c] === gender &&
        this.axisKey[c] === axisKey &&
        this.source[c] === source
      ) {
        return c;
      }
    }
    this.shape.push(shape);
    this.gender.push(gender);
    this.axisKey.push(axisKey);
    this.source.push(source);
    this.rebuildPairs();
    return this.shape.length - 1;
  }

  private engagement(own: number, other: number): Int32Array | null {
    if (this.axisKey[own] !== -(this.axisKey[other] ?? 0)) return null;
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
    const step: number[] = [];
    const source: number[] = [];
    const offsetStart: number[] = [0];
    const offsets: number[] = [];
    for (let own = 0; own < classes; own++) {
      start[own] = partner.length;
      for (let other = 0; other < classes; other++) {
        const engaged = this.engagement(own, other);
        if (!engaged || engaged.length === 0) continue;
        partner.push(other);
        step.push(this.axisKey[own] ?? 0);
        source.push(Math.max(this.source[own] ?? 0, this.source[other] ?? 0));
        for (let k = 0; k < engaged.length; k++) offsets.push(engaged[k] ?? 0);
        offsetStart.push(offsets.length);
      }
    }
    start[classes] = partner.length;
    this.pairStart = start;
    this.pairClass = Int32Array.from(partner);
    this.pairStep = Int8Array.from(step);
    this.pairSource = Uint8Array.from(source);
    this.pairOffsetStart = Int32Array.from(offsetStart);
    this.offsets = Int32Array.from(offsets);
  }
}

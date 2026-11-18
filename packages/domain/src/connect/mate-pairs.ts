export const MATE_PASS_MODEL = 0;
export const MATE_PASS_SUBMODEL = 1;
export const MATE_PASS_PART = 2;

export type MatePass = typeof MATE_PASS_MODEL | typeof MATE_PASS_SUBMODEL | typeof MATE_PASS_PART;

function isMatePass(code: number | undefined): code is MatePass {
  return code === MATE_PASS_MODEL || code === MATE_PASS_SUBMODEL || code === MATE_PASS_PART;
}

export class MatePairs {
  readonly count: number;

  constructor(
    readonly maleInstance: Uint32Array,
    readonly femaleInstance: Uint32Array,
    readonly maleConnector: Uint32Array,
    readonly femaleConnector: Uint32Array,
    readonly pass: Uint8Array,
    readonly mateAxis: Int8Array,
    readonly mateOffset: Int32Array,
  ) {
    const count = maleInstance.length;
    if (
      femaleInstance.length !== count ||
      maleConnector.length !== count ||
      femaleConnector.length !== count ||
      pass.length !== count ||
      mateAxis.length !== count ||
      mateOffset.length !== count
    ) {
      throw new RangeError(`mate pair columns disagree on the count of ${count} mates`);
    }
    for (let k = 0; k < count; k++) {
      if (!isMatePass(pass[k])) throw new RangeError(`mate ${k} has pass ${pass[k]}`);
    }
    this.count = count;
  }

  passOf(mate: number): MatePass {
    const code = this.pass[mate];
    if (!isMatePass(code)) throw new RangeError(`mate ${mate} is outside ${this.count} mates`);
    return code;
  }
}

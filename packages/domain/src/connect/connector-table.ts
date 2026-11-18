export const PROFILE_ROUND = 0;
export const PROFILE_CROSS = 1;
export const GENDER_MALE = 0;
export const GENDER_FEMALE = 1;
export const VECTOR_FLOATS = 3;

function isFlag(value: number | undefined): boolean {
  return value === 0 || value === 1;
}

export class ConnectorTable {
  readonly count: number;

  constructor(
    readonly profile: Uint8Array,
    readonly gender: Uint8Array,
    readonly radius: Float32Array,
    readonly origin: Float32Array,
    readonly axis: Float32Array,
    readonly reach: Float32Array,
  ) {
    const count = profile.length;
    if (
      gender.length !== count ||
      radius.length !== count ||
      reach.length !== count ||
      origin.length !== count * VECTOR_FLOATS ||
      axis.length !== count * VECTOR_FLOATS
    ) {
      throw new RangeError(`connector arrays disagree on the count of ${count} connectors`);
    }
    for (let i = 0; i < count; i++) {
      if (!isFlag(profile[i]) || !isFlag(gender[i])) {
        throw new RangeError(`connector ${i} has profile ${profile[i]} and gender ${gender[i]}`);
      }
    }
    this.count = count;
  }
}

export const GENDER_MALE = 0;
export const GENDER_FEMALE = 1;
export const SOURCE_SHADOW = 1;
export const SOURCE_PRIMITIVE = 2;
export const SOURCE_INFERRED = 4;
export const SOURCE_PATCH = 8;
export const SOURCES: ReadonlyArray<number> = [
  SOURCE_SHADOW,
  SOURCE_PRIMITIVE,
  SOURCE_INFERRED,
  SOURCE_PATCH,
];
export const STATUS_VERIFIED = 0;
export const STATUS_UNVERIFIED = 1;
export const STATUSES: ReadonlyArray<number> = [STATUS_VERIFIED, STATUS_UNVERIFIED];
export const AXIS_FREE = -1;
export const AXIS_POS_X = 0;
export const AXIS_NEG_X = 1;
export const AXIS_POS_Y = 2;
export const AXIS_NEG_Y = 3;
export const AXIS_POS_Z = 4;
export const AXIS_NEG_Z = 5;
export const VECTOR_FLOATS = 3;

export function axisDimension(code: number): number {
  return code >> 1;
}

export function axisSign(code: number): number {
  return (code & 1) === 0 ? 1 : -1;
}

export function oppositeAxis(code: number): number {
  return code ^ 1;
}

function isSource(value: number | undefined): boolean {
  return value !== undefined && SOURCES.includes(value);
}

function isStatus(value: number | undefined): boolean {
  return value === STATUS_VERIFIED || value === STATUS_UNVERIFIED;
}

export class ConnectorTable {
  readonly count: number;

  constructor(
    readonly shape: Uint16Array,
    readonly gender: Uint8Array,
    readonly source: Uint8Array,
    readonly status: Uint8Array,
    readonly origin: Float32Array,
    readonly axis: Int8Array,
    readonly axisFree: Float32Array,
    readonly piece: Uint16Array = new Uint16Array(shape.length),
  ) {
    const count = shape.length;
    if (
      gender.length !== count ||
      source.length !== count ||
      status.length !== count ||
      axis.length !== count ||
      piece.length !== count ||
      origin.length !== count * VECTOR_FLOATS ||
      axisFree.length !== count * VECTOR_FLOATS
    ) {
      throw new RangeError(`connector arrays disagree on the count of ${count} connectors`);
    }
    for (let i = 0; i < count; i++) {
      const gendered = gender[i] === GENDER_MALE || gender[i] === GENDER_FEMALE;
      const axisCode = axis[i] ?? AXIS_FREE;
      const known = isSource(source[i]) && isStatus(status[i]);
      if (!gendered || !known || axisCode < AXIS_FREE || axisCode > AXIS_NEG_Z) {
        throw new RangeError(
          `connector ${i} has gender ${gender[i]}, source ${source[i]}, status ${status[i]} and axis ${axisCode}`,
        );
      }
    }
    this.count = count;
  }
}

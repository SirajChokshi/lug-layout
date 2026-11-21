import { SIXTEENTHS_PER_LDU } from "@brr/math";
import type { ConnectorColumns } from "./connector-columns.ts";
import { NO_GROUP, SECTION_FEMALE_FINGER, type SnapShapes } from "./snap-shapes.ts";

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
const LAST_SECTION_CODE = SECTION_FEMALE_FINGER;

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

const NO_FREE_ROW = -1;

export class ConnectorTable {
  readonly count: number;

  constructor(
    readonly shape: Uint16Array,
    readonly gender: Uint8Array,
    readonly source: Uint8Array,
    readonly status: Uint8Array,
    readonly origin: Int32Array,
    readonly axis: Int8Array,
    readonly axisFree: Float64Array,
    readonly piece: Uint16Array,
    readonly originFree: Float64Array,
    readonly unreadable: ReadonlyArray<string>,
  ) {
    const count = shape.length;
    if (
      gender.length !== count ||
      source.length !== count ||
      status.length !== count ||
      axis.length !== count ||
      piece.length !== count ||
      origin.length !== count * VECTOR_FLOATS ||
      axisFree.length !== count * VECTOR_FLOATS ||
      originFree.length !== count * VECTOR_FLOATS
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

  static fromColumns(columns: ConnectorColumns, shapes: SnapShapes, part: string): ConnectorTable {
    const { count } = columns;
    const refuse = (problem: string): never => {
      throw new RangeError(`${part}: ${problem}`);
    };
    const originFree = new Float64Array(count * VECTOR_FLOATS);
    const axisFree = new Float64Array(count * VECTOR_FLOATS);
    const freeRow = new Int32Array(count).fill(NO_FREE_ROW);
    for (let f = 0; f < columns.freeFace.length; f++) {
      const face = columns.freeFace[f] ?? count;
      if (face >= count || columns.axis[face] !== AXIS_FREE) {
        refuse(`free connector ${f} names face ${face}, which is not a free face`);
      }
      if (freeRow[face] !== NO_FREE_ROW) refuse(`free face ${face} has more than one free origin`);
      freeRow[face] = f;
      for (let k = 0; k < VECTOR_FLOATS; k++) {
        originFree[face * VECTOR_FLOATS + k] = columns.freeOrigin[f * VECTOR_FLOATS + k] ?? 0;
        axisFree[face * VECTOR_FLOATS + k] = columns.freeAxis[f * VECTOR_FLOATS + k] ?? 0;
      }
    }
    const shape = new Uint16Array(count);
    for (let i = 0; i < count; i++) {
      if (columns.axis[i] === AXIS_FREE && freeRow[i] === NO_FREE_ROW) {
        refuse(`free face ${i} has no free origin`);
      }
      const start = columns.sectionStart[i] ?? 0;
      const sections = columns.sectionCount[i] ?? 0;
      if (sections === 0) refuse(`face ${i} has no sections`);
      if (start + sections > columns.sectionCode.length) {
        refuse(`face ${i}'s sections run past the section columns`);
      }
      const codes = columns.sectionCode.subarray(start, start + sections);
      for (const code of codes) {
        if (code > LAST_SECTION_CODE) refuse(`face ${i} has section code ${code}`);
      }
      shape[i] = shapes.intern(
        columns.caps[i] ?? 0,
        columns.slide[i] === 1,
        codes,
        columns.sectionSize.subarray(start, start + sections),
        columns.sectionLength.subarray(start, start + sections),
        columns.group[i] ?? NO_GROUP,
      );
    }
    return new ConnectorTable(
      shape,
      columns.gender,
      columns.source,
      columns.status,
      columns.origin,
      columns.axis,
      axisFree,
      columns.piece,
      originFree,
      columns.unreadable,
    );
  }
}

export function connectorOriginLdu(
  table: ConnectorTable,
  connector: number,
  coordinate: number,
): number {
  const v = connector * VECTOR_FLOATS + coordinate;
  return table.axis[connector] === AXIS_FREE
    ? (table.originFree[v] ?? 0)
    : (table.origin[v] ?? 0) / SIXTEENTHS_PER_LDU;
}

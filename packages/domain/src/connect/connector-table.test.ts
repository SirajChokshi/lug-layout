import { describe, expect, it } from "vitest";
import type { ConnectorColumns } from "./connector-columns.ts";
import {
  AXIS_FREE,
  AXIS_NEG_Y,
  AXIS_POS_Y,
  ConnectorTable,
  connectorOriginLdu,
  GENDER_FEMALE,
  GENDER_MALE,
  SOURCE_INFERRED,
  SOURCE_SHADOW,
  STATUS_UNVERIFIED,
  STATUS_VERIFIED,
} from "./connector-table.ts";
import { CAP_FAR, CAP_ROOT, SECTION_AXLE, SECTION_ROUND, SnapShapes } from "./snap-shapes.ts";

const PART = "custom-coupler.dat";
const NON_DYADIC_SIZE = 1.8;
const NON_DYADIC_LENGTH = 0.1;
const FREE_ORIGIN = [3.3, -7.1, 12.05];
const FREE_AXIS = [0.6, 0, 0.8];
const SECTION_CODE_PAST_THE_VOCABULARY = 9;

function customColumns(overrides: Partial<ConnectorColumns> = {}): ConnectorColumns {
  return {
    count: 3,
    gender: Uint8Array.of(GENDER_MALE, GENDER_FEMALE, GENDER_MALE),
    source: Uint8Array.of(SOURCE_SHADOW, SOURCE_INFERRED, SOURCE_SHADOW),
    status: Uint8Array.of(STATUS_VERIFIED, STATUS_UNVERIFIED, STATUS_VERIFIED),
    caps: Uint8Array.of(CAP_ROOT, CAP_FAR, 0),
    slide: Uint8Array.of(0, 1, 0),
    group: ["", "magnet", ""],
    origin: Int32Array.of(160, -128, 320, 0, 0, 0, 16, 8, -24),
    axis: Int8Array.of(AXIS_POS_Y, AXIS_FREE, AXIS_NEG_Y),
    sectionStart: Uint32Array.of(0, 1, 3),
    sectionCount: Uint32Array.of(1, 2, 1),
    sectionCode: Uint8Array.of(SECTION_ROUND, SECTION_AXLE, SECTION_ROUND, SECTION_ROUND),
    sectionSize: Float64Array.of(6, NON_DYADIC_SIZE, 4, 6),
    sectionLength: Float64Array.of(4, NON_DYADIC_LENGTH, 8, 4),
    piece: Uint16Array.of(0, 1, 1),
    freeFace: Uint32Array.of(1),
    freeOrigin: Float64Array.from(FREE_ORIGIN),
    freeAxis: Float64Array.from(FREE_AXIS),
    unreadable: ["generic"],
    ...overrides,
  };
}

function refusal(overrides: Partial<ConnectorColumns>): string {
  try {
    ConnectorTable.fromColumns(customColumns(overrides), new SnapShapes(), PART);
    return "converted";
  } catch (error) {
    return error instanceof RangeError ? error.message : "not a RangeError";
  }
}

function originsLdu(table: ConnectorTable): number[][] {
  return Array.from({ length: table.count }, (_, c) =>
    [0, 1, 2].map((k) => connectorOriginLdu(table, c, k)),
  );
}

describe("ConnectorTable.fromColumns", () => {
  it("converts custom columns losslessly: free faces, pieces, groups, slide, unreadable codes and non-dyadic sections", () => {
    const columns = customColumns();
    const shapes = new SnapShapes();
    const table = ConnectorTable.fromColumns(columns, shapes, PART);
    const reinterned = [0, 1, 2].map((i) => {
      const start = columns.sectionStart[i] ?? 0;
      const end = start + (columns.sectionCount[i] ?? 0);
      return shapes.intern(
        columns.caps[i] ?? 0,
        columns.slide[i] === 1,
        columns.sectionCode.subarray(start, end),
        columns.sectionSize.subarray(start, end),
        columns.sectionLength.subarray(start, end),
        columns.group[i] ?? "",
      );
    });
    const freeShape = table.shape[1] ?? 0;
    expect({
      gender: Array.from(table.gender),
      source: Array.from(table.source),
      status: Array.from(table.status),
      axis: Array.from(table.axis),
      piece: Array.from(table.piece),
      origin: Array.from(table.origin),
      originFree: Array.from(table.originFree.subarray(3, 6)),
      axisFree: Array.from(table.axisFree.subarray(3, 6)),
      shapes: Array.from(table.shape),
      caps: Array.from(table.shape, (shape) => shapes.caps(shape)),
      slides: Array.from(table.shape, (shape) => shapes.slides(shape)),
      freeSpans: [0, 1].map((s) => shapes.span(shapes.firstSection(freeShape) + s)),
      unreadable: table.unreadable,
    }).toEqual({
      gender: Array.from(columns.gender),
      source: Array.from(columns.source),
      status: Array.from(columns.status),
      axis: Array.from(columns.axis),
      piece: Array.from(columns.piece),
      origin: Array.from(columns.origin),
      originFree: FREE_ORIGIN,
      axisFree: FREE_AXIS,
      shapes: reinterned,
      caps: Array.from(columns.caps),
      slides: [false, true, false],
      freeSpans: [NON_DYADIC_LENGTH, 8],
      unreadable: ["generic"],
    });
  });

  it("reads an on-grid origin as its sixteenths and a free origin as recorded", () => {
    const table = ConnectorTable.fromColumns(customColumns(), new SnapShapes(), PART);
    expect(originsLdu(table)).toEqual([[10, -8, 20], FREE_ORIGIN, [1, 0.5, -1.5]]);
  });

  it("gives identical tables for the same columns under two part labels", () => {
    expect(ConnectorTable.fromColumns(customColumns(), new SnapShapes(), "a.dat")).toEqual(
      ConnectorTable.fromColumns(customColumns(), new SnapShapes(), "b.dat"),
    );
  });

  it("keeps a record of unreadable entries alone as an empty table that still carries them", () => {
    const empty = ConnectorTable.fromColumns(
      customColumns({
        count: 0,
        gender: new Uint8Array(),
        source: new Uint8Array(),
        status: new Uint8Array(),
        caps: new Uint8Array(),
        slide: new Uint8Array(),
        group: [],
        origin: new Int32Array(),
        axis: new Int8Array(),
        sectionStart: new Uint32Array(),
        sectionCount: new Uint32Array(),
        sectionCode: new Uint8Array(),
        sectionSize: new Float64Array(),
        sectionLength: new Float64Array(),
        piece: new Uint16Array(),
        freeFace: new Uint32Array(),
        freeOrigin: new Float64Array(),
        freeAxis: new Float64Array(),
        unreadable: ["closedAtBothEnds", "generic"],
      }),
      new SnapShapes(),
      PART,
    );
    expect([empty.count, empty.unreadable]).toEqual([0, ["closedAtBothEnds", "generic"]]);
  });

  it("refuses data errors and names the part", () => {
    const refusals = [
      refusal({ sectionCount: Uint32Array.of(0, 2, 1) }),
      refusal({
        sectionCode: Uint8Array.of(SECTION_CODE_PAST_THE_VOCABULARY, SECTION_AXLE, 0, 0),
      }),
      refusal({ sectionStart: Uint32Array.of(0, 1, 4) }),
      refusal({ freeFace: Uint32Array.of(0) }),
      refusal({
        freeFace: new Uint32Array(),
        freeOrigin: new Float64Array(),
        freeAxis: new Float64Array(),
      }),
      refusal({
        freeFace: Uint32Array.of(1, 1),
        freeOrigin: Float64Array.from([...FREE_ORIGIN, ...FREE_ORIGIN]),
        freeAxis: Float64Array.from([...FREE_AXIS, ...FREE_AXIS]),
      }),
    ];
    expect(refusals.map((message) => message.startsWith(`${PART}: `))).toEqual(
      refusals.map(() => true),
    );
  });
});

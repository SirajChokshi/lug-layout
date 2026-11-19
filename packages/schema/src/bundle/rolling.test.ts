import { exactRationalFromFloat64, formatExactRational } from "@brr/math";
import { describe, expect, it } from "vitest";
import { decode } from "../decode/index.ts";
import {
  PartRolling,
  RollingDiagnosticsFile,
  rollingDiagnosticsFit,
  servedUnreadBand,
  type UnreadBandDiagnostic,
  type UnreadRaw,
} from "./index.ts";

const tread = { source: "measured", axis: 2, at: [0, 0], from: -56, to: 32, radii: [336, 328] };

function rolling(surfaces: ReadonlyArray<unknown>, unread: ReadonlyArray<unknown>): unknown {
  return { stepsPerLdu: 16, surfaces, unread };
}

function diagnostics(rows: ReadonlyArray<unknown>): unknown {
  return { stepsPerLdu: 16, parts: { "ldraw:wheel": rows } };
}

function exact(value: number) {
  return formatExactRational(exactRationalFromFloat64(value));
}

function raw(from: number, to: number, radii?: readonly [number | null, number | null]): UnreadRaw {
  const ends = { from: exact(from), to: exact(to) };
  if (radii === undefined) return ends;
  const one = (radius: number | null) => (radius === null ? null : exact(radius));
  return { ...ends, radii: [one(radii[0]), one(radii[1])] };
}

const UNORIENTED: UnreadBandDiagnostic = { reason: "unoriented", raw: raw(42.426407, 52.426407) };
const CENTRE: UnreadBandDiagnostic = {
  reason: "centre",
  axis: 2,
  radii: [336, null],
  from: -96,
  raw: raw(-6, -5.003, [21, 19.97]),
};
const WIDTH: UnreadBandDiagnostic = {
  reason: "width",
  axis: 2,
  at: [0, 0],
  radii: [160, 160],
  from: -96,
  raw: raw(-6, 10.003),
};
const ARCS: UnreadBandDiagnostic = {
  reason: "arcs",
  axis: 1,
  at: [0, 0],
  radii: [320, 320],
  from: -248,
  to: -40,
  raw: raw(-15.5, -2.5, [20, 20]),
};
const ROWS: ReadonlyArray<UnreadBandDiagnostic> = [UNORIENTED, CENTRE, WIDTH, ARCS];

describe("RollingDiagnosticsFile", () => {
  it("keeps each unread row to the fields its reason identifies, with its raw measurement", () => {
    const decoded = decode(
      RollingDiagnosticsFile,
      diagnostics([
        { reason: "unoriented", raw: raw(42.426407, 52.426407) },
        {
          reason: "centre",
          axis: 2,
          radii: [336, null],
          from: -96,
          raw: raw(-6, -5.003, [21, 19.97]),
        },
        {
          reason: "radius",
          axis: 2,
          at: [0, 0],
          radii: [336, null],
          raw: raw(-6, 0, [21, 19.97]),
        },
        {
          reason: "width",
          axis: 2,
          at: [0, 0],
          radii: [160, 160],
          from: -96,
          raw: raw(-6, 10.003),
        },
        { reason: "partial", axis: 1, radii: [160, 160], raw: raw(0, 8, [10, 10]) },
        {
          reason: "arcs",
          axis: 1,
          at: [0, 0],
          radii: [320, 320],
          from: -248,
          to: -40,
          raw: raw(-15.5, -2.5, [20, 20]),
        },
      ]),
    );
    if (!decoded.ok) throw new Error(JSON.stringify(decoded.issues));
    expect(decoded.value.parts["ldraw:wheel"]?.map(servedUnreadBand)).toEqual([
      { reason: "unoriented" },
      { reason: "centre", axis: 2 },
      { reason: "radius", axis: 2 },
      { reason: "width", axis: 2 },
      { reason: "partial", axis: 1 },
      { reason: "arcs", axis: 1 },
    ]);
  });

  it.each([
    ["a part listed with no rows", diagnostics([])],
    [
      "a centre row without the axis it identified",
      diagnostics([{ reason: "centre", raw: raw(0, 8) }]),
    ],
    [
      "a radius row without its axis line",
      diagnostics([{ reason: "radius", axis: 0, radii: [null, null], raw: raw(0, 8) }]),
    ],
    [
      "a width row without the radii it identified",
      diagnostics([{ reason: "width", axis: 0, at: [0, 0], raw: raw(0, 8) }]),
    ],
    [
      "a row whose identified ends run backwards",
      diagnostics([{ reason: "partial", axis: 1, from: 8, to: 4, raw: raw(0, 8) }]),
    ],
    ["a row without its raw measurement", diagnostics([{ reason: "partial", axis: 1 }])],
    [
      "a row whose raw ends run backwards",
      diagnostics([{ reason: "partial", axis: 1, raw: raw(8, 0.5) }]),
    ],
    [
      "a raw end that isn't a reduced rational",
      diagnostics([
        {
          reason: "partial",
          axis: 1,
          raw: { from: { numerator: "2", denominator: "4" }, to: exact(8) },
        },
      ]),
    ],
  ])("refuses %s", (_case, value) => {
    expect(decode(RollingDiagnosticsFile, value).ok).toBe(false);
  });
});

describe("PartRolling", () => {
  it("serves each unread band as its reason and axis alone, and reads an older bundle's whole rows the same way", () => {
    const served = decode(PartRolling, rolling([tread], ROWS.map(servedUnreadBand)));
    const older = decode(PartRolling, rolling([tread], ROWS));
    if (!served.ok) throw new Error(JSON.stringify(served.issues));
    if (!older.ok) throw new Error(JSON.stringify(older.issues));
    const expected = [
      { reason: "unoriented" },
      { reason: "centre", axis: 2 },
      { reason: "width", axis: 2 },
      { reason: "arcs", axis: 1 },
    ];
    expect(served.value.unread).toEqual(expected);
    expect(older.value.unread).toEqual(expected);
  });

  it.each([
    ["a surface that doesn't run from below its end", rolling([{ ...tread, to: -56 }], [])],
    ["a surface on an axis that isn't x, y or z", rolling([{ ...tread, axis: 3 }], [])],
    [
      "an unread band that turns about a part axis without naming it",
      rolling([], [{ reason: "arcs" }]),
    ],
    ["an unread band on an axis that isn't x, y or z", rolling([], [{ reason: "arcs", axis: 3 }])],
    ["an unread band with no reason it can name", rolling([], [{ reason: "round", axis: 1 }])],
  ])("refuses %s", (_case, value) => {
    expect(decode(PartRolling, value).ok).toBe(false);
  });
});

describe("rollingDiagnosticsFit", () => {
  const served = ROWS.map(servedUnreadBand);

  it("matches served bands to the diagnostics rows that share their index", () => {
    expect(rollingDiagnosticsFit(served, ROWS)).toBe(true);
  });

  it.each([
    ["a row fewer", served, ROWS.slice(0, -1)],
    ["a band fewer", served.slice(1), ROWS],
    ["the rows reordered", served, [CENTRE, UNORIENTED, WIDTH, ARCS]],
    [
      "a row on another axis",
      served,
      ROWS.map((row) => (row.reason === "arcs" ? { ...row, axis: 2 as const } : row)),
    ],
  ])("refuses %s", (_case, bands, rows) => {
    expect(rollingDiagnosticsFit(bands, rows)).toBe(false);
  });
});

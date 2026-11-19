import { exactRationalFromFloat64, formatExactRational } from "@brr/math";
import { describe, expect, it } from "vitest";
import { decode } from "../decode/index.ts";
import { PartRolling } from "./index.ts";

const tread = { source: "measured", axis: 2, at: [0, 0], from: -56, to: 32, radii: [336, 328] };

function rolling(surfaces: ReadonlyArray<unknown>, unread: ReadonlyArray<unknown>): unknown {
  return { stepsPerLdu: 16, surfaces, unread };
}

function exact(value: number) {
  return formatExactRational(exactRationalFromFloat64(value));
}

function raw(from: number, to: number, radii?: [number | null, number | null]) {
  const ends = { from: exact(from), to: exact(to) };
  return radii === undefined
    ? ends
    : { ...ends, radii: radii.map((radius) => (radius === null ? null : exact(radius))) };
}

describe("PartRolling", () => {
  it("keeps each unread band to the fields its reason identifies, with its raw measurement", () => {
    const decoded = decode(
      PartRolling,
      rolling(
        [tread],
        [
          { reason: "unoriented", axis: 0, at: [0, 0], raw: raw(42.426407, 52.426407) },
          {
            reason: "centre",
            axis: 2,
            at: [0, 0],
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
        ],
      ),
    );
    if (!decoded.ok) throw new Error(JSON.stringify(decoded.issues));
    expect(decoded.value.unread).toEqual([
      { reason: "unoriented", raw: raw(42.426407, 52.426407) },
      {
        reason: "centre",
        axis: 2,
        radii: [336, null],
        from: -96,
        raw: raw(-6, -5.003, [21, 19.97]),
      },
      { reason: "radius", axis: 2, at: [0, 0], radii: [336, null], raw: raw(-6, 0, [21, 19.97]) },
      { reason: "width", axis: 2, at: [0, 0], radii: [160, 160], from: -96, raw: raw(-6, 10.003) },
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
    ]);
  });

  it.each([
    ["a surface that doesn't run from below its end", rolling([{ ...tread, to: -56 }], [])],
    ["a surface on an axis that isn't x, y or z", rolling([{ ...tread, axis: 3 }], [])],
    [
      "a centre band without the axis it identified",
      rolling([], [{ reason: "centre", raw: raw(0, 8) }]),
    ],
    [
      "a radius band without its axis line",
      rolling([], [{ reason: "radius", axis: 0, radii: [null, null], raw: raw(0, 8) }]),
    ],
    [
      "a width band without the radii it identified",
      rolling([], [{ reason: "width", axis: 0, at: [0, 0], raw: raw(0, 8) }]),
    ],
    [
      "an unread band whose identified ends run backwards",
      rolling([], [{ reason: "partial", axis: 1, from: 8, to: 4, raw: raw(0, 8) }]),
    ],
    ["an unread band without its raw measurement", rolling([], [{ reason: "partial", axis: 1 }])],
    [
      "an unread band whose raw ends run backwards",
      rolling([], [{ reason: "partial", axis: 1, raw: raw(8, 0.5) }]),
    ],
    [
      "a raw end that isn't a reduced rational",
      rolling(
        [],
        [
          {
            reason: "partial",
            axis: 1,
            raw: { from: { numerator: "2", denominator: "4" }, to: exact(8) },
          },
        ],
      ),
    ],
  ])("refuses %s", (_case, value) => {
    expect(decode(PartRolling, value).ok).toBe(false);
  });
});

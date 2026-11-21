import { describe, expect, it } from "vitest";
import { decode } from "../decode/index.ts";
import { AuthoredIdentification, authoredLinesFit } from "./index.ts";

const TEN = { numerator: "10", denominator: "1" };
const ONE_FIFTIETH_BELOW = { numerator: "-1", denominator: "50" };

function record(rows: Record<string, unknown> = {}) {
  return {
    ruleVersion: 1,
    rows: {
      line: [0, 0],
      lineKind: ["placement", "instance"],
      axis: [0, 2],
      printed: ["10.02", "0.185"],
      grid: ["whole", "unidentified"],
      identified: [TEN, null],
      residual: [ONE_FIFTIETH_BELOW, null],
      ...rows,
    },
    excludedRotated: { line: [1], lineKind: ["instance"] },
  };
}

describe("authored identification", () => {
  it("accepts equal columns where exactly the identified rows carry a value and a residual", () => {
    expect(decode(AuthoredIdentification, record()).ok).toBe(true);
  });

  it("refuses unequal columns, an identified row without a value, an unidentified row with one, and an axis outside 0..2", () => {
    expect(
      [
        record({ printed: ["10.02"] }),
        record({ identified: [null, null], residual: [null, null] }),
        record({ identified: [TEN, TEN], residual: [ONE_FIFTIETH_BELOW, ONE_FIFTIETH_BELOW] }),
        record({ residual: [null, null] }),
        record({ axis: [0, 3] }),
        { ...record(), excludedRotated: { line: [1, 2], lineKind: ["instance"] } },
      ].map((candidate) => decode(AuthoredIdentification, candidate).ok),
    ).toEqual([false, false, false, false, false, false]);
  });
});

function lines(line: number, lineKind: "instance" | "placement") {
  return { line: [line], lineKind: [lineKind] };
}

describe("authoredLinesFit", () => {
  it("accepts an instance below the instance count and a placement below the placement count, and nothing past either", () => {
    expect([
      authoredLinesFit(lines(2, "instance"), 3, 1),
      authoredLinesFit(lines(0, "placement"), 3, 1),
      authoredLinesFit(lines(3, "instance"), 3, 1),
      authoredLinesFit(lines(1, "placement"), 3, 1),
    ]).toEqual([true, true, false, false]);
  });
});

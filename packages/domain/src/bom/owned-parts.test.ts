import { describe, expect, it } from "vitest";
import { resolveLines, type Crosswalk } from "./catalog-ids.ts";
import { ownVsBuy, readOwnedPartsCsv, type OwnedParts } from "./owned-parts.ts";

const CUSTOM_BRICK = "custom:0f3a9c/my-brick.dat";

const crosswalk: Crosswalk = {
  parts: new Map([
    ["ldraw:3001", { rebrickable: "3001", bricklink: "3001" }],
    ["ldraw:3001old", { rebrickable: "3001", bricklink: "3001old" }],
    ["ldraw:3811", { rebrickable: "3811", bricklink: "3811" }],
    ["ldraw:973c01", { rebrickable: null, bricklink: "973c01" }],
    [
      "ldraw:hose",
      {
        rebrickable: "hose-assembly",
        bricklink: null,
        components: [
          { part: "ldraw:hose-end", color: 16 },
          { part: "ldraw:hose-end", color: 0 },
        ],
      },
    ],
    ["ldraw:hose-end", { rebrickable: "end", bricklink: "end" }],
  ]),
  colors: new Map([
    [0, { rebrickable: 0, bricklink: 11 }],
    [2, { rebrickable: 2, bricklink: 6 }],
    [4, { rebrickable: 4, bricklink: 5 }],
    [14, { rebrickable: 14, bricklink: 3 }],
  ]),
};

function owning(csv: string): OwnedParts {
  const read = readOwnedPartsCsv("mine.csv", csv);
  if (!read.ok) throw new Error(read.problem);
  return read.owned;
}

describe("readOwnedPartsCsv", () => {
  it("reads Part, Color and Quantity in any column order and case, sums repeated rows and lists the rows it can't read by line", () => {
    const read = readOwnedPartsCsv(
      "mine.csv",
      [
        "\uFEFFquantity,Is Spare,COLOR,Part",
        '6,False,4,"3001"',
        "",
        "2,False,4,3001",
        "five,False,2,3811",
        '1,False,14,"a ""quoted"",\rid"',
        "0,False,2,3811",
        "3,False,2.5,3811",
        "3,False,-1,3811",
        "1,False",
        "9007199254740993,False,4,3001",
      ].join("\r\n"),
    );

    expect(read).toEqual({
      ok: true,
      owned: {
        name: "mine.csv",
        parts: [
          { part: "3001", color: 4, quantity: 8 },
          { part: 'a "quoted",\rid', color: 14, quantity: 1 },
          { part: "3811", color: -1, quantity: 3 },
        ],
        total: 12,
        rejected: [
          { line: 5, text: "five,False,2,3811" },
          { line: 8, text: "0,False,2,3811" },
          { line: 9, text: "3,False,2.5,3811" },
          { line: 11, text: "1,False" },
          { line: 12, text: "9007199254740993,False,4,3001" },
        ],
      },
    });
  });

  it("refuses a file whose first row doesn't name all three columns", () => {
    expect(readOwnedPartsCsv("parts.csv", "Part,Colour,Qty\n3001,4,1\n")).toEqual({
      ok: false,
      problem: "parts.csv: the first row must name the columns Part, Color and Quantity",
    });
    expect(readOwnedPartsCsv("empty.csv", "").ok).toBe(false);
  });
});

describe("ownVsBuy", () => {
  it("takes owned parts only through the crosswalk's Rebrickable ids, line by line, buys the rest and leaves custom parts out", () => {
    const lines = resolveLines(
      [
        { part: "ldraw:3001", ldrawColor: 4, quantity: 5 },
        { part: "ldraw:3001old", ldrawColor: 4, quantity: 4 },
        { part: "ldraw:3811", ldrawColor: 2, quantity: 2 },
        { part: "ldraw:3811", ldrawColor: 72, quantity: 1 },
        { part: "ldraw:973c01", ldrawColor: 14, quantity: 1 },
        { part: "ldraw:hose", ldrawColor: 4, quantity: 2 },
        { part: CUSTOM_BRICK, ldrawColor: 4, quantity: 3 },
      ],
      crosswalk,
    );
    const owned = owning(
      [
        "Part,Color,Quantity",
        "3001,4,7",
        "ldraw:3811,2,2",
        "3811,72,1",
        "end,0,1",
        "end,4,5",
        "hose-assembly,4,2",
        "nope,4,3",
        "3811,999,1",
        "nope,999,1",
        `${CUSTOM_BRICK},4,3`,
      ].join("\n"),
    );

    const result = ownVsBuy(lines, crosswalk, owned);

    expect(
      result.lines.map((line) => [line.part, line.ldrawColor, line.quantity, line.own, line.buy]),
    ).toEqual([
      ["ldraw:3001", 4, 5, 5, 0],
      ["ldraw:3001old", 4, 4, 2, 2],
      ["ldraw:3811", 2, 2, 0, 2],
      ["ldraw:3811", 72, 1, 0, 1],
      ["ldraw:973c01", 14, 1, 0, 1],
      ["ldraw:hose-end", 4, 2, 2, 0],
      ["ldraw:hose-end", 0, 2, 1, 1],
    ]);
    expect({
      own: result.own,
      buy: result.buy,
      unmatched: result.unmatched,
      custom: result.custom,
    }).toEqual({ own: 10, buy: 7, unmatched: 2, custom: 3 });
    expect(result.unknown).toEqual([
      { part: "ldraw:3811", color: 2, quantity: 2, missing: "part" },
      { part: "3811", color: 72, quantity: 1, missing: "color" },
      { part: "nope", color: 4, quantity: 3, missing: "part" },
      { part: "3811", color: 999, quantity: 1, missing: "color" },
      { part: "nope", color: 999, quantity: 1, missing: "part-and-color" },
      { part: CUSTOM_BRICK, color: 4, quantity: 3, missing: "part" },
    ]);
    expect(result.shortfall).toEqual([
      { part: "ldraw:3001old", ldrawColor: 4, quantity: 2, expandedFrom: null },
      { part: "ldraw:3811", ldrawColor: 2, quantity: 2, expandedFrom: null },
      { part: "ldraw:3811", ldrawColor: 72, quantity: 1, expandedFrom: null },
      { part: "ldraw:973c01", ldrawColor: 14, quantity: 1, expandedFrom: null },
      { part: "ldraw:hose-end", ldrawColor: 0, quantity: 1, expandedFrom: "ldraw:hose" },
    ]);
  });
});

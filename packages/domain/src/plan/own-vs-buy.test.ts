import { describe, expect, it } from "vitest";
import type { PlanBom, PlanBomEntry } from "./buildable.ts";
import { ownVsBuy, parsePartsCsv, planFiles } from "./own-vs-buy.ts";

function entry(
  part: string,
  ldrawColor: number | null,
  quantity: number,
  rebrickable: string | null,
  rebrickableColor: number | null,
  substructure = 0,
): PlanBomEntry {
  return {
    part,
    ldrawColor,
    quantity,
    substructure,
    rebrickable: { part: rebrickable, color: rebrickableColor },
    bricklink: {
      part: rebrickable,
      color: rebrickableColor === null ? null : rebrickableColor + 100,
    },
  };
}

const BOM: PlanBom = {
  lines: [
    entry("ldraw:3001", 4, 10, "3001", 4),
    entry("ldraw:3001", null, 8, "3001", null, 8),
    entry("ldraw:3811", 2, 2, "3811", 2),
    entry("ldraw:973p1b", 15, 1, null, 15),
  ],
  placements: [],
  totalParts: 21,
};

describe("parsePartsCsv", () => {
  it("reads Part, Color, Quantity in any column order, sums repeats and reports bad rows", () => {
    const parsed = parsePartsCsv(
      "mine.csv",
      'Quantity,Part,Color\r\n6,3001,4\r\n"2","3001",4\r\nfive,3811,2\r\n3,3001,15\r\n',
    );
    expect(parsed.collection?.lines).toEqual([
      { part: "3001", color: 4, quantity: 8 },
      { part: "3001", color: 15, quantity: 3 },
    ]);
    expect(parsed.collection?.parts).toBe(11);
    expect(parsed.problems).toEqual([
      'mine.csv row 4: "five,3811,2" is not a part id, colour id and positive quantity',
    ]);
  });

  it("refuses a file without the three columns", () => {
    expect(parsePartsCsv("x.csv", "id,qty\n3001,1\n").collection).toBeNull();
  });
});

describe("ownVsBuy", () => {
  it("fills coloured lines first, then any-colour lines from what is left of the same part", () => {
    const { collection } = parsePartsCsv("mine.csv", "Part,Color,Quantity\n3001,4,13\n3001,15,3\n");
    if (!collection) throw new Error("fixture did not parse");
    const result = ownVsBuy(BOM, collection);
    expect(result.lines.map((l) => [l.entry.part, l.entry.ldrawColor, l.own, l.buy])).toEqual([
      ["ldraw:3001", 4, 10, 0],
      ["ldraw:3001", null, 6, 2],
      ["ldraw:3811", 2, 0, 2],
      ["ldraw:973p1b", 15, 0, 1],
    ]);
    expect([result.ownParts, result.buyParts]).toEqual([16, 5]);
  });
});

describe("planFiles", () => {
  it("puts only the shortfall with catalog ids and colours in the BrickLink and Rebrickable files", () => {
    const { collection } = parsePartsCsv("mine.csv", "Part,Color,Quantity\n3001,4,13\n");
    if (!collection) throw new Error("fixture did not parse");
    const files = planFiles(BOM, ownVsBuy(BOM, collection));
    expect(files.rebrickableCsv).toBe("Part,Color,Quantity\r\n3811,2,2\r\n");
    expect(files.brickLinkXml).toContain("<ITEMID>3811</ITEMID>");
    expect(files.brickLinkXml).toContain("<COLOR>102</COLOR>");
    expect(files.brickLinkXml).toContain("<MINQTY>2</MINQTY>");
    expect(files.brickLinkXml).not.toContain("<ITEMID>3001</ITEMID>");
    expect([files.anyColourParts, files.unmappedParts]).toEqual([5, 1]);
    expect(files.plainCsv.split("\r\n")[2]).toBe("ldraw:3001,,8,3,5,3001,,3001,");
  });
});
